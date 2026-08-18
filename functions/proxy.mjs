// Simplified proxy endpoint — fetches a URL and returns the body inline.
//
// No blob storage. No queue. No build plugin. No CLI. No PAT.
// Just: POST /api/proxy with {url, method?, headers?, body?} → response bytes.
//
// Use this when you don't need batch processing, persistence, or puppeteer.
// Use /api/scrape (see PROTOCOL.md) when you need any of those features.
//
// Auth: same SCRAPE_API_KEY as the main scraper (set via netlify env:set).
// If SCRAPE_API_KEY is unset, the endpoint is open (use with care).

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;  // 5 MB hard cap for inline responses
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function checkAuth(req) {
  const apiKey = process.env.SCRAPE_API_KEY;
  if (!apiKey) return null; // open mode
  const authHeader = req.headers.get('authorization') || '';
  const xApiKey = req.headers.get('x-api-key') || '';
  const providedKey = authHeader.replace(/^Bearer\s+/i, '') || xApiKey;
  if (providedKey !== apiKey) {
    return Response.json({
      error: 'unauthorized',
      hint: 'Provide your API key via Authorization: Bearer <key> or X-Api-Key: <key> header',
    }, { status: 401 });
  }
  return null;
}

function error(status, message, hint) {
  const body = { error: message };
  if (hint) body.hint = hint;
  return Response.json(body, { status });
}

async function readCapped(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${maxBytes} bytes (truncated)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, context) {
  // Only POST is supported
  if (req.method !== 'POST') {
    return error(405, 'method not allowed', 'Use POST. Body: {url, method?, headers?, body?, timeout_ms?, follow_redirects?, user_agent?}');
  }

  // Auth check
  const authError = checkAuth(req);
  if (authError) return authError;

  // Parse body
  let job;
  try {
    job = await req.json();
  } catch (e) {
    return error(400, 'invalid JSON body', e.message);
  }

  // Validate URL
  if (!job || typeof job !== 'object') {
    return error(400, 'body must be a JSON object');
  }
  if (!job.url || typeof job.url !== 'string') {
    return error(400, 'missing or invalid "url" field');
  }
  let targetUrl;
  try {
    targetUrl = new URL(job.url);
  } catch (e) {
    return error(400, 'invalid url', e.message);
  }

  // Block obvious SSRF: no localhost, no private IPs
  const hostname = targetUrl.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
      hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.') || hostname === 'metadata.google.internal') {
    return error(403, 'blocked: target hostname is private/loopback');
  }
  // Block 172.16/12 (private) — check after parsing
  const parts = hostname.split('.');
  if (parts.length === 4 && parts[0] === '172') {
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) {
      return error(403, 'blocked: target hostname is private/loopback');
    }
  }

  // Only http/https
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return error(400, 'only http and https URLs are supported');
  }

  // Build request
  const method = (job.method || 'GET').toUpperCase();
  const validMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (!validMethods.includes(method)) {
    return error(400, `unsupported method: ${method}`, `Allowed: ${validMethods.join(', ')}`);
  }

  const timeoutMs = Math.min(
    Math.max(parseInt(job.timeout_ms, 10) || DEFAULT_TIMEOUT_MS, 1000),
    DEFAULT_TIMEOUT_MS
  );

  const headers = {
    'User-Agent': job.user_agent || DEFAULT_UA,
    'Accept': '*/*',
    ...(job.headers || {}),
  };

  const fetchOpts = {
    method,
    headers,
    redirect: job.follow_redirects !== false ? 'follow' : 'manual',
  };
  if (job.body && !['GET', 'HEAD'].includes(method)) {
    fetchOpts.body = typeof job.body === 'string' ? job.body : JSON.stringify(job.body);
    if (!headers['Content-Type'] && typeof job.body === 'object') {
      headers['Content-Type'] = 'application/json';
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);

  const startTime = Date.now();
  try {
    const r = await fetch(targetUrl.href, { ...fetchOpts, signal: controller.signal });
    const buf = await readCapped(r.body, MAX_RESPONSE_BYTES);
    const elapsedMs = Date.now() - startTime;

    // Decide content-type for response
    const contentType = r.headers.get('content-type') || 'application/octet-stream';

    // Build response headers — pass through a safe subset
    const respHeaders = {
      'X-Proxy-Status': String(r.status),
      'X-Proxy-Elapsed-Ms': String(elapsedMs),
      'X-Proxy-Final-Url': r.url || targetUrl.href,
      'X-Proxy-Bytes': String(buf.length),
    };
    if (r.redirected) respHeaders['X-Proxy-Redirected'] = '1';
    respHeaders['Content-Type'] = contentType;

    // Return body inline as bytes
    return new Response(buf, {
      status: 200,  // always 200 if the fetch succeeded; the original status is in X-Proxy-Status
      headers: respHeaders,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startTime;
    if (e.name === 'AbortError' || /timeout/i.test(e.message)) {
      return error(504, 'upstream timeout', `after ${elapsedMs}ms (limit ${timeoutMs}ms)`);
    }
    return error(502, 'upstream fetch failed', e.message);
  } finally {
    clearTimeout(timeout);
  }
}
