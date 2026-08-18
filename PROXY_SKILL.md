# Skill: Netlify Proxy — Fetch One URL, Get Bytes Back

> **Load this file when you need to make an HTTP request from a context where direct internet access is blocked or fingerprinted, and you just want the response bytes.**
>
> This is a minimal skill. There is nothing to build, deploy, or maintain. You just call one endpoint.

## When to use

- You're an LLM agent in a sandbox without direct internet access
- You need to fetch a URL from a specific region (us-east-2, since that's where the function runs)
- You need to make a quick API call and don't want to set up a scraper pipeline
- You want to test if a URL is reachable from outside your network

## When NOT to use

- You need to scrape many URLs in batch → use the full scraper skill instead
- You need to persist responses → use the full scraper (stores to Blobs)
- You need JS rendering → use the full scraper with puppeteer engine
- You need TLS fingerprint impersonation → use the full scraper with `chrome_impersonate`
- You need responses >5 MB → use the full scraper with blob result mode
- You need >25 second timeouts → use the full scraper with queue mode

## The endpoint

```
POST https://6a803881151f1ede038cd0cc--transcendent-cheesecake-03f934.netlify.app/api/proxy
```

## Auth

Header (either form works):
- `Authorization: Bearer nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87`
- `X-Api-Key: nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87`

## The one call

```bash
curl -X POST 'https://6a803881151f1ede038cd0cc--transcendent-cheesecake-03f934.netlify.app/api/proxy' \
  -H 'Authorization: Bearer nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

That's it. The response body is the upstream response bytes.

## Request body schema

```json
{
  "url": "https://example.com/path",   // required, http(s) only
  "method": "GET",                     // optional, default GET
  "headers": {"X-Foo": "bar"},         // optional
  "body": "raw string or object",      // optional (object → JSON, auto Content-Type)
  "timeout_ms": 25000,                 // optional, 1000–25000
  "follow_redirects": true,            // optional, default true
  "user_agent": "Mozilla/5.0 ..."     // optional, default Chrome 120 UA
}
```

## Response

The response body is the upstream response bytes, returned inline as the proxy response body.

Response headers carry the metadata:
- `X-Proxy-Status` — the upstream HTTP status code (e.g., `200`, `404`, `500`)
- `X-Proxy-Elapsed-Ms` — how long the upstream took
- `X-Proxy-Final-Url` — final URL after redirects (if any)
- `X-Proxy-Bytes` — byte count of the response body
- `X-Proxy-Redirected` — `1` if a redirect was followed
- `Content-Type` — passed through from upstream

The proxy itself returns `200` if the upstream fetch succeeded (even if upstream was 4xx/5xx). Always check `X-Proxy-Status` for the real upstream status.

## Hard limits

- **5 MB response cap.** Larger = `502` error.
- **25 second timeout.** Slower upstream = `504` error.
- **No retries.** Failures bubble up.
- **No persistence.** Body is not saved anywhere.
- **SSRF block.** Localhost, private IPs, link-local are rejected with `403`.

## Error status codes from the proxy

| Code | Meaning |
|---|---|
| `200` | Upstream fetched (check `X-Proxy-Status` for the real code) |
| `400` | Bad request body (missing url, bad JSON) |
| `401` | Auth missing or wrong |
| `403` | URL blocked (private IP) |
| `405` | Method not allowed (only POST to the proxy itself) |
| `502` | Upstream fetch failed (DNS, connection, oversized) |
| `504` | Upstream timeout |

## Quick recipes

### GET JSON

```bash
curl -s -X POST 'https://6a803881151f1ede038cd0cc--transcendent-cheesecake-03f934.netlify.app/api/proxy' \
  -H 'Authorization: Bearer nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://api.github.com/repos/microsoft/vscode"}' | jq .
```

### POST with auth header upstream

```bash
curl -X POST 'https://6a803881151f1ede038cd0cc--transcendent-cheesecake-03f934.netlify.app/api/proxy' \
  -H 'Authorization: Bearer nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87' \
  -H 'Content-Type: application/json' \
  -d '{
    "url":"https://api.openai.com/v1/models",
    "headers":{"Authorization":"Bearer sk-..."}
  }'
```

### Fetch and save to file

```bash
curl -X POST 'https://6a803881151f1ede038cd0cc--transcendent-cheesecake-03f934.netlify.app/api/proxy' \
  -H 'Authorization: Bearer nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/large-file.bin"}' \
  -o output.bin
```

### Inspect headers without downloading body

```bash
curl -X POST 'https://6a803881151f1ede038cd0cc--transcendent-cheesecake-03f934.netlify.app/api/proxy' \
  -H 'Authorization: Bearer nfp_YfWhZCYLjYQatPEcpjDPB5WGRD8RRKaGec87' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","method":"HEAD"}' \
  -D -
```

## Anti-patterns

- **Don't poll this endpoint.** It's stateless — there's nothing to poll. If you need to track status, use the full scraper.
- **Don't send the same URL many times hoping for cached/different results.** Each call is a fresh fetch.
- **Don't try to use this for huge files.** 5 MB cap is hard.
- **Don't send nested JSON expecting it to be re-encoded.** The `body` field is sent as-is (string) or JSON-stringified (object). No deep merging.

## That's all

If you find yourself wanting batching, persistence, JS rendering, TLS impersonation, or anything beyond "fetch this URL and give me the bytes," switch to the full scraper skill — see `agent-kit/docs/agent-skill.md` in the [netlify-free-tier-maxxing repo](https://github.com/belram448O/netlify-free-tier-maxxing) or read `PROTOCOL.md` in the [netlify-free-scraper repo](https://github.com/belram448O/netlify-free-scraper).
