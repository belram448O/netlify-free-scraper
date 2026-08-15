// Batch scraper function — processes multiple URLs in one invocation
//
// Uses shared lib at ../lib/scraper.mjs for all common logic.
// See PROTOCOL.md for full spec.

import {
  STORE_NAME, INLINE_BODY_MAX, MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY_FUNCTION, MAX_JOBS_SYNC_BATCH, MAX_JOBS_QUEUE_BATCH,
  FUNCTION_HARD_TIMEOUT_MS, VALID_RESULT_MODES,
  validateBatchRequest, getStore, setBatchStatus, enqueueBatch,
  fetchWithUndici, fetchWithTlsImpersonate, processBatch, computeBatchStatus,
  resultsSummary, safeUrlForLog,
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

export default async function handler(req, context) {
  // PAT protection — since blob reads require a PAT anyway, require it on the API too
  // to prevent anonymous abuse of compute credits.
  // Set SCRAPE_API_KEY env var in Netlify dashboard to enable. If not set, API is open.
  // The key can be the same as your Netlify PAT (nfp_...) or a custom shared secret.
  const apiKey = process.env.SCRAPE_API_KEY;
  if (apiKey) {
    const authHeader = req.headers.get('authorization') || '';
    const xApiKey = req.headers.get('x-api-key') || '';
    const providedKey = authHeader.replace(/^Bearer\s+/i, '') || xApiKey;
    if (providedKey !== apiKey) {
      return Response.json({
        error: 'unauthorized',
        hint: 'Provide your API key via Authorization: Bearer <key> or X-Api-Key: <key> header',
      }, { status: 401 });
    }
  }

  if (req.method !== 'POST') {
    return Response.json({
      error: 'method not allowed',
      usage: 'POST /api/scrape with JSON body: { jobs: [...], delay_ms, concurrency, result_mode, queue }',
      spec: 'See PROTOCOL.md for full job spec',
    }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Validate (mutates body.jobs to default engine to 'fetch')
  const validationError = validateBatchRequest(body);
  if (validationError) {
    return Response.json({
      error: validationError.error,
      ...(validationError.job_url ? { job_url: validationError.job_url } : {}),
      valid_engines: ['fetch', 'chrome_impersonate', 'puppeteer (queue mode only)'],
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
    // Write queue entry first (so no orphan status if function dies between)
    try {
      await enqueueBatch(batchId, batchSpec);
      await setBatchStatus(batchId, 'pending', {
        job_count: jobs.length,
        options: batchSpec.options,
        created_at: createdAt,
      });
    } catch (e) {
      // Rollback queue entry if status write failed
      try { await (await getStore()).delete(`queue/pending/${batchId}`); } catch {}
      return Response.json({ error: `failed to queue batch: ${e.message}` }, { status: 500 });
    }
    console.log(`BATCH_QUEUED batch_id=${batchId} jobs=${jobs.length}`);
    return Response.json({
      batch_id: batchId,
      status: 'pending',
      job_count: jobs.length,
      message: 'Batch queued. Build plugin will process on next preview deploy. Poll status via Blobs API.',
      poll_hint: `GET https://api.netlify.com/api/v1/blobs/{site_id}/site:${STORE_NAME}/status/${batchId}`,
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

export const config = {
  path: ['/api/scrape', '/.netlify/functions/scrape'],
};
