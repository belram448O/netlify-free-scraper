# Netlify Free-Tier Scraper Protocol v2

## Design principles

1. **Functions are for direct invocation, not queue management.** Don't waste function calls on status polling — clients read Blobs directly.
2. **Build plugin (queue) is for long-running jobs only.** Small/fast jobs go through the function synchronously.
3. **Batch requests are atomic.** A single function call processes N URLs and returns all results in one response (or all in blobs).
4. **Same job spec everywhere.** Function and build plugin accept identical job format — only the runner differs.
5. **Three engines, picked per-job:** `fetch` (fast, Node fingerprint), `chrome_impersonate` (Chrome JA3 via tls-impersonate), `puppeteer` (real Chrome, build-only).

## Job spec (canonical)

A single job describes one URL fetch:

```json
{
  "url": "https://example.com",
  "method": "GET",
  "headers": { "Authorization": "Bearer xxx" },
  "body": null,
  "engine": "fetch",
  "timeout_ms": 30000,
  "follow_redirects": true,
  "user_agent": "Mozilla/5.0 ...",
  "wait_for": null,
  "actions": [],
  "screenshot": false,
  "screenshot_full": false
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string (required) | — | Target URL (must be http/https, no private IPs) |
| `method` | string | `GET` | HTTP method. For `chrome_impersonate`, only GET/HEAD allowed |
| `headers` | object | `{}` | Custom request headers |
| `body` | string\|null | null | Request body (for POST/PUT) |
| `engine` | string | `fetch` | `fetch` \| `chrome_impersonate` \| `puppeteer` (puppeteer is queue-only) |
| `timeout_ms` | number | 25000 (function) / 60000 (build) | Per-job timeout. Capped at 25000 in function mode (under 28s Lambda hard limit) |
| `follow_redirects` | boolean | true | Follow HTTP redirects (only `fetch` engine; `chrome_impersonate` and `puppeteer` don't follow) |
| `user_agent` | string | Chrome 120 UA | User-Agent header |
| `wait_for` | string\|object\|null | null | puppeteer-only: CSS selector (string) or `{ type: 'timeout'\|'selector'\|'networkidle', ms?, selector? }` |
| `actions` | array | `[]` | puppeteer-only: `[{ type: 'click', selector }, { type: 'wait', ms }, { type: 'type', selector, text }, { type: 'scroll', x, y }, { type: 'wait_for_selector', selector }]` |
| `screenshot` | boolean | false | puppeteer-only: capture PNG screenshot |
| `screenshot_full` | boolean | false | puppeteer-only: full-page screenshot |

## Batch request

```json
POST /api/scrape
Content-Type: application/json

{
  "jobs": [<job>, <job>, ...],
  "delay_ms": 0,
  "concurrency": 1,
  "result_mode": "blob",
  "queue": false
}
```

### Batch options

| Field | Type | Default | Description |
|---|---|---|---|
| `jobs` | array (required) | — | Array of job specs (1-50 sync, 1-500 queue) |
| `delay_ms` | number | 0 | Delay between jobs (or chunks if concurrency > 1) |
| `concurrency` | number | 1 | Parallel jobs. Max 5 in function mode, 10 in queue mode |
| `result_mode` | string | `blob` | `blob` (store body, return key) \| `inline` (return body, ≤32KB) \| `metadata` (discard body, return only headers) \| `auto` (inline if ≤32KB, blob if larger) |
| `queue` | boolean | false | If true, defer to build plugin for long-running processing |

## Response (batch sync mode)

```json
{
  "batch_id": "batch-1786749000-abc",
  "status": "complete",
  "processed": 2,
  "succeeded": 2,
  "failed": 0,
  "skipped": 0,
  "elapsed_ms": 1234,
  "results": [
    {
      "index": 0,
      "ok": true,
      "status": 200,
      "url": "https://api.github.com/repos/netlify/netlify-cli",
      "engine": "fetch",
      "method": "GET",
      "size": 1234,
      "content_type": "application/json",
      "elapsed_ms": 234,
      "blob_key": "result/batch-1786749000-abc-0",
      "inline_body": null,
      "inline_body_truncated": false,
      "tls": null,
      "redirected": false,
      "final_url": "https://api.github.com/repos/netlify/netlify-cli",
      "error": null
    }
  ]
}
```

### Result fields

| Field | Description |
|---|---|
| `index` | Job position in batch (0-based) |
| `ok` | HTTP 2xx? |
| `status` | HTTP status code (0 if request failed) |
| `url` | Original target URL |
| `engine` | Engine used (`fetch`, `chrome_impersonate`, `puppeteer`) |
| `method` | HTTP method |
| `size` | Response body size in bytes |
| `content_type` | Response Content-Type |
| `elapsed_ms` | Per-job duration |
| `blob_key` | Blob key for stored result (null if `result_mode=inline` and body returned inline) |
| `inline_body` | Response body if `result_mode=inline` and ≤32KB (null otherwise) |
| `inline_body_truncated` | True if `inline_body` was truncated at 32KB |
| `tls` | TLS info: `{ negotiated: { protocol, cipher, alpn }, seen_by_server: { ja3_hash, ja4, ... } }` (null for `fetch` unless target is a TLS echo service) |
| `redirected` | Did the request follow redirects? (always false for `chrome_impersonate` and `puppeteer`) |
| `final_url` | Final URL after redirects |
| `error` | Error message (null on success) |

## Response (queue mode)

```json
{
  "batch_id": "batch-1786749000-abc",
  "status": "pending",
  "job_count": 2,
  "message": "Batch queued. Build plugin will process on next preview deploy. Poll status via Blobs API.",
  "poll_hint": "GET https://api.netlify.com/api/v1/blobs/{site_id}/site:scraper-results/status/batch-1786749000-abc"
}
```

## Status blob (in `scraper-results` store)

Once a batch is queued or processed, its status is persisted as a JSON blob at key `status/{batch_id}`:

```json
{
  "batch_id": "batch-1786749000-abc",
  "status": "complete",
  "updated_at": "2026-08-14T23:25:13.591Z",
  "job_count": 2,
  "succeeded": 2,
  "failed": 0,
  "skipped": 0,
  "elapsed_ms": 10893,
  "completed_at": "2026-08-14T23:25:13.591Z",
  "options": { "delay_ms": 0, "concurrency": 1, "result_mode": "blob" },
  "results": [
    {
      "index": 0,
      "ok": true,
      "status": 200,
      "url": "https://example.com",
      "engine": "fetch",
      "size": 1234,
      "elapsed_ms": 234,
      "blob_key": "result/batch-1786749000-abc-0",
      "error": null
    }
  ]
}
```

### Status values

| Status | Description |
|---|---|
| `pending` | Job queued, waiting for build plugin to pick up |
| `running` | Build plugin is currently processing this batch |
| `complete` | All jobs succeeded |
| `partial` | Some jobs succeeded, some failed |
| `failed` | All jobs failed |
| `error` | Batch-level error (e.g., build crashed, queue processing threw) |

## Storage layout (Blobs, store=`scraper-results`)

```
status/{batch_id}                  — JSON: batch status (see above)
result/{batch_id}-{index}         — Raw bytes: each job's response body
queue/pending/{batch_id}          — JSON: batch spec (only present while queued)
index/latest                       — JSON: pointer to most recent batch
```

## Engine matrix

| Engine | Function (30s) | Build plugin (15 min) | JA3 hash | Use case |
|---|---|---|---|---|
| `fetch` | ✅ | ✅ | `1808993db60a053eb8ce0eb1c51750d6` (Node) | Unprotected sites, fast |
| `chrome_impersonate` | ✅ (GET/HEAD only) | ✅ (GET/HEAD only) | `947eccbc4e2adea862cd37bf77342106` (Chrome-like) | JA3-aware bot sites |
| `puppeteer` | ❌ (rejected) | ✅ | Real Chrome (`cd08e31494f9531f560d64c695473da9`) | JS-rendered, login flows, infinite scroll |

## When to use what

| Scenario | Path |
|---|---|
| 1 URL, fast (<5s), small response | Function, `result_mode=inline` |
| 1 URL, fast, large response | Function, `result_mode=blob` |
| N URLs, fast, all <30s total | Function batch, `result_mode=blob` |
| 1 URL, slow (>30s, large file) | Queue → build plugin |
| N URLs, slow, total >30s | Queue batch → build plugin |
| JS-rendered page (needs real Chrome) | Queue → build plugin + `engine=puppeteer` |
| Login flow, click sequences | Queue → build plugin + `engine=puppeteer` + `actions=[...]` |

## CLI tools (no function calls wasted for queue management)

```bash
# Submit a batch (sync, function processes inline)
cli/submit.mjs --url https://example.com --url https://example.org --engine fetch

# Submit to queue (async, build plugin processes)
cli/submit.mjs --queue --url https://large-file.com/file.zip --engine fetch

# Poll batch status (reads blob directly, zero function calls)
cli/status.mjs --batch-id batch-1786749000-abc
# Or wait for completion:
cli/status.mjs --batch-id batch-1786749000-abc --wait

# Get a result (reads blob directly, zero function calls)
cli/result.mjs --batch-id batch-1786749000-abc --index 0
# Or save to file:
cli/result.mjs --batch-id batch-1786749000-abc --index 0 --output result.html

# List recent batches
cli/list.mjs --status complete --limit 10
```

All CLI tools hit the Blobs API directly with a PAT — zero function invocations for queue management.

## Security

### SSRF protection

URLs are validated before fetching:
- Must be `http:` or `https:` scheme
- Hostname can't be `localhost`, `*.localhost`, or `::1`
- Direct IP addresses are checked against private ranges:
  - `127.0.0.0/8` (loopback)
  - `10.0.0.0/8` (private)
  - `192.168.0.0/16` (private)
  - `172.16.0.0/12` (private)
  - `169.254.0.0/16` (link-local — AWS metadata)
  - `0.0.0.0/8` (current network)
  - `100.64.0.0/10` (CGNAT)

**Note:** DNS rebinding (where a hostname resolves to a private IP) is NOT protected against — for full protection, resolve the hostname and re-check the IP. Adds latency; not implemented by default.

### URL logging

URLs are redacted in logs — only origin + path are logged, query strings are replaced with `[redacted]` to prevent leaking secrets in URLs.

## Limits

| Limit | Function mode | Queue mode (build) |
|---|---|---|
| Max jobs per batch | 50 | 500 |
| Max concurrency | 5 | 10 |
| Max per-job timeout | 25s | 60s |
| Max response size | 50 MB | 50 MB |
| Total batch timeout | 28s (2s buffer under 30s Lambda cap) | 14 min (1 min buffer under 15 min build cap) |
| Inline body max | 32 KB | n/a (always stored to blob) |

## Cost model

| Action | Cost |
|---|---|
| Function invocation (200ms) | ~0.0006 credits (compute) |
| Function-initiated download (ingress) | 0 credits |
| Blob write from function/build | 0 credits |
| Blob read via API (CLI) | 0 credits |
| Function returning small JSON response | ~0.0001 credits (bandwidth) |
| Preview deploy (triggers queue processing) | 0 credits |
| Production deploy | 15 credits (avoid) |
