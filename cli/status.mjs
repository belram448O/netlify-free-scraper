#!/usr/bin/env node
// CLI: Poll batch status (reads blob directly, ZERO function invocations)
//
// Usage:
//   cli/status.mjs --batch-id <id> [--wait] [--interval 5] [--timeout 600]
//
// Environment:
//   NETLIFY_AUTH_TOKEN    PAT with blob read access
//   NETLIFY_SITE_ID       Site ID

function parseArgs(argv) {
  const args = { wait: false, interval: 5, timeout: 600 };
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
      case '--batch-id': args.batch_id = next(); break;
      case '--wait': args.wait = true; break;
      case '--interval': {
        const v = parseInt(next(), 10);
        if (!Number.isFinite(v) || v < 1) {
          console.error('Error: --interval must be a positive integer (seconds)');
          process.exit(1);
        }
        args.interval = v;
        break;
      }
      case '--timeout': {
        const v = parseInt(next(), 10);
        if (!Number.isFinite(v) || v < 1) {
          console.error('Error: --timeout must be a positive integer (seconds)');
          process.exit(1);
        }
        args.timeout = v;
        break;
      }
      case '--help': case '-h':
        console.log(`Usage: cli/status.mjs --batch-id <id> [--wait] [--interval 5] [--timeout 600]

Reads batch status directly from Netlify Blobs — zero function invocations.

Options:
  --batch-id <id>     Batch ID to poll (required)
  --wait              Poll until terminal status (complete | failed | error | skipped)
  --interval <s>      Poll interval in seconds (default: 5)
  --timeout <s>       Max wait time in seconds (default: 600 = 10 min)

Environment:
  NETLIFY_AUTH_TOKEN  PAT with blob read access
  NETLIFY_SITE_ID     Site ID`);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

async function fetchStatus(token, siteId, batchId) {
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/site:scraper-results/status/${batchId}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.batch_id) {
    console.error('Error: --batch-id is required');
    process.exit(1);
  }

  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) {
    console.error('Error: NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID env vars required');
    process.exit(1);
  }

  if (!args.wait) {
    const status = await fetchStatus(token, siteId, args.batch_id);
    if (!status) {
      console.error(`Batch not found: ${args.batch_id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Wait mode — poll until terminal, with backoff
  const startTime = Date.now();
  const timeoutMs = args.timeout * 1000;
  const initialIntervalMs = args.interval * 1000;
  let lastStatus = null;
  let pollCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    const status = await fetchStatus(token, siteId, args.batch_id);
    if (!status) {
      console.error(`Batch not found: ${args.batch_id}`);
      process.exit(1);
    }
    if (!lastStatus || status.status !== lastStatus.status || status.updated_at !== lastStatus.updated_at) {
      console.log(`[${new Date().toISOString()}] status=${status.status} updated=${status.updated_at}`);
      if (status.succeeded !== undefined) {
        console.log(`  succeeded=${status.succeeded} failed=${status.failed} skipped=${status.skipped || 0} elapsed=${status.elapsed_ms || 0}ms`);
      }
      lastStatus = status;
    }
    if (['complete', 'failed', 'error', 'skipped'].includes(status.status)) {
      console.log();
      console.log('Final status:');
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    pollCount++;
    // Backoff: first 10 polls at interval, then double every 5 polls up to 30s
    let currentInterval = initialIntervalMs;
    if (pollCount > 10) {
      const backoffFactor = Math.pow(2, Math.floor((pollCount - 10) / 5));
      currentInterval = Math.min(initialIntervalMs * backoffFactor, 30_000);
    }
    await new Promise(r => setTimeout(r, currentInterval));
  }

  console.error(`Timeout after ${args.timeout}s. Last status: ${lastStatus?.status || 'unknown'}`);
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
