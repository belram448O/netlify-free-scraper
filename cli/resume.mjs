#!/usr/bin/env node
// CLI: Resume incomplete batches (reads blobs directly, zero function invocations)
//
// Usage:
//   cli/resume.mjs                    — Check for and resume incomplete batches
//   cli/resume.mjs --dry-run          — Check only, don't modify anything
//   cli/resume.mjs --batch-id <id>    — Force-resume a specific batch
//
// This checks for:
//   - Batches stuck in 'running' state (>10 min stale) — requeues if queue entry exists
//   - Batches in 'pending' state without queue entries — marks as orphaned/error
//   - Batches in 'partial' state with skipped jobs and queue entries — requeues
//
// Environment:
//   NETLIFY_AUTH_TOKEN    PAT with blob read/write access
//   NETLIFY_SITE_ID       Site ID

import { resumeIncompleteBatches, getStore, setBatchStatus, STORE_NAME, STALE_RUNNING_MS } from '../lib/scraper.mjs';

function parseArgs(argv) {
  const args = { dry_run: false, batch_id: null };
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
      case '--dry-run': args.dry_run = true; break;
      case '--batch-id': args.batch_id = next(); break;
      case '--help': case '-h':
        console.log(`Usage: cli/resume.mjs [--dry-run] [--batch-id <id>]

Checks for and resumes incomplete batches. Reads/writes Blobs directly — zero function invocations.

What it does:
  1. Finds batches stuck in 'running' state (>10 min stale) — if queue entry exists, resets to 'pending'
  2. Finds orphaned batches (status=pending but no queue entry) — marks as 'error'
  3. Finds partial batches with skipped jobs + queue entry — resets to 'pending'

Options:
  --dry-run            Check only, don't modify anything. Shows what WOULD be resumed.
  --batch-id <id>      Force-resume a specific batch (regardless of age/status)

Environment:
  NETLIFY_AUTH_TOKEN   PAT with blob read/write access
  NETLIFY_SITE_ID      Site ID

Note: This command writes to Blobs directly (using the Netlify public API with PAT).
      It does NOT call the function — zero compute cost.
      The actual reprocessing happens on the next build (netlify deploy).`);
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

  if (args.dry_run) {
    console.log('=== Dry run — checking for incomplete batches ===\n');
  } else {
    console.log('=== Resuming incomplete batches ===\n');
  }

  // For dry-run, we need to replicate the check without writing
  // Use the shared resume function (it writes) or do a read-only check
  if (args.dry_run) {
    // Read-only check via public API
    const url = `https://api.netlify.com/api/v1/blobs/${siteId}/site:${STORE_NAME}?prefix=status/`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { console.error(`Error: HTTP ${r.status}`); process.exit(1); }
    const data = await r.json();
    const statusBlobs = data.blobs || [];

    // Also check queue entries
    const queueUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/site:${STORE_NAME}?prefix=queue/pending/`;
    const qr = await fetch(queueUrl, { headers: { Authorization: `Bearer ${token}` } });
    const qData = await qr.json();
    const queueKeys = new Set((qData.blobs || []).map(b => b.key));

    const now = Date.now();
    const resumeable = [];
    const orphaned = [];

    for (const sb of statusBlobs) {
      const sUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/site:${STORE_NAME}/${sb.key}`;
      const sr = await fetch(sUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!sr.ok) continue;
      const status = await sr.json();
      if (!status?.batch_id) continue;

      const batchId = status.batch_id;
      const queueKey = `queue/pending/${batchId}`;
      const hasQueueEntry = queueKeys.has(queueKey);
      const ageMs = now - (status.updated_at ? new Date(status.updated_at).getTime() : 0);

      if (status.status === 'running' && ageMs > STALE_RUNNING_MS) {
        if (hasQueueEntry) {
          resumeable.push({ batch_id: batchId, reason: 'stale_running_with_queue', age_s: Math.round(ageMs / 1000) });
        } else {
          orphaned.push({ batch_id: batchId, reason: 'stale_running_no_queue', age_s: Math.round(ageMs / 1000) });
        }
      }
      if (status.status === 'pending' && !hasQueueEntry) {
        orphaned.push({ batch_id: batchId, reason: 'pending_no_queue', age_s: Math.round(ageMs / 1000) });
      }
      if (status.status === 'partial' && hasQueueEntry && status.skipped > 0) {
        resumeable.push({ batch_id: batchId, reason: 'partial_with_skipped', age_s: Math.round(ageMs / 1000) });
      }
    }

    console.log(`Checked ${statusBlobs.length} batch status blobs.\n`);
    if (resumeable.length > 0) {
      console.log(`WOULD REQUEUE (${resumeable.length}):`);
      for (const r of resumeable) {
        console.log(`  ${r.batch_id} | reason: ${r.reason} | age: ${r.age_s}s`);
      }
    }
    if (orphaned.length > 0) {
      console.log(`\nWOULD MARK AS ERROR (${orphaned.length}):`);
      for (const o of orphaned) {
        console.log(`  ${o.batch_id} | reason: ${o.reason} | age: ${o.age_s}s`);
      }
    }
    if (resumeable.length === 0 && orphaned.length === 0) {
      console.log('No incomplete batches found.');
    }
    console.log(`\nNote: This was a dry run. Run without --dry-run to actually resume.`);
    console.log(`After resuming, trigger a build to process: netlify deploy`);
    return;
  }

  // Actual resume — calls the shared library function
  const result = await resumeIncompleteBatches();

  console.log(`Checked ${result.total_checked} batch status blobs.\n`);

  if (result.requeued.length > 0) {
    console.log(`REQUEUED (${result.requeued.length}):`);
    for (const r of result.requeued) {
      console.log(`  ${r.batch_id} | reason: ${r.reason} | age: ${Math.round(r.age_ms / 1000)}s`);
    }
  }
  if (result.orphaned.length > 0) {
    console.log(`\nMARKED AS ERROR (${result.orphaned.length}):`);
    for (const o of result.orphaned) {
      console.log(`  ${o.batch_id} | reason: ${o.reason}`);
    }
  }
  if (result.requeued.length === 0 && result.orphaned.length === 0) {
    console.log('No incomplete batches found.');
  }

  console.log(`\n${result.requeued.length} batch(es) requeued. Trigger a build to process them:`);
  console.log(`  netlify deploy --message "process resumed batches"`);
}

main().catch(e => { console.error(e); process.exit(1); });
