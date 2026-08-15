// Queue processor build plugin — processes long-running batch jobs
//
// Uses shared lib at ../../lib/scraper.mjs for common logic.
// Adds puppeteer engine support (build-only).

import {
  BUILD_TIMEOUT_MS, PER_JOB_TIMEOUT_MS_DEFAULT, MAX_CONCURRENCY_BUILD,
  STALE_RUNNING_MS, DEFAULT_TIMEOUT_MS,
  validateUrl, safeUrlForLog,
  getStore, setBatchStatus, dequeueBatch, enqueueBatch,
  fetchWithUndici, fetchWithTlsImpersonate, processBatch, computeBatchStatus,
  resultsSummary, withTimeout, storeResult,
  resumeIncompleteBatches,
} from '../../lib/scraper.mjs';

// === Puppeteer engine (build-only) ===

let puppeteerCache = null;

async function getPuppeteer() {
  if (puppeteerCache !== null) return puppeteerCache;
  let chromium, puppeteer;
  try {
    chromium = (await import('@sparticuz/chromium')).default;
  } catch {
    throw new Error('@sparticuz/chromium not installed. Add it to the root package.json dependencies: npm install @sparticuz/chromium puppeteer-core');
  }
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('puppeteer-core not installed. Add it to the root package.json dependencies.');
  }
  puppeteerCache = { chromium, puppeteer };
  return puppeteerCache;
}

async function fetchWithPuppeteer(job, timeoutMs) {
  const { chromium, puppeteer } = await getPuppeteer();
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    if (job.user_agent) await page.setUserAgent(job.user_agent);
    if (job.headers) await page.setExtraHTTPHeaders(job.headers);

    // Capture HTTPResponse to get real status
    const response = await withTimeout(
      page.goto(job.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' }),
      timeoutMs,
      'page.goto timeout'
    );
    const upstreamStatus = response?.status() ?? 0;
    const upstreamOk = response?.ok() ?? false;

    // Wait for selector or timeout
    if (job.wait_for) {
      if (typeof job.wait_for === 'string') {
        await withTimeout(page.waitForSelector(job.wait_for), timeoutMs, 'wait_for selector timeout');
      } else if (job.wait_for.type === 'timeout') {
        const ms = Math.min(job.wait_for.ms || 1000, timeoutMs);
        await new Promise(r => setTimeout(r, ms));
      } else if (job.wait_for.type === 'selector') {
        await withTimeout(page.waitForSelector(job.wait_for.selector), timeoutMs, 'wait_for selector timeout');
      } else if (job.wait_for.type === 'networkidle') {
        await withTimeout(page.waitForNetworkIdle(), timeoutMs, 'wait_for networkidle timeout');
      }
    }

    // Execute actions (all wrapped in timeout)
    if (Array.isArray(job.actions)) {
      for (const action of job.actions) {
        if (action.type === 'click') {
          await withTimeout(page.click(action.selector), timeoutMs, `click ${action.selector} timeout`);
        } else if (action.type === 'wait') {
          const ms = Math.min(action.ms || 500, timeoutMs);
          await new Promise(r => setTimeout(r, ms));
        } else if (action.type === 'type') {
          await withTimeout(page.type(action.selector, action.text || ''), timeoutMs, `type ${action.selector} timeout`);
        } else if (action.type === 'scroll') {
          await withTimeout(page.evaluate((x, y) => window.scrollBy(x, y), action.x || 0, action.y || 1000), timeoutMs, 'scroll timeout');
        } else if (action.type === 'wait_for_selector') {
          await withTimeout(page.waitForSelector(action.selector), timeoutMs, `wait_for_selector ${action.selector} timeout`);
        }
      }
    }

    // Get final HTML and metadata
    const html = await withTimeout(page.content(), timeoutMs, 'page.content() timeout');
    const finalUrl = page.url();
    const title = await withTimeout(page.title(), timeoutMs, 'page.title() timeout').catch(() => null);

    // Capture screenshot if requested — store as separate blob
    let screenshotBlobKey = null;
    let screenshotBytes = 0;
    if (job.screenshot) {
      const screenshot = await withTimeout(
        page.screenshot({ type: 'png', fullPage: !!job.screenshot_full }),
        timeoutMs,
        'screenshot timeout'
      ).catch(() => null);
      if (screenshot) {
        screenshotBytes = screenshot.length;
        // Store screenshot as a separate blob (with .png suffix for easy retrieval)
        const screenshotKey = `screenshot/${job._batch_id}-${job._index}`;
        const store = await getStore();
        await store.set(screenshotKey, screenshot, {
          metadata: {
            content_type: 'image/png',
            size: String(screenshotBytes),
            stored_at: new Date().toISOString(),
            url: safeUrlForLog(job.url),
          },
        });
        screenshotBlobKey = screenshotKey;
      }
    }

    return {
      ok: upstreamOk,
      status: upstreamStatus,
      body: Buffer.from(html, 'utf8'),
      content_type: 'text/html',
      headers: {},
      redirected: finalUrl !== job.url,
      final_url: finalUrl,
      puppeteer: {
        title,
        screenshot_bytes: screenshotBytes,
        screenshot_blob_key: screenshotBlobKey,
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// === Engine dispatcher (build mode — supports all 3 engines) ===

let tlsImpersonateModule = null;
async function getTlsImpersonate() {
  if (tlsImpersonateModule !== null) return tlsImpersonateModule;
  try {
    tlsImpersonateModule = await import('tls-impersonate');
  } catch (e) {
    tlsImpersonateModule = false;
  }
  return tlsImpersonateModule;
}

async function fetchEngine(job) {
  const engine = job.engine || 'fetch';
  const timeoutMs = Math.min(job.timeout_ms || PER_JOB_TIMEOUT_MS_DEFAULT, PER_JOB_TIMEOUT_MS_DEFAULT);

  if (engine === 'fetch') {
    return fetchWithUndici(job, timeoutMs);
  }
  if (engine === 'chrome_impersonate') {
    const imp = await getTlsImpersonate();
    if (!imp) throw new Error('tls-impersonate not available');
    return fetchWithTlsImpersonate(job, timeoutMs, imp);
  }
  if (engine === 'puppeteer') {
    return fetchWithPuppeteer(job, timeoutMs);
  }
  throw new Error(`unknown engine: ${engine}`);
}

// === List and partition batches ===

async function listAndPartitionBatches() {
  const store = await getStore();
  // Use prefix-scoped list calls to avoid fetching all blobs
  const [pendingList, statusList] = await Promise.all([
    store.list({ prefix: 'queue/pending/' }),
    store.list({ prefix: 'status/' }),
  ]);
  const pendingBatches = [];
  for (const b of (pendingList.blobs || [])) {
    try {
      const spec = await store.get(b.key, { type: 'json' });
      if (spec) pendingBatches.push({ spec, key: b.key });
    } catch {}
  }
  const staleRunning = [];
  const now = Date.now();
  for (const b of (statusList.blobs || [])) {
    if (!b.last_modified) continue;
    try {
      const s = await store.get(b.key, { type: 'json' });
      if (s && s.status === 'running' && s.updated_at) {
        const updatedMs = new Date(s.updated_at).getTime();
        if (now - updatedMs > STALE_RUNNING_MS) {
          staleRunning.push({ status: s, key: b.key });
        }
      }
    } catch {}
  }
  pendingBatches.sort((a, b) => (a.spec.created_at || '').localeCompare(b.spec.created_at || ''));
  return { pendingBatches, staleRunning };
}

// === Process batch (wraps shared processBatch with build-specific status) ===

async function processBatchBuild(batchSpec, buildStartMs) {
  const { batch_id, jobs, options } = batchSpec;
  const batchStartMs = Date.now();

  await setBatchStatus(batch_id, 'running', {
    job_count: jobs.length,
    options,
    started_at: new Date().toISOString(),
  });
  console.log(`BATCH_START batch_id=${batch_id} jobs=${jobs.length} concurrency=${options.concurrency || 1} result_mode=${options.result_mode || 'blob'}`);

  // Inject _batch_id and _index into each job so puppeteer can use them for screenshot keys
  jobs.forEach((job, i) => {
    job._batch_id = batch_id;
    job._index = i;
  });

  const results = await processBatch(
    batch_id, jobs, options,
    buildStartMs, BUILD_TIMEOUT_MS, MAX_CONCURRENCY_BUILD, fetchEngine
  );

  const elapsedMs = Date.now() - batchStartMs;
  const { succeeded, failed, skipped, status } = computeBatchStatus(results);

  // If we have skipped jobs (timeout), re-enqueue them as a new batch
  let requeuedCount = 0;
  const skippedJobs = results
    .filter(r => r.error?.startsWith('skipped'))
    .map(r => jobs[r.index]);
  if (skippedJobs.length > 0 && skippedJobs.length < jobs.length) {
    // Some jobs skipped — create a new batch for them
    const newBatchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const newSpec = {
      batch_id: newBatchId,
      jobs: skippedJobs,
      options,
      created_at: new Date().toISOString(),
      requeued_from: batch_id,
    };
    try {
      await enqueueBatch(newBatchId, newSpec);
      await setBatchStatus(newBatchId, 'pending', {
        job_count: skippedJobs.length,
        options,
        created_at: newSpec.created_at,
        requeued_from: batch_id,
      });
      requeuedCount = skippedJobs.length;
      console.log(`BATCH_REQUEUE batch_id=${newBatchId} jobs=${skippedJobs.length} from=${batch_id}`);
    } catch (e) {
      console.error(`Failed to requeue ${skippedJobs.length} skipped jobs: ${e.message}`);
    }
  }

  // Write terminal status FIRST, then dequeue — so if build crashes between,
  // the batch has terminal status but queue entry still exists → next build
  // sees it in pendingBatches and reprocesses (idempotent — overwrites results)
  await setBatchStatus(batch_id, status, {
    job_count: jobs.length,
    succeeded,
    failed,
    skipped,
    requeued: requeuedCount,
    elapsed_ms: elapsedMs,
    completed_at: new Date().toISOString(),
    options,
    results: resultsSummary(results),
  });

  await dequeueBatch(batch_id);

  console.log(`BATCH_COMPLETE batch_id=${batch_id} status=${status} succeeded=${succeeded} failed=${failed} skipped=${skipped} requeued=${requeuedCount} ms=${elapsedMs}`);
  return { batch_id, status, succeeded, failed, skipped, requeued: requeuedCount };
}

// === Plugin entry point ===

export default {
  onPostBuild: async () => {
    const buildStart = Date.now();
    console.log(`\n========== PROCESS_QUEUE_PLUGIN started ${new Date().toISOString()} ==========`);

    // === Resume incomplete batches (crash recovery) ===
    console.log(`\n  Checking for incomplete batches to resume...`);
    const resumeResult = await resumeIncompleteBatches();
    if (resumeResult.requeued.length > 0) {
      console.log(`  Requeued ${resumeResult.requeued.length} batch(es):`);
      for (const r of resumeResult.requeued) {
        console.log(`    - ${r.batch_id} (reason: ${r.reason}, age: ${Math.round(r.age_ms / 1000)}s)`);
      }
    }
    if (resumeResult.orphaned.length > 0) {
      console.log(`  Marked ${resumeResult.orphaned.length} orphaned batch(es) as error (job specs lost)`);
    }
    if (resumeResult.requeued.length === 0 && resumeResult.orphaned.length === 0) {
      console.log(`  No incomplete batches found.`);
    }

    // === List and process pending batches ===
    const { pendingBatches } = await listAndPartitionBatches();

    if (pendingBatches.length === 0) {
      console.log(`\n  No pending batches in queue. Done.`);
      console.log(`\n========== PROCESS_QUEUE_PLUGIN_END (empty) ==========\n`);
      return;
    }

    console.log(`\n  Found ${pendingBatches.length} pending batch(es). Processing...`);

    let processed = 0;
    let succeededBatches = 0;
    let failedBatches = 0;
    for (const { spec } of pendingBatches) {
      if (Date.now() - buildStart > BUILD_TIMEOUT_MS - 60_000) {
        console.log(`\n  Approaching build timeout. ${pendingBatches.length - processed} batch(es) remaining (will be picked up next build).`);
        break;
      }
      console.log(`\n  Processing batch ${processed + 1}/${pendingBatches.length}: ${spec.batch_id}`);
      try {
        const result = await processBatchBuild(spec, buildStart);
        processed++;
        if (result.status === 'complete' || result.status === 'partial') succeededBatches++;
        else failedBatches++;
      } catch (e) {
        console.error(`  Batch ${spec.batch_id} failed: ${e.message}`);
        await setBatchStatus(spec.batch_id, 'error', { error: e.message, failed_at: new Date().toISOString() });
        await dequeueBatch(spec.batch_id);
        failedBatches++;
        processed++;
      }
    }

    const totalMs = Date.now() - buildStart;
    console.log(`\n========== PROCESS_QUEUE_PLUGIN_END ==========`);
    console.log(`  Processed: ${processed} | Succeeded: ${succeededBatches} | Failed: ${failedBatches}`);
    console.log(`  Total time: ${totalMs}ms`);
    console.log();
  },
};
