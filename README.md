# Netlify Free Scraper

A production batch HTTP scraper for Netlify's free tier.

## Features

- **Batch processing**: Submit N URLs in one function call
- **3 engines**: `fetch` (fast), `chrome_impersonate` (Chrome TLS), `puppeteer` (real Chrome)
- **4 result modes**: `blob` (free storage), `inline` (small response), `metadata` (headers only), `auto`
- **Queue mode**: Long-running jobs processed by build plugin (up to 15 min)
- **Zero queue management**: CLI reads Blobs directly — no function calls for status polling
- **SSRF protection**: Private IP ranges blocked (IPv4 + IPv6)
- **Optional PAT protection**: Require API key on the scrape endpoint

## Quick start

```bash
npm install
cd functions && npm install && cd ..
netlify link

# Set SCRAPE_API_KEY (any shared secret — NOT a Netlify PAT)
# This protects the /api/scrape endpoint from anonymous abuse
netlify env:set SCRAPE_API_KEY my-secret-key-123

# Set NETLIFY_AUTH_TOKEN + SITE_ID (for /api/trigger-build to work)
# These are Netlify PAT + site ID — used internally by the function
netlify env:set NETLIFY_AUTH_TOKEN nfp_your_netlify_pat
netlify env:set SITE_ID your-site-id-here

netlify deploy

# Disable SSO so function URLs are public (one-time — see docs/dashboard-automation.md)
node tools/netlify-dashboard-api.mjs disable-sso <site_id>
```

## Authentication

| Who | What they need | How |
|---|---|---|
| **Client** calling the API | `SCRAPE_API_KEY` (any shared secret) | `Authorization: Bearer <key>` header |
| **Client** fetching blob bytes | Netlify PAT (`nfp_...`) | `Authorization: Bearer nfp_...` header on blob URL |
| **Function** (internal) | `NETLIFY_AUTH_TOKEN` + `SITE_ID` | Set as env vars in Netlify dashboard |

The client NEVER needs a Netlify PAT for the function endpoints. A PAT is only needed for step 5 (fetching raw blob bytes via the Blobs API).

See `PROTOCOL.md` for full API spec.

## Usage as a dependency

```bash
npm install belram448O/netlify-free-scraper
```

```js
// Import the shared library
import { validateBatchRequest, processBatch } from 'netlify-free-scraper';

// Import the function handler
import handler from 'netlify-free-scraper/function';

// Import the build plugin
import plugin from 'netlify-free-scraper/plugin';
```

## License

MIT
