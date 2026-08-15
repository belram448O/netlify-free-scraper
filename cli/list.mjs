#!/usr/bin/env node
// CLI: List recent batches (reads blobs directly, zero function invocations)
//
// Usage:
//   cli/list.mjs [--status pending|running|complete|partial|failed|error] [--limit 20]
//
// Environment:
//   NETLIFY_AUTH_TOKEN    PAT with blob read access
//   NETLIFY_SITE_ID       Site ID

function parseArgs(argv) {
  const args = { limit: 20 };
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
      case '--status': args.status = next(); break;
      case '--limit': {
        const v = parseInt(next(), 10);
        if (!Number.isFinite(v) || v < 1) {
          console.error('Error: --limit must be a positive integer');
          process.exit(1);
        }
        args.limit = v;
        break;
      }
      case '--help': case '-h':
        console.log(`Usage: cli/list.mjs [--status <status>] [--limit <n>]

Lists recent batches by reading status blobs directly — zero function invocations.

Options:
  --status <status>  Filter by status: pending | running | complete | partial | failed | error
  --limit <n>        Max batches to return (default: 20)

Environment:
  NETLIFY_AUTH_TOKEN  PAT with blob read access
  NETLIFY_SITE_ID      Site ID`);
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

  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) {
    console.error('Error: NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID env vars required');
    process.exit(1);
  }

  // List status blobs (use prefix filter)
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/site:scraper-results?prefix=${encodeURIComponent('status/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();

  // Sort by last_modified desc, limit
  const statusBlobs = (data.blobs || [])
    .sort((a, b) => (b.last_modified || '').localeCompare(a.last_modified || ''))
    .slice(0, args.limit);

  // Fetch each status in parallel (bounded)
  const batchSize = 5;
  const batches = [];
  for (let i = 0; i < statusBlobs.length; i += batchSize) {
    const chunk = statusBlobs.slice(i, i + batchSize);
    const promises = chunk.map(async (b) => {
      const statusUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/site:scraper-results/${b.key}`;
      const sr = await fetch(statusUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (sr.ok) return await sr.json();
      return null;
    });
    const results = await Promise.all(promises);
    for (const s of results) {
      if (s && (!args.status || s.status === args.status)) {
        batches.push(s);
      }
    }
  }

  console.log(`Batches (${batches.length}${args.status ? ` with status=${args.status}` : ''}):`);
  console.log();
  for (const s of batches) {
    const batchId = s.batch_id || 'unknown';
    const status = s.status || 'unknown';
    const jobs = s.job_count || 0;
    const succeeded = s.succeeded !== undefined ? s.succeeded : '?';
    const failed = s.failed !== undefined ? s.failed : '?';
    const elapsed = s.elapsed_ms ? `${(s.elapsed_ms / 1000).toFixed(1)}s` : '-';
    const updated = s.updated_at || s.created_at || 'unknown';
    console.log(`  ${batchId} | ${status.padEnd(8)} | jobs=${jobs} ok=${succeeded} fail=${failed} | elapsed=${elapsed} | updated=${updated}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
