// Scraper API function — handles ALL client-facing endpoints
//
// Routes:
//   POST /api/scrape           — Submit batch scrape (sync or queue)
//   GET  /api/status/{batchId} — Check batch status
//   GET  /api/result/{batchId}/{index} — Retrieve a result blob
//   GET  /api/list             — List recent batches
//   POST /api/trigger-build     — Trigger a preview deploy (process queue)
//   POST /api/resume           — Resume incomplete batches
//
// With these endpoints, NO CLI or PAT is needed for the full client flow:
//   1. POST /api/scrape?queue=true  → submits batch (returns batch_id)
//   2. POST /api/trigger-build      → processes queue
//   3. GET /api/status/{batchId}    → poll until complete
//   4. GET /api/result/{batchId}/0  → retrieve result
//
// See PROTOCOL.md for full spec.

import {
  STORE_NAME, INLINE_BODY_MAX, MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY_FUNCTION, MAX_JOBS_SYNC_BATCH, MAX_JOBS_QUEUE_BATCH,
  FUNCTION_HARD_TIMEOUT_MS, VALID_RESULT_MODES, VALID_ENGINES,
  TLS_PROFILES, resolveTlsProfile,
  validateBatchRequest, getStore, setBatchStatus, enqueueBatch,
  fetchWithUndici, fetchWithTlsImpersonate, processBatch, computeBatchStatus,
  resultsSummary, safeUrlForLog, resumeIncompleteBatches,
} from '../lib/scraper.mjs';

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

// Engine dispatcher (function mode — no puppeteer)
async function fetchEngine(job) {
  const engine = job.engine || 'fetch';
  const timeoutMs = Math.min(job.timeout_ms || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  if (engine === 'fetch') {
    return fetchWithUndici(job, timeoutMs);
  }
  if (engine === 'chrome_impersonate') {
    const imp = await getTlsImpersonate();
    if (!imp) throw new Error('tls-impersonate not available');
    return fetchWithTlsImpersonate(job, timeoutMs, imp);
  }
  if (engine === 'puppeteer') {
    throw new Error('puppeteer engine is only available in build mode. Set queue=true.');
  }
  throw new Error(`unknown engine: ${engine}`);
}

// === Auth helper ===

function checkAuth(req) {
  const apiKey = process.env.SCRAPE_API_KEY;
  if (!apiKey) return null; // No protection enabled
  const authHeader = req.headers.get('authorization') || '';
  const xApiKey = req.headers.get('x-api-key') || '';
  const providedKey = authHeader.replace(/^Bearer\s+/i, '') || xApiKey;
  if (providedKey !== apiKey) {
    return Response.json({
      error: 'unauthorized',
      hint: 'Provide your API key via Authorization: Bearer <key> or X-Api-Key: <key> header',
    }, { status: 401 });
  }
  return null; // Auth passed
}

// === Route handler ===

export default async function handler(req, context) {
  // Auth check (applies to all routes)
  const authError = checkAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // === POST /api/scrape — Submit batch scrape ===
  if (method === 'POST' && (path === '/api/scrape' || path === '/.netlify/functions/scrape')) {
    return handleScrape(req, url);
  }

  // === GET /api/status/{batchId} — Check batch status ===
  if (method === 'GET' && path.startsWith('/api/status/')) {
    const batchId = path.replace('/api/status/', '');
    return handleStatus(batchId);
  }

  // === GET /api/result/{batchId}/{index} — Retrieve result metadata (or raw bytes with ?passthrough=1) ===
  if (method === 'GET' && path.startsWith('/api/result/')) {
    const parts = path.replace('/api/result/', '').split('/');
    if (parts.length !== 2) {
      return Response.json({ error: 'path must be /api/result/{batchId}/{index}' }, { status: 400 });
    }
    const [batchId, indexStr] = parts;
    const index = parseInt(indexStr, 10);
    if (!Number.isFinite(index) || index < 0) {
      return Response.json({ error: 'index must be a non-negative integer' }, { status: 400 });
    }
    const passthrough = url.searchParams.get('passthrough') === '1';
    return handleResult(batchId, index, passthrough);
  }

  // === GET /api/list — List recent batches ===
  if (method === 'GET' && (path === '/api/list' || path === '/api/list/')) {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const statusFilter = url.searchParams.get('status');
    return handleList(limit, statusFilter);
  }

  // === POST /api/trigger-build — Trigger a preview deploy (process queue) ===
  if (method === 'POST' && (path === '/api/trigger-build' || path === '/.netlify/functions/trigger-build')) {
    return handleTriggerBuild();
  }

  // === POST /api/resume — Resume incomplete batches ===
  if (method === 'POST' && (path === '/api/resume' || path === '/.netlify/functions/resume')) {
    return handleResume();
  }

  // === Help / 404 ===
  return Response.json({
    error: 'not found',
    routes: {
      'POST /api/scrape': 'Submit batch scrape (sync or queue). Body: { jobs: [...], queue, result_mode, ... }',
      'GET /api/status/{batchId}': 'Check batch status',
      'GET /api/result/{batchId}/{index}': 'Retrieve a result blob',
      'GET /api/list[?status=...&limit=20]': 'List recent batches',
      'POST /api/trigger-build': 'Trigger a preview deploy to process the queue',
      'POST /api/resume': 'Resume incomplete batches (crash recovery)',
    },
    engines: VALID_ENGINES,
    tls_profiles: Object.keys(TLS_PROFILES),
    result_modes: VALID_RESULT_MODES,
    limits: {
      sync_max_jobs: MAX_JOBS_SYNC_BATCH,
      queue_max_jobs: MAX_JOBS_QUEUE_BATCH,
      max_concurrency: MAX_CONCURRENCY_FUNCTION,
      max_timeout_ms: DEFAULT_TIMEOUT_MS,
    },
  }, { status: 404 });
}

// === Route implementations ===

async function handleScrape(req, url) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const validationError = validateBatchRequest(body);
  if (validationError) {
    return Response.json({
      error: validationError.error,
      ...(validationError.job_url ? { job_url: validationError.job_url } : {}),
      valid_engines: VALID_ENGINES,
      valid_tls_profiles: Object.keys(TLS_PROFILES),
      valid_result_modes: VALID_RESULT_MODES,
      limits: {
        sync_max_jobs: MAX_JOBS_SYNC_BATCH,
        queue_max_jobs: MAX_JOBS_QUEUE_BATCH,
        max_concurrency: MAX_CONCURRENCY_FUNCTION,
        max_timeout_ms: DEFAULT_TIMEOUT_MS,
      },
    }, { status: 400 });
  }

  const { jobs, delay_ms, concurrency, result_mode, queue } = body;
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const createdAt = new Date().toISOString();

  // Queue mode
  if (queue) {
    const batchSpec = {
      batch_id: batchId,
      jobs,
      options: { delay_ms, concurrency, result_mode: result_mode || 'blob' },
      created_at: createdAt,
      queued_at: createdAt,
    };
    try {
      await enqueueBatch(batchId, batchSpec);
      await setBatchStatus(batchId, 'pending', {
        job_count: jobs.length,
        options: batchSpec.options,
        created_at: createdAt,
      });
    } catch (e) {
      try { await (await getStore()).delete(`queue/pending/${batchId}`); } catch {}
      return Response.json({ error: `failed to queue batch: ${e.message}` }, { status: 500 });
    }
    console.log(`BATCH_QUEUED batch_id=${batchId} jobs=${jobs.length}`);
    return Response.json({
      batch_id: batchId,
      status: 'pending',
      job_count: jobs.length,
      message: 'Batch queued. Call POST /api/trigger-build to process, then GET /api/status/{batch_id} to poll.',
      status_url: `/api/status/${batchId}`,
      result_url: `/api/result/${batchId}/0`,
      trigger_build_url: '/api/trigger-build',
    }, { status: 202, headers: { 'x-batch-id': batchId } });
  }

  // Sync mode — process inline
  const batchStartMs = Date.now();
  await setBatchStatus(batchId, 'running', {
    job_count: jobs.length,
    options: { delay_ms, concurrency, result_mode: result_mode || 'blob' },
    created_at: createdAt,
    started_at: new Date().toISOString(),
  });
  console.log(`BATCH_START batch_id=${batchId} jobs=${jobs.length} concurrency=${concurrency || 1} result_mode=${result_mode || 'blob'}`);

  const results = await processBatch(
    batchId, jobs,
    { delay_ms, concurrency, result_mode: result_mode || 'blob' },
    batchStartMs, FUNCTION_HARD_TIMEOUT_MS, MAX_CONCURRENCY_FUNCTION, fetchEngine
  );

  const elapsedMs = Date.now() - batchStartMs;
  const { succeeded, failed, skipped, status } = computeBatchStatus(results);

  await setBatchStatus(batchId, status, {
    job_count: jobs.length,
    succeeded,
    failed,
    skipped,
    elapsed_ms: elapsedMs,
    completed_at: new Date().toISOString(),
    options: { delay_ms, concurrency, result_mode: result_mode || 'blob' },
    results: resultsSummary(results),
  });

  console.log(`BATCH_COMPLETE batch_id=${batchId} status=${status} succeeded=${succeeded} failed=${failed} skipped=${skipped} ms=${elapsedMs}`);

  return Response.json({
    batch_id: batchId,
    status,
    processed: succeeded + failed,
    succeeded,
    failed,
    skipped,
    elapsed_ms: elapsedMs,
    results,
  }, { headers: { 'x-batch-id': batchId, 'x-status': status } });
}

async function handleStatus(batchId) {
  const store = await getStore();
  try {
    const status = await store.get(`status/${batchId}`, { type: 'json' });
    if (!status) {
      return Response.json({ error: 'batch not found', batch_id: batchId }, { status: 404 });
    }
    return Response.json(status, { headers: { 'x-batch-id': batchId, 'x-status': status.status } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function handleResult(batchId, index, passthrough = false) {
  const store = await getStore();
  const blobKey = `result/${batchId}-${index}`;
  try {
    // Check if batch is complete first
    const status = await store.get(`status/${batchId}`, { type: 'json' });
    if (status && status.status !== 'complete' && status.status !== 'partial') {
      return Response.json({
        error: 'result not available',
        batch_id: batchId,
        status: status.status,
        hint: `Check /api/status/${batchId} for current status`,
      }, { status: 409 });
    }

    const metadata = await store.getMetadata(blobKey);
    if (!metadata) {
      return Response.json({ error: 'result blob not found', batch_id: batchId, index }, { status: 404 });
    }

    // If passthrough=1, return raw bytes (costs bandwidth credits — 20 cr/GB)
    if (passthrough) {
      const blob = await store.get(blobKey, { type: 'arrayBuffer' });
      return new Response(blob, {
        headers: {
          'content-type': metadata.content_type || 'application/octet-stream',
          'x-batch-id': batchId,
          'x-result-index': String(index),
          'x-original-size': String(metadata.size || 0),
        },
      });
    }

    // Default: return metadata + blob URL (NOT the bytes — saves bandwidth)
    // Clients use the blob_url to fetch data directly (free via Blobs API with PAT)
    const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || '';
    const blobApiUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/site:${STORE_NAME}/${blobKey}`;

    return Response.json({
      batch_id: batchId,
      index,
      blob_key: blobKey,
      size: parseInt(metadata.size || '0'),
      content_type: metadata.content_type || 'application/octet-stream',
      stored_at: metadata.stored_at || '',
      blob_url: blobApiUrl,
      // Hint: fetching blob_url requires Authorization: Bearer <NETLIFY_PAT>
      // Or use passthrough_url to proxy through function (costs bandwidth)
      passthrough_url: `/api/result/${batchId}/${index}?passthrough=1`,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function handleList(limit = 20, statusFilter = null) {
  const store = await getStore();
  const list = await store.list({ prefix: 'status/' });
  const statusBlobs = (list.blobs || [])
    .sort((a, b) => (b.last_modified || '').localeCompare(a.last_modified || ''))
    .slice(0, limit);

  // Fetch statuses in parallel (bounded)
  const batchSize = 5;
  const batches = [];
  for (let i = 0; i < statusBlobs.length; i += batchSize) {
    const chunk = statusBlobs.slice(i, i + batchSize);
    const promises = chunk.map(async (b) => {
      const s = await store.get(b.key, { type: 'json' });
      if (s && (!statusFilter || s.status === statusFilter)) return s;
      return null;
    });
    const results = await Promise.all(promises);
    for (const s of results) {
      if (s) batches.push(s);
    }
  }

  return Response.json({
    count: batches.length,
    batches: batches.map(s => ({
      batch_id: s.batch_id,
      status: s.status,
      job_count: s.job_count,
      succeeded: s.succeeded,
      failed: s.failed,
      skipped: s.skipped || 0,
      elapsed_ms: s.elapsed_ms,
      updated_at: s.updated_at,
      status_url: `/api/status/${s.batch_id}`,
    })),
  });
}

async function handleTriggerBuild() {
  // Trigger a preview deploy via the Netlify API — WITH actual file content
  // so Netlify actually runs the build process (not just a CDN upload).
  //
  // Strategy: Write a small "trigger file" (queue manifest) into the deploy.
  // This forces Netlify to see file changes and run the build, which executes
  // the process-queue plugin in onPostBuild.
  //
  // Requires NETLIFY_AUTH_TOKEN + SITE_ID env vars on the function.

  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;

  if (!token || !siteId) {
    return Response.json({
      error: 'build trigger not configured',
      hint: 'Set NETLIFY_AUTH_TOKEN and SITE_ID env vars on the function to enable build triggering',
      alternative: 'Use `netlify deploy` CLI or Git push to trigger a build',
    }, { status: 501 });
  }

  try {
    // Step 1: Count pending batches so we can include that in the trigger file
    const store = await getStore();
    const pendingList = await store.list({ prefix: 'queue/pending/' });
    const pendingCount = pendingList.blobs?.length || 0;

    if (pendingCount === 0) {
      return Response.json({
        ok: true,
        message: 'No pending batches in the queue. Nothing to process.',
        pending_count: 0,
      });
    }

    // Step 2: Create a trigger file with unique content (forces build to see changes)
    const triggerContent = JSON.stringify({
      triggered_at: new Date().toISOString(),
      pending_batches: pendingCount,
      trigger_id: `trigger-${Date.now()}`,
    }, null, 2);

    // Compute SHA1 of the trigger file content
    const encoder = new TextEncoder();
    const data = encoder.encode(triggerContent);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const sha1 = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Step 3: Create a draft deploy with the trigger file
    const createResp = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        draft: true,
        title: `queue-trigger-${Date.now()}`,
        files: {
          '/queue-trigger.json': sha1,
        },
      }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      return Response.json({
        error: `Failed to create deploy: HTTP ${createResp.status}`,
        details: errText,
      }, { status: 502 });
    }

    const deploy = await createResp.json();
    const deployId = deploy.id;

    // Step 4: Upload the trigger file via the presigned URL pattern
    const uploadResp = await fetch(
      `https://api.netlify.com/api/v1/deploys/${deployId}/files/queue-trigger.json`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: triggerContent,
      }
    );

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return Response.json({
        error: `Failed to upload trigger file: HTTP ${uploadResp.status}`,
        details: errText,
        deploy_id: deployId,
      }, { status: 502 });
    }

    console.log(`BUILD_TRIGGERED deploy_id=${deployId} pending=${pendingCount}`);

    return Response.json({
      ok: true,
      message: `Build triggered with ${pendingCount} pending batch(es). The build process will run the queue plugin.`,
      deploy_id: deployId,
      deploy_url: deploy.deploy_ssl_url,
      pending_count: pendingCount,
      trigger_file: 'queue-trigger.json',
      // Client should poll deploy status via the Netlify API, then check /api/list
      status_url: '/api/list?status=pending',
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function handleResume() {
  try {
    const result = await resumeIncompleteBatches();
    return Response.json({
      ok: true,
      total_checked: result.total_checked,
      requeued: result.requeued,
      orphaned: result.orphaned,
      message: result.requeued.length > 0
        ? `${result.requeued.length} batch(es) requeued. Call POST /api/trigger-build to process them.`
        : 'No incomplete batches found.',
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export const config = {
  path: [
    '/api/scrape',
    '/api/status/*',
    '/api/result/*',
    '/api/list',
    '/api/list/',
    '/api/trigger-build',
    '/api/resume',
    '/.netlify/functions/scrape',
  ],
};
