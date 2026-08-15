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
netlify deploy
```

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
