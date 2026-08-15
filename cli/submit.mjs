#!/usr/bin/env node
// CLI: Submit a batch scrape request
//
// Usage:
//   cli/submit.mjs --url https://example.com --url https://example.org [--engine fetch|chrome_impersonate|puppeteer]
//                  [--method GET|POST] [--body '<json>'] [--header 'Authorization: Bearer xxx']
//                  [--delay-ms 100] [--concurrency 3] [--result-mode blob|inline|metadata]
//                  [--queue] [--timeout 30000] [--ua '...']
//                  [--wait-for 'css-selector'|'timeout:2000'] [--action 'click:#btn'|'wait:500']
//
// Examples:
//   cli/submit.mjs --url https://example.com
//   cli/submit.mjs --url https://a.com --url https://b.com --result-mode blob
//   cli/submit.mjs --url https://example.com --engine puppeteer --queue --wait-for 'timeout:2000'
//   cli/submit.mjs --url https://httpbin.org/post --method POST --body '{"hello":"world"}' --header 'Content-Type: application/json'

function parseArgs(argv) {
  const args = { urls: [], headers: {}, actions: [], wait_for: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return v;
    };
    switch (arg) {
      case '--url': args.urls.push(next()); break;
      case '--engine': args.engine = next(); break;
      case '--method': args.method = next(); break;
      case '--body': args.body = next(); break;
      case '--header': {
        const h = next();
        const idx = h.indexOf(':');
        if (idx <= 0) {
          console.error(`Error: --header must be 'Key: Value', got: ${h}`);
          process.exit(1);
        }
        args.headers[h.substring(0, idx).trim()] = h.substring(idx + 1).trim();
        break;
      }
      case '--delay-ms': args.delay_ms = parseInt(next()); break;
      case '--concurrency': args.concurrency = parseInt(next()); break;
      case '--result-mode': args.result_mode = next(); break;
      case '--queue': args.queue = true; break;
      case '--timeout': args.timeout_ms = parseInt(next()); break;
      case '--ua': args.user_agent = next(); break;
      case '--wait-for': {
        const v = next();
        if (v.startsWith('timeout:')) args.wait_for = { type: 'timeout', ms: parseInt(v.substring(8)) };
        else if (v.startsWith('selector:')) args.wait_for = { type: 'selector', selector: v.substring(9) };
        else if (v === 'networkidle') args.wait_for = { type: 'networkidle' };
        else args.wait_for = v;
        break;
      }
      case '--action': {
        const v = next();
        const colonIdx = v.indexOf(':');
        if (colonIdx <= 0) {
          console.error(`Error: --action must be 'type:value', got: ${v}`);
          process.exit(1);
        }
        const type = v.substring(0, colonIdx);
        const val = v.substring(colonIdx + 1);
        if (type === 'click') args.actions.push({ type: 'click', selector: val });
        else if (type === 'wait') args.actions.push({ type: 'wait', ms: parseInt(val) || 500 });
        else if (type === 'type') {
          const [selector, ...textParts] = val.split(',');
          args.actions.push({ type: 'type', selector, text: textParts.join(',') || '' });
        }
        else if (type === 'scroll') args.actions.push({ type: 'scroll', x: 0, y: parseInt(val) || 1000 });
        else if (type === 'wait_for_selector') args.actions.push({ type: 'wait_for_selector', selector: val });
        else {
          console.error(`Error: unknown action type: ${type}`);
          process.exit(1);
        }
        break;
      }
      case '--screenshot': args.screenshot = true; break;
      case '--screenshot-full': args.screenshot = true; args.screenshot_full = true; break;
      case '--help': case '-h':
        console.log(`Usage: cli/submit.mjs --url <url> [--url <url>...] [options]

Required:
  --url <url>                    URL to scrape (can repeat for batch)

Job options:
  --engine <name>                fetch | chrome_impersonate | puppeteer (default: fetch)
  --method <method>              HTTP method (default: GET)
  --body <string>                Request body (for POST/PUT)
  --header 'Key: Value'          Custom header (can repeat)
  --timeout <ms>                 Per-job timeout (default: 25000 in function mode, 60000 in queue mode)
  --ua <string>                  User-Agent override

Batch options:
  --delay-ms <ms>                Delay between jobs (default: 0)
  --concurrency <n>              Parallel jobs (default: 1, max 5 function / 10 build)
  --result-mode <mode>           blob | inline | metadata | auto (default: blob)
  --queue                        Submit to build queue (for long-running, max 500 jobs)

Puppeteer-only:
  --wait-for <spec>              'css-selector' | 'timeout:2000' | 'selector:#id' | 'networkidle'
  --action <spec>                'click:#btn' | 'wait:500' | 'type:#input,hello' | 'scroll:1000' | 'wait_for_selector:#id'
  --screenshot                   Capture screenshot (PNG)
  --screenshot-full              Full-page screenshot

Environment:
  NETLIFY_SITE_URL               Base URL (e.g., https://<deploy-id>--<site>.netlify.app)
  NETLIFY_AUTH_TOKEN             PAT (not needed for sync calls; needed for queue polling)`);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.urls.length === 0) {
    console.error('Error: at least one --url is required');
    process.exit(1);
  }

  const baseUrl = process.env.NETLIFY_SITE_URL;
  if (!baseUrl) {
    console.error('Error: NETLIFY_SITE_URL env var required (e.g., https://<deploy-id>--<site>.netlify.app)');
    process.exit(1);
  }

  // Validate URLs
  for (const u of args.urls) {
    try {
      const parsed = new URL(u);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error(`Error: URL must be http or https: ${u}`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: invalid URL: ${u}`);
      process.exit(1);
    }
  }

  const jobs = args.urls.map(url => {
    const job = { url, engine: args.engine || 'fetch' };
    if (args.method) job.method = args.method;
    if (args.body) job.body = args.body;
    if (Object.keys(args.headers).length > 0) job.headers = args.headers;
    if (args.timeout_ms) job.timeout_ms = args.timeout_ms;
    if (args.user_agent) job.user_agent = args.user_agent;
    if (args.wait_for) job.wait_for = args.wait_for;
    if (args.actions.length > 0) job.actions = args.actions;
    if (args.screenshot) {
      job.screenshot = true;
      job.screenshot_full = !!args.screenshot_full;
    }
    return job;
  });

  const batchRequest = {
    jobs,
    delay_ms: args.delay_ms,
    concurrency: args.concurrency,
    result_mode: args.result_mode || 'blob',
    queue: !!args.queue,
  };

  console.log(`Submitting ${jobs.length} job(s) to ${args.queue ? 'queue' : 'function (sync)'}...`);
  console.log();

  const r = await fetch(`${baseUrl}/api/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SCRAPE_API_KEY ? { 'Authorization': `Bearer ${process.env.SCRAPE_API_KEY}` } : {}),
    },
    body: JSON.stringify(batchRequest),
  });

  if (!r.ok) {
    console.error(`Error: HTTP ${r.status}`);
    console.error(await r.text());
    process.exit(1);
  }

  const result = await r.json();
  console.log('Response:');
  console.log(JSON.stringify(result, null, 2));

  if (result.status === 'pending' && result.batch_id) {
    console.log();
    console.log(`To poll status (no function call — reads blob directly):`);
    console.log(`  cli/status.mjs --batch-id ${result.batch_id}`);
    console.log();
    console.log(`To fetch a result once status=complete:`);
    console.log(`  cli/result.mjs --batch-id ${result.batch_id} --index 0`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
