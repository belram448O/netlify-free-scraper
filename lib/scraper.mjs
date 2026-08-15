// Shared library — used by both functions/scrape.mjs and plugins/process-queue/index.js
// Prevents code drift between the two implementations.

import tls from 'node:tls';

// === Constants ===

export const STORE_NAME = 'scraper-results';
export const INLINE_BODY_MAX = 32 * 1024;  // 32 KB
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;  // 50 MB
export const DEFAULT_TIMEOUT_MS = 25_000;  // Must be < FUNCTION_HARD_TIMEOUT_MS (28s) to leave time for status write
export const MAX_CONCURRENCY_FUNCTION = 5;
export const MAX_CONCURRENCY_BUILD = 10;
export const MAX_JOBS_SYNC_BATCH = 50;
export const MAX_JOBS_QUEUE_BATCH = 500;
export const FUNCTION_HARD_TIMEOUT_MS = 28_000;
export const BUILD_TIMEOUT_MS = 14 * 60 * 1000;
export const PER_JOB_TIMEOUT_MS_DEFAULT = 60_000;
export const STALE_RUNNING_MS = 10 * 60 * 1000;
export const VALID_RESULT_MODES = ['blob', 'inline', 'metadata', 'auto'];
export const VALID_ENGINES = ['fetch', 'chrome_impersonate', 'puppeteer'];

export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Chrome 120 ClientHello spec
export const CHROME_120_SPEC = {
  cipherSuites: [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035],
  extensions: [
    { type: 0x0016 }, { type: 0x000b }, { type: 0xff01 }, { type: 0x0000 },
    { type: 0x0017 }, { type: 0x000d }, { type: 0x000a }, { type: 0x0023 },
    { type: 0x0010, alpnProtocols: ['h2', 'http/1.1'] }, { type: 0x002b },
    { type: 0x002d }, { type: 0x0033 }, { type: 0x001c }, { type: 0x0015 },
  ],
  supportedGroups: [0x001d, 0x0017, 0x0018],
  signatureAlgorithms: [0x0403, 0x0804, 0x0401, 0x0503, 0x0501, 0x0803, 0x0601, 0x0201],
  alpnProtocols: ['h2', 'http/1.1'],
};

// === SSRF protection ===

const PRIVATE_IPV4_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^169\.254\./,
  /^0\./, /^100\.6[4-9]\./, /^100\.[7-9]\./, /^100\.[1-9][0-9]\./, /^100\.1[01][0-9]\./, /^100\.12[0-7]\./,
];

const PRIVATE_IPV6_PATTERNS = [
  /^fc[0-9a-f]{2}:/i,      // ULA fc00::/7
  /^fd[0-9a-f]{2}:/i,      // ULA fd00::/8
  /^fe[89ab][0-9a-f]:/i,   // link-local fe80::/10
  /^::ffff:127\./i,        // v4-mapped loopback
  /^::ffff:10\./i,         // v4-mapped private
  /^::ffff:192\.168\./i,   // v4-mapped private
  /^::ffff:172\.(1[6-9]|2[0-9]|3[01])\./i,  // v4-mapped private
  /^::ffff:169\.254\./i,   // v4-mapped link-local
  /^2001:db8:/i,           // documentation
];

export function validateUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { throw new Error(`invalid URL: ${urlStr}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`URL must be http or https, got: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');  // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    throw new Error(`URL hostname '${host}' is not allowed`);
  }
  // IPv4 check
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    for (const pattern of PRIVATE_IPV4_PATTERNS) {
      if (pattern.test(host)) throw new Error(`URL points to private IP: ${host}`);
    }
  }
  // IPv6 check
  if (host.includes(':')) {
    for (const pattern of PRIVATE_IPV6_PATTERNS) {
      if (pattern.test(host)) throw new Error(`URL points to private IPv6: ${host}`);
    }
  }
  return parsed;
}

export function safeUrlForLog(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.search) return `${u.origin}${u.pathname}?[redacted]`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

// === Input validation ===

export function validateBatchRequest(body) {
  const { jobs, delay_ms, concurrency, result_mode, queue } = body;

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { error: 'jobs must be a non-empty array' };
  }

  // Validate job count
  const maxJobs = queue ? MAX_JOBS_QUEUE_BATCH : MAX_JOBS_SYNC_BATCH;
  if (jobs.length > maxJobs) {
    return { error: `too many jobs (${jobs.length}). Max ${maxJobs} in ${queue ? 'queue' : 'sync'} mode.` };
  }

  // Validate each job
  for (let i = 0; i < jobs.length; i++) {
    if (!jobs[i] || typeof jobs[i] !== 'object') {
      return { error: `job ${i} must be an object` };
    }
    if (!jobs[i].url || typeof jobs[i].url !== 'string') {
      return { error: `job ${i} missing or invalid url` };
    }
    try {
      validateUrl(jobs[i].url);
    } catch (e) {
      return { error: `job ${i} URL validation failed: ${e.message}` };
    }
    if (jobs[i].engine && !VALID_ENGINES.includes(jobs[i].engine)) {
      return { error: `job ${i} invalid engine: ${jobs[i].engine}. Valid: ${VALID_ENGINES.join(', ')}` };
    }
    if (jobs[i].timeout_ms !== undefined) {
      if (!Number.isInteger(jobs[i].timeout_ms) || jobs[i].timeout_ms < 1) {
        return { error: `job ${i} timeout_ms must be a positive integer, got: ${jobs[i].timeout_ms}` };
      }
    }
    // chrome_impersonate requires HTTPS (TLS socket can't do plain HTTP)
    if (jobs[i].engine === 'chrome_impersonate' && !jobs[i].url.startsWith('https://')) {
      return { error: `job ${i}: chrome_impersonate requires https URL (got: ${jobs[i].url.substring(0, 50)})` };
    }
    // Default engine to 'fetch'
    if (!jobs[i].engine) jobs[i].engine = 'fetch';
  }

  // Validate concurrency (must be positive integer, capped)
  if (concurrency !== undefined) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      return { error: `concurrency must be a positive integer, got: ${concurrency}` };
    }
    const maxConc = queue ? MAX_CONCURRENCY_BUILD : MAX_CONCURRENCY_FUNCTION;
    if (concurrency > maxConc) {
      return { error: `concurrency ${concurrency} exceeds max ${maxConc} for ${queue ? 'queue' : 'sync'} mode` };
    }
  }

  // Validate delay_ms (must be non-negative integer, capped)
  if (delay_ms !== undefined) {
    if (!Number.isInteger(delay_ms) || delay_ms < 0) {
      return { error: `delay_ms must be a non-negative integer, got: ${delay_ms}` };
    }
    if (delay_ms > 60_000) {
      return { error: `delay_ms too large (max 60000), got: ${delay_ms}` };
    }
  }

  // Validate result_mode
  if (result_mode !== undefined && !VALID_RESULT_MODES.includes(result_mode)) {
    return { error: `result_mode must be one of ${VALID_RESULT_MODES.join(', ')}, got: ${result_mode}` };
  }

  // Validate queue
  if (queue !== undefined && typeof queue !== 'boolean') {
    return { error: `queue must be boolean, got: ${typeof queue}` };
  }

  // Engine restrictions in function mode
  if (!queue) {
    for (const job of jobs) {
      if (job.engine === 'puppeteer') {
        return { error: 'puppeteer engine is only available in build mode. Set queue=true.', job_url: job.url };
      }
    }
  }

  return null;  // no error
}

// === Blob helpers ===

export async function getStore() {
  const { getStore: getStoreFn } = await import('@netlify/blobs');
  return getStoreFn(STORE_NAME);
}

export async function storeResult(batchId, index, body, contentType, metadata = {}) {
  const store = await getStore();
  const key = `result/${batchId}-${index}`;
  await store.set(key, body, {
    metadata: {
      content_type: contentType,
      size: String(body.length),
      stored_at: new Date().toISOString(),
      url: safeUrlForLog(metadata.url || ''),  // redact query string
      engine: metadata.engine || 'fetch',
      method: metadata.method || 'GET',
      upstream_status: String(metadata.upstream_status || 0),
    },
  });
  return key;
}

export async function setBatchStatus(batchId, status, extra = {}) {
  const store = await getStore();
  const statusObj = {
    ...extra,
    batch_id: batchId,
    status,
    updated_at: new Date().toISOString(),
  };
  await store.setJSON(`status/${batchId}`, statusObj);
  await store.setJSON('index/latest', { batch_id: batchId, status, updated_at: statusObj.updated_at });
  return statusObj;
}

export async function enqueueBatch(batchId, batchSpec) {
  const store = await getStore();
  await store.setJSON(`queue/pending/${batchId}`, batchSpec);
}

export async function dequeueBatch(batchId) {
  const store = await getStore();
  await store.delete(`queue/pending/${batchId}`);
}

// === Fetch engines ===

// Read response body with a size cap (prevents OOM on huge responses)
export async function readCapped(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      reader.cancel();
      throw new Error(`response exceeded ${maxBytes} bytes (truncated)`);
    }
    chunks.push(value);
    total += value.length;
  }
  return Buffer.concat(chunks);
}

export async function fetchWithUndici(job, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
  try {
    const headers = {
      'User-Agent': job.user_agent || DEFAULT_UA,
      'Accept': '*/*',
      ...(job.headers || {}),
    };

    // Partial download resume: if job.resume is true and we have a previous result
    // with a known content-length, send a Range header to continue from where we left off.
    // The caller must check the 'resume_from' field in the result and decide whether to
    // concatenate with previous data.
    if (job.resume && job.resume_from_bytes && job.resume_from_bytes > 0) {
      headers['Range'] = `bytes=${job.resume_from_bytes}-`;
    }

    const fetchOpts = {
      method: job.method || 'GET',
      headers,
      redirect: job.follow_redirects !== false ? 'follow' : 'manual',
      signal: controller.signal,
    };
    if (job.body && !['GET', 'HEAD'].includes(job.method || 'GET')) {
      fetchOpts.body = job.body;
    }
    const r = await fetch(job.url, fetchOpts);
    const buf = await readCapped(r, MAX_RESPONSE_BYTES);

    // Check if server responded with 206 Partial Content (resume supported)
    const isPartialResponse = r.status === 206;
    const contentRange = r.headers.get('content-range') || '';
    const totalSize = contentRange ? parseInt(contentRange.match(/\/(\d+)/)?.[1] || '0') : 0;
    const acceptRanges = r.headers.get('accept-ranges');

    return {
      ok: r.ok || isPartialResponse,
      status: r.status,
      body: buf,
      content_type: r.headers.get('content-type') || 'application/octet-stream',
      headers: Object.fromEntries(r.headers.entries()),
      redirected: r.redirected,
      final_url: r.url,
      // Resume metadata
      resume: {
        requested: !!job.resume,
        supported: acceptRanges === 'bytes' || isPartialResponse,
        partial_response: isPartialResponse,
        bytes_received: buf.length,
        resume_from: job.resume_from_bytes || 0,
        total_size: totalSize,
        complete: totalSize > 0 && (job.resume_from_bytes || 0) + buf.length >= totalSize,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithTlsImpersonate(job, timeoutMs, tlsImpersonateModule) {
  const { impersonate, isSupported } = tlsImpersonateModule;
  if (!isSupported()) throw new Error('tls-impersonate not supported on this runtime');
  if (job.method && !['GET', 'HEAD'].includes(job.method)) {
    throw new Error('chrome_impersonate only supports GET/HEAD (use engine=fetch for other methods)');
  }
  const { tlsOptions, unsupported } = impersonate(CHROME_120_SPEC);
  const url = new URL(job.url);
  const tlsSocket = tls.connect({
    host: url.hostname,
    port: parseInt(url.port || '443'),
    servername: url.hostname,
    ...tlsOptions,
  });
  const timeout = setTimeout(() => tlsSocket.destroy(new Error('TLS timeout')), timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      tlsSocket.once('secureConnect', resolve);
      tlsSocket.once('error', reject);
    });
    const path = (url.pathname || '/') + (url.search || '');
    const ua = job.user_agent || DEFAULT_UA;
    tlsSocket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${url.hostname}\r\nUser-Agent: ${ua}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`
    );
    // Binary-safe collection with size cap
    const chunks = [];
    let total = 0;
    let truncated = false;
    await new Promise((resolve) => {
      tlsSocket.on('data', (c) => {
        if (total + c.length > MAX_RESPONSE_BYTES) {
          const remaining = MAX_RESPONSE_BYTES - total;
          if (remaining > 0) chunks.push(c.subarray(0, remaining));
          truncated = true;
          tlsSocket.destroy();
          resolve();
        } else {
          chunks.push(c);
          total += c.length;
        }
      });
      tlsSocket.on('end', resolve);
      tlsSocket.on('close', resolve);
      tlsSocket.on('error', resolve);
    });
    if (truncated) throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes (truncated)`);
    const rawBuf = Buffer.concat(chunks);
    const headerEnd = rawBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('malformed HTTP response (no header terminator)');

    // Parse headers (use latin1 to preserve bytes)
    const rawHeaders = rawBuf.subarray(0, headerEnd).toString('latin1');
    let body = rawBuf.subarray(headerEnd + 4);

    // Check for chunked transfer encoding and decode if needed
    const transferEncoding = rawHeaders.match(/^transfer-encoding:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
    if (transferEncoding === 'chunked') {
      body = dechunkBody(body);
    }

    const status = parseInt(rawHeaders.match(/^HTTP\/[\d.]+ (\d+)/)?.[1] || '0');
    const ctMatch = rawHeaders.match(/^content-type:\s*(.+)$/im);
    const headerLines = rawHeaders.split('\r\n').slice(1).filter(Boolean);
    const headerObj = {};
    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx > 0) headerObj[line.substring(0, idx).trim().toLowerCase()] = line.substring(idx + 1).trim();
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
      content_type: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      headers: headerObj,
      tls: {
        negotiated: { protocol: tlsSocket.getProtocol(), cipher: tlsSocket.getCipher()?.name, alpn: tlsSocket.alpnProtocol },
        unsupported_features: unsupported,
      },
      redirected: false,
      final_url: job.url,
    };
  } finally {
    clearTimeout(timeout);
    tlsSocket.destroy();
  }
}

// Decode HTTP/1.1 chunked transfer encoding
function dechunkBody(buf) {
  const result = [];
  let pos = 0;
  while (pos < buf.length) {
    // Find chunk size line ending
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const sizeLine = buf.subarray(pos, lineEnd).toString('latin1').trim();
    const chunkSize = parseInt(sizeLine.split(';')[0], 16);  // hex, ignore extensions
    if (isNaN(chunkSize) || chunkSize < 0) break;
    if (chunkSize === 0) break;  // last chunk
    pos = lineEnd + 2;
    if (pos + chunkSize > buf.length) {
      // Incomplete chunk — take what we have
      result.push(buf.subarray(pos));
      break;
    }
    result.push(buf.subarray(pos, pos + chunkSize));
    pos += chunkSize + 2;  // skip chunk data + trailing \r\n
  }
  return Buffer.concat(result);
}

// === Extract TLS fingerprint (from TLS echo services like tls.peet.ws) ===

export function extractTlsFingerprint(body) {
  // Only attempt on first 4KB to avoid OOM on binary bodies
  const peek = body.length > 4096 ? body.subarray(0, 4096) : body;
  try {
    const text = peek.toString('utf8');
    if (!text.includes('ja3')) return null;
    const j = JSON.parse(text);
    if (j.tls?.ja3_hash) {
      return {
        ja3_hash: j.tls.ja3_hash,
        ja4: j.tls.ja4,
        http_version: j.http_version,
        ip: j.ip,
        ciphers_count: j.tls?.ciphers?.length,
        extensions_count: j.tls?.extensions?.length,
      };
    }
  } catch {
    // not JSON
  }
  return null;
}

// === Timeout helper (for puppeteer actions) ===

export function withTimeout(promise, ms, errorMsg = 'action timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMsg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// === Process a single job (shared logic) ===

export async function processJob(job, batchId, index, resultMode, batchStartMs, hardTimeoutMs, fetchEngine) {
  const jobStart = Date.now();
  const engine = job.engine || 'fetch';

  // Check hard timeout
  if (Date.now() - batchStartMs > hardTimeoutMs - 2000) {
    return {
      index,
      ok: false,
      status: 0,
      url: job.url,
      engine,
      method: job.method || 'GET',
      size: 0,
      elapsed_ms: 0,
      blob_key: null,
      inline_body: null,
      inline_body_truncated: false,
      tls: null,
      redirected: false,
      final_url: job.url,
      error: 'skipped: timeout approaching',
    };
  }

  const urlForLog = safeUrlForLog(job.url);
  console.log(`[batch ${batchId}] job ${index}: ${job.method || 'GET'} ${urlForLog} engine=${engine}`);

  try {
    const result = await fetchEngine(job);
    const elapsedMs = Date.now() - jobStart;
    const tlsSeenByServer = extractTlsFingerprint(result.body);
    const responseSize = result.body.length;

    let blobKey = null;
    let inlineBody = null;
    let inlineBodyTruncated = false;

    // Determine storage strategy based on result_mode
    // - metadata: NEVER store body, just return metadata
    // - blob: ALWAYS store body
    // - inline: store body only if too large for inline (>32KB)
    // - auto (default): store body if >32KB, include inline if ≤32KB
    const shouldStoreBlob = resultMode !== 'metadata' && (resultMode === 'blob' || responseSize > INLINE_BODY_MAX);
    if (shouldStoreBlob) {
      blobKey = await storeResult(batchId, index, result.body, result.content_type, {
        url: job.url,
        engine,
        method: job.method || 'GET',
        upstream_status: String(result.status),
      });
    }

    // Include inline body (if small enough and result_mode=inline or auto)
    if (resultMode === 'inline' || resultMode === 'auto') {
      if (responseSize > INLINE_BODY_MAX) {
        inlineBody = result.body.subarray(0, INLINE_BODY_MAX).toString('utf8');
        inlineBodyTruncated = true;
      } else {
        inlineBody = result.body.toString('utf8');
      }
    }

    console.log(`[batch ${batchId}] job ${index}: ok status=${result.status} size=${responseSize} ms=${elapsedMs} blob=${!!blobKey}`);

    return {
      index,
      ok: result.ok,
      status: result.status,
      url: job.url,
      engine,
      method: job.method || 'GET',
      size: responseSize,
      content_type: result.content_type,
      elapsed_ms: elapsedMs,
      blob_key: blobKey,
      inline_body: inlineBody,
      inline_body_truncated: inlineBodyTruncated,
      tls: result.tls ? {
        negotiated: result.tls.negotiated,
        seen_by_server: tlsSeenByServer,
      } : tlsSeenByServer,
      redirected: result.redirected,
      final_url: result.final_url,
      puppeteer: result.puppeteer || null,
      error: null,
    };
  } catch (e) {
    const elapsedMs = Date.now() - jobStart;
    console.error(`[batch ${batchId}] job ${index}: error ${e.message}`);
    return {
      index,
      ok: false,
      status: 0,
      url: job.url,
      engine,
      method: job.method || 'GET',
      size: 0,
      elapsed_ms: elapsedMs,
      blob_key: null,
      inline_body: null,
      inline_body_truncated: false,
      tls: null,
      redirected: false,
      final_url: job.url,
      error: e.message,
    };
  }
}

// === Process batch (shared logic) ===

export async function processBatch(batchId, jobs, options, batchStartMs, hardTimeoutMs, maxConcurrency, fetchEngine) {
  const concurrency = Math.min(Math.max(1, options.concurrency || 1), maxConcurrency);
  const delayMs = options.delay_ms || 0;
  const resultMode = options.result_mode || 'blob';
  const results = new Array(jobs.length);

  if (concurrency === 1) {
    for (let i = 0; i < jobs.length; i++) {
      results[i] = await processJob(jobs[i], batchId, i, resultMode, batchStartMs, hardTimeoutMs, fetchEngine);
      if (delayMs > 0 && i < jobs.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  } else {
    // Concurrent (bounded chunks)
    for (let i = 0; i < jobs.length; i += concurrency) {
      const chunkIndices = [];
      const chunkPromises = [];
      for (let j = i; j < Math.min(i + concurrency, jobs.length); j++) {
        chunkIndices.push(j);
        chunkPromises.push(processJob(jobs[j], batchId, j, resultMode, batchStartMs, hardTimeoutMs, fetchEngine));
      }
      const chunkResults = await Promise.all(chunkPromises);
      for (let k = 0; k < chunkResults.length; k++) {
        results[chunkIndices[k]] = chunkResults[k];
      }
      if (delayMs > 0 && i + concurrency < jobs.length) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  return results;
}

// === Compute batch status from results ===

export function computeBatchStatus(results) {
  const succeeded = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok && !r.error?.startsWith('skipped')).length;
  const skipped = results.filter(r => r.error?.startsWith('skipped')).length;
  let status;
  if (succeeded === results.length) status = 'complete';
  else if (succeeded === 0) status = skipped === results.length ? 'skipped' : 'failed';
  else status = 'partial';
  return { succeeded, failed, skipped, status };
}

// === Summary for status blob ===

export function resultsSummary(results) {
  return results.map(r => ({
    index: r.index,
    ok: r.ok,
    status: r.status,
    url: safeUrlForLog(r.url),  // redact query string
    engine: r.engine,
    size: r.size,
    elapsed_ms: r.elapsed_ms,
    blob_key: r.blob_key,
    error: r.error,
  }));
}

// === Resume incomplete batches ===
// Finds batches that are in 'running' or 'pending' state but have no corresponding
// queue entry (orphaned), or that have been 'running' for too long (stale).
// Re-enqueues them so the next build picks them up.

export async function resumeIncompleteBatches() {
  const store = await getStore();
  const list = await store.list();

  // Collect all status blobs and queue entries
  const statusBlobs = (list.blobs || []).filter(b => b.key.startsWith('status/'));
  const queueKeys = new Set((list.blobs || []).filter(b => b.key.startsWith('queue/pending/')).map(b => b.key));

  const now = Date.now();
  const resumeable = [];
  const orphaned = [];

  for (const sb of statusBlobs) {
    try {
      const status = await store.get(sb.key, { type: 'json' });
      if (!status || !status.batch_id) continue;

      const batchId = status.batch_id;
      const queueKey = `queue/pending/${batchId}`;
      const hasQueueEntry = queueKeys.has(queueKey);
      const updatedAt = status.updated_at ? new Date(status.updated_at).getTime() : 0;
      const ageMs = now - updatedAt;

      // Case 1: Status is 'running' but stale (> STALE_RUNNING_MS) — build crashed
      if (status.status === 'running' && ageMs > STALE_RUNNING_MS) {
        if (hasQueueEntry) {
          // Queue entry still exists — reset to pending for reprocessing
          resumeable.push({ batch_id: batchId, status, reason: 'stale_running_with_queue', age_ms: ageMs });
        } else {
          // Queue entry is gone — can't reprocess without job specs
          orphaned.push({ batch_id: batchId, status, reason: 'stale_running_no_queue', age_ms: ageMs });
        }
      }

      // Case 2: Status is 'pending' but has no queue entry — orphaned
      if (status.status === 'pending' && !hasQueueEntry) {
        orphaned.push({ batch_id: batchId, status, reason: 'pending_no_queue', age_ms: ageMs });
      }

      // Case 3: Status is 'partial' with skipped jobs and has queue entry —
      // (This shouldn't happen because processBatchBuild requeues skipped jobs,
      //  but check defensively)
      if (status.status === 'partial' && hasQueueEntry && status.skipped > 0) {
        resumeable.push({ batch_id: batchId, status, reason: 'partial_with_skipped', age_ms: ageMs });
      }
    } catch {
      // Skip unreadable status blobs
    }
  }

  // Re-enqueue resumeable batches
  const requeued = [];
  for (const r of resumeable) {
    await setBatchStatus(r.batch_id, 'pending', {
      ...r.status,
      status: 'pending',
      resumed_at: new Date().toISOString(),
      resume_reason: r.reason,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
    });
    requeued.push(r);
    console.log(`RESUME batch_id=${r.batch_id} reason=${r.reason} age=${Math.round(r.age_ms / 1000)}s`);
  }

  // Mark orphaned batches as error
  const orphanedIds = [];
  for (const o of orphaned) {
    await setBatchStatus(o.batch_id, 'error', {
      ...o.status,
      status: 'error',
      error: `orphaned: ${o.reason} (job specs lost)`,
      orphaned_at: new Date().toISOString(),
    });
    orphanedIds.push(o.batch_id);
    console.log(`ORPHAN batch_id=${o.batch_id} reason=${o.reason}`);
  }

  return {
    requeued: requeued.map(r => ({ batch_id: r.batch_id, reason: r.reason, age_ms: r.age_ms })),
    orphaned: orphanedIds.map(id => ({ batch_id: id, reason: 'no_queue_entry' })),
    total_checked: statusBlobs.length,
  };
}
