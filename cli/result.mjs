#!/usr/bin/env node
// CLI: Retrieve a batch result (reads blob directly, ZERO function invocations)
//
// Usage:
//   cli/result.mjs --batch-id <id> --index <n> [--output <file>]
//   cli/result.mjs --batch-id <id> --list
//
// Examples:
//   cli/result.mjs --batch-id batch-1786749000-abc --index 0
//   cli/result.mjs --batch-id batch-1786749000-abc --index 0 --output result.html
//   cli/result.mjs --batch-id batch-1786749000-abc --list
//
// Environment:
//   NETLIFY_AUTH_TOKEN    PAT with blob read access
//   NETLIFY_SITE_ID       Site ID

function parseArgs(argv) {
  const args = { list: false };
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
      case '--index': {
        const v = parseInt(next());
        if (!Number.isFinite(v) || v < 0) {
          console.error('Error: --index must be a non-negative integer');
          process.exit(1);
        }
        args.index = v;
        break;
      }
      case '--output': args.output = next(); break;
      case '--list': args.list = true; break;
      case '--help': case '-h':
        console.log(`Usage: cli/result.mjs --batch-id <id> --index <n> [--output <file>]
       cli/result.mjs --batch-id <id> --list

Reads batch results directly from Netlify Blobs — zero function invocations.

Options:
  --batch-id <id>    Batch ID (required)
  --index <n>        Job index within batch (0-based)
  --output <file>    Write result to file (default: stdout)
  --list             List all result blobs in the batch

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

  if (args.list) {
    // List result blobs for this batch (use prefix filter for efficiency)
    const prefix = `result/${args.batch_id}-`;
    const url = `https://api.netlify.com/api/v1/blobs/${siteId}/site:scraper-results?prefix=${encodeURIComponent(prefix)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const results = (data.blobs || [])
      .filter(b => b.key.startsWith(prefix))
      .sort((a, b) => {
        const ai = parseInt(a.key.substring(prefix.length));
        const bi = parseInt(b.key.substring(prefix.length));
        return ai - bi;
      });
    console.log(`Results in batch ${args.batch_id}: ${results.length}`);
    for (const r of results) {
      const index = parseInt(r.key.substring(prefix.length));
      console.log(`  [${index}] ${r.key} | ${r.size} bytes | modified=${r.last_modified}`);
    }
    return;
  }

  if (args.index === undefined) {
    console.error('Error: --index is required (or use --list)');
    process.exit(1);
  }

  const blobKey = `result/${args.batch_id}-${args.index}`;
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/site:scraper-results/${blobKey}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) {
    console.error(`Result not found: ${blobKey}`);
    console.error(`Is the batch complete? Check with: cli/status.mjs --batch-id ${args.batch_id}`);
    process.exit(1);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);

  const buf = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get('content-type') || 'application/octet-stream';

  if (args.output) {
    const fs = await import('node:fs');
    fs.writeFileSync(args.output, buf);
    console.error(`Wrote ${buf.length} bytes to ${args.output} (content-type: ${contentType})`);
  } else {
    process.stdout.write(buf);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
