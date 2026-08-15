#!/usr/bin/env node
// netlify-dashboard-api.mjs — Tool for automating Netlify dashboard operations
// via the internal bb-api (Backend-For-Frontend) using session cookies.
//
// This tool REPLACES manual UI clicks with API calls. It requires a browser
// session (cookies extracted from app.netlify.com) — NOT a PAT.
//
// Auth model:
//   - The bb-api at app.netlify.com/access-control/bb-api/ uses the _nf-auth cookie
//   - WAF test confirmed: NO WAF, NO browser headers needed, NO connect.sid needed
//   - ONLY the _nf-auth cookie (value starts with nfu_) is required for auth
//   - Plain curl with just "Cookie: _nf-auth=nfu_xxx" works for both GET and PUT
//
// Extract from browser:
//   DevTools → Application → Cookies → app.netlify.com → find _nf-auth
//   OR save as a file with one line: "_nf-auth=nfu_xxxxx"
//
// Usage:
//   node tools/netlify-dashboard-api.mjs <command> [args]
//
// Commands:
//   list-accounts                         — List all teams/accounts
//   get-account <account_id>             — Get account details (capabilities, credits, etc.)
//   get-bandwidth <account_id>            — Get bandwidth usage
//   get-build-status <slug|account_id>    — Get build queue status
//   get-usage <site_id>                   — Get site usage breakdown
//   list-sites [slug]                     — List all sites (or sites in a team)
//   get-site <site_id>                    — Get site details
//   get-env <site_id>                     — Get environment variables
//   set-env <site_id> <key> <value>       — Set environment variable
//   disable-sso <site_id>                 — Disable SSO (make URLs public)
//   enable-sso <site_id>                  — Enable SSO (make URLs private)
//   list-build-hooks <site_id>            — List build hooks
//   create-build-hook <site_id> <title> [branch] — Create build hook
//   list-deploys <site_id> [per_page]     — List recent deploys
//   cancel-deploy <deploy_id>              — Cancel a deploy
//   list-functions <site_id>              — List deployed functions
//   get-observability <site_id> [type]    — Get observability data (counts|timeseries)
//   list-snippets <site_id>               — List snippets
//   list-blobs <site_id>                  — List blob stores
//   audit-log <account_id>                — Get account audit log
//   raw <method> <path> [body_json]       — Raw bb-api call (power user)
//
// Environment:
//   NETLIFY_COOKIE_FILE  Path to cookie file (default: /tmp/netlify-cookies.txt)
//   Cookie file format:   Plain text, one "key=value" per line (from browser DevTools)
//
// Examples:
//   # List all accounts
//   node tools/netlify-dashboard-api.mjs list-accounts
//
//   # Disable SSO on a site
//   node tools/netlify-dashboard-api.mjs disable-sso 01c2e47f-3ff6-4e09-b45f-604c49ef90fe
//
//   # Set env var
//   node tools/netlify-dashboard-api.mjs set-env 01c2e47f-3ff6-4e09-b45f-604c49ef90fe SCRAPE_API_KEY mysecret
//
//   # Raw call (any endpoint)
//   node tools/netlify-dashboard-api.mjs raw PUT /sites/01c2e47f-3ff6-4e09-b45f-604c49ef90fe '{"sso_login":false}'

import { readFileSync } from 'node:fs';

const BB_API_BASE = 'https://app.netlify.com/access-control/bb-api/api/v1';

// === Cookie loading ===

function loadCookies() {
  const cookieFile = process.env.NETLIFY_COOKIE_FILE || '/tmp/netlify-cookies.txt';
  let raw;
  try {
    raw = readFileSync(cookieFile, 'utf8').trim();
  } catch (e) {
    console.error(`Error: Cannot read cookie file: ${cookieFile}`);
    console.error('Extract cookies from browser DevTools (Application → Cookies → app.netlify.com)');
    console.error('Save as "key=value" per line, or as a single Cookie: header value.');
    process.exit(1);
  }

  // If it looks like a raw Cookie header value (key=value; key=value), use as-is
  if (raw.includes('=') && !raw.includes('\n')) {
    return raw;
  }

  // If it's multi-line (key=value per line), join with '; '
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines[0].includes('=')) {
    return lines.join('; ');
  }

  // Assume it's already a Cookie header value
  return raw;
}

// === HTTP client ===

async function bbApi(method, path, body = null) {
  const cookie = loadCookies();
  const url = `${BB_API_BASE}${path}`;

  const headers = {
    'Cookie': cookie,
    'Accept': 'application/json',
    'Origin': 'https://app.netlify.com',
    'Referer': 'https://app.netlify.com/',
  };

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const opts = { method, headers };
  if (body !== null) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const r = await fetch(url, opts);
  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: r.status, data, ok: r.ok };
}

// === Commands ===

async function cmdListAccounts() {
  const r = await bbApi('GET', '/accounts');
  if (!r.ok) return printError(r);
  const accounts = Array.isArray(r.data) ? r.data : [r.data];
  console.log(`Accounts (${accounts.length}):`);
  for (const a of accounts) {
    console.log(`  ${a.id} | ${a.name} | type=${a.type_slug} | credits=${a.capabilities?.credits?.used || 0}/${a.plan_credits}`);
  }
}

async function cmdGetAccount(accountId) {
  const r = await bbApi('GET', `/accounts/${accountId}`);
  if (!r.ok) return printError(r);
  const a = r.data;
  console.log(`Account: ${a.name}`);
  console.log(`  ID: ${a.id}`);
  console.log(`  Slug: ${a.slug}`);
  console.log(`  Type: ${a.type_name} (${a.type_slug})`);
  console.log(`  Credits: ${a.capabilities?.credits?.used || 0}/${a.plan_credits}`);
  console.log(`  Sites: ${a.capabilities?.sites?.used || 0}/${a.capabilities?.sites?.included}`);
  console.log(`  Bandwidth: ${a.capabilities ? 'see /bandwidth endpoint' : 'N/A'}`);
  console.log(`  Members: ${a.capabilities?.billable_members?.used || 0}/${a.capabilities?.billable_members?.included}`);
  console.log(`  Concurrent builds: ${a.capabilities?.concurrent_builds?.used || 0}/${a.capabilities?.concurrent_builds?.included}`);
  console.log(`  Domains: ${a.capabilities?.domains?.used || 0}/${a.capabilities?.domains?.included}`);
  console.log(`  SSO: site_sso_login=${a.site_sso_login} context=${a.site_sso_login_context}`);
  console.log(`  Billing period: ${a.current_billing_period_start} → ${a.next_billing_period_start}`);
}

async function cmdGetBandwidth(accountId) {
  const r = await bbApi('GET', `/accounts/${accountId}/bandwidth`);
  if (!r.ok) return printError(r);
  const b = r.data;
  console.log(`Bandwidth usage:`);
  console.log(`  Used: ${(b.used / 1024 / 1024).toFixed(2)} MB (${b.used} bytes)`);
  console.log(`  Included: ${b.included || 'unlimited'}`);
  console.log(`  Additional: ${b.additional}`);
  console.log(`  Last updated: ${b.last_updated_at}`);
  console.log(`  Period: ${b.period_start_date} → ${b.period_end_date}`);
}

async function cmdGetBuildStatus(slugOrId) {
  const r = await bbApi('GET', `/${slugOrId}/builds/status`);
  if (!r.ok) return printError(r);
  const s = r.data;
  console.log(`Build status:`);
  console.log(`  Active: ${s.active}`);
  console.log(`  Enqueued: ${s.enqueued}`);
  console.log(`  Pending concurrency: ${s.pending_concurrency}`);
  console.log(`  Minutes used: ${s.minutes}`);
}

async function cmdGetUsage(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}/usage`);
  if (!r.ok) return printError(r);
  const usage = Array.isArray(r.data) ? r.data : [r.data];
  console.log(`Site usage (${usage.length} entries):`);
  for (const u of usage) {
    console.log(`  ${u.type} | ${u.name} | credit_usage=${u.capabilities?.credit_usage || 0}`);
  }
}

async function cmdListSites(slug) {
  const path = slug ? `/${slug}/sites` : '/sites';
  const r = await bbApi('GET', path);
  if (!r.ok) return printError(r);
  const sites = Array.isArray(r.data) ? r.data : [r.data];
  console.log(`Sites (${sites.length}):`);
  for (const s of sites) {
    console.log(`  ${s.id} | ${s.name} | state=${s.state} | ssl=${s.ssl_url}`);
  }
}

async function cmdGetSite(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}`);
  if (!r.ok) return printError(r);
  const s = r.data;
  console.log(`Site: ${s.name}`);
  console.log(`  ID: ${s.id}`);
  console.log(`  URL: ${s.ssl_url}`);
  console.log(`  Admin: ${s.admin_url}`);
  console.log(`  State: ${s.state}`);
  console.log(`  SSO: login=${s.sso_login} context=${s.sso_login_context}`);
  console.log(`  Account SSO: login=${s.account_sso_login} context=${s.account_sso_login_context}`);
  console.log(`  Password: ${s.has_password} context=${s.password_context}`);
  console.log(`  Functions region: ${s.functions_region}`);
  console.log(`  Build image: ${s.build_image}`);
  console.log(`  Build limit: ${s.build_timelimit}`);
}

async function cmdGetEnv(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}/env`);
  if (!r.ok) return printError(r);
  const vars = Array.isArray(r.data) ? r.data : [r.data];
  console.log(`Environment variables (${vars.length}):`);
  for (const v of vars) {
    const val = v.value || '[encrypted]';
    console.log(`  ${v.key} = ${val.substring(0, 50)}${val.length > 50 ? '...' : ''} (context: ${v.contexts?.join(',') || 'all'})`);
  }
}

async function cmdSetEnv(siteId, key, value) {
  // The bb-api env endpoint isn't well-documented — try the PUT /sites/{id}/env/{key} pattern
  const r = await bbApi('PUT', `/sites/${siteId}/env/${key}`, {
    key,
    context: 'all',
    values: { 'production': value, 'deploy-preview': value },
    value,
  });
  if (r.ok) {
    console.log(`✓ Set ${key}=${value.substring(0, 30)}... on site ${siteId}`);
  } else {
    // Fallback: use the Netlify CLI env:set which works via a different mechanism
    console.error(`bb-api env set failed (${r.status}). Use: netlify env:set ${key} ${value}`);
    console.error('Response:', JSON.stringify(r.data).substring(0, 200));
  }
}

async function cmdDisableSso(siteId) {
  const r = await bbApi('PUT', `/sites/${siteId}`, {
    password: '',
    password_context: 'all',
    sso_login: false,
    sso_login_context: 'all',
  });
  if (!r.ok) return printError(r);
  console.log(`✓ SSO disabled on site ${siteId}`);
  console.log(`  sso_login: ${r.data.sso_login}`);
  console.log(`  account_sso_login: ${r.data.account_sso_login}`);
  console.log(`  has_password: ${r.data.has_password}`);
}

async function cmdEnableSso(siteId) {
  const r = await bbApi('PUT', `/sites/${siteId}`, {
    password: '',
    password_context: 'all',
    sso_login: true,
    sso_login_context: 'all',
  });
  if (!r.ok) return printError(r);
  console.log(`✓ SSO enabled on site ${siteId}`);
  console.log(`  sso_login: ${r.data.sso_login}`);
}

async function cmdListBuildHooks(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}/build_hooks`);
  if (!r.ok) return printError(r);
  const hooks = Array.isArray(r.data) ? r.data : [];
  console.log(`Build hooks (${hooks.length}):`);
  for (const h of hooks) {
    console.log(`  ${h.id} | ${h.title || '(no title)'} | branch=${h.branch} | url=${h.url}`);
  }
}

async function cmdCreateBuildHook(siteId, title, branch = 'main') {
  const r = await bbApi('POST', `/sites/${siteId}/build_hooks`, { title, branch });
  if (!r.ok) return printError(r);
  console.log(`✓ Build hook created:`);
  console.log(`  ID: ${r.data.id}`);
  console.log(`  Title: ${r.data.title}`);
  console.log(`  URL: ${r.data.url}`);
  console.log(`  Branch: ${r.data.branch}`);
}

async function cmdListDeploys(siteId, perPage = 10) {
  const r = await bbApi('GET', `/sites/${siteId}/deploys?per_page=${perPage}`);
  if (!r.ok) return printError(r);
  const deploys = Array.isArray(r.data) ? r.data : [];
  console.log(`Deploys (${deploys.length}):`);
  for (const d of deploys) {
    console.log(`  ${d.id} | ${d.state} | ${d.context} | ${d.deploy_time}s | ${d.title || '(no title)'}`);
  }
}

async function cmdCancelDeploy(deployId) {
  const r = await bbApi('POST', `/deploys/${deployId}/cancel`);
  if (!r.ok) return printError(r);
  console.log(`✓ Deploy ${deployId} cancelled`);
  console.log(`  State: ${r.data.state}`);
  console.log(`  Error: ${r.data.error_message}`);
}

async function cmdListFunctions(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}/functions`);
  if (!r.ok) return printError(r);
  const data = r.data;
  if (data.functions) {
    console.log(`Functions (${data.functions.length}):`);
    for (const f of data.functions) {
      console.log(`  ${f.n} | mem=${f.m}MB | region=${f.rg} | runtime=${f.r} | schedule=${f.schedule || 'none'}`);
    }
  } else {
    console.log('No functions deployed on this site.');
  }
}

async function cmdGetObservability(siteId, type = 'counts') {
  const now = Date.now();
  const past = now - 3600000; // last hour
  const body = type === 'counts' ? {
    data: [{
      attributes: {
        queries: [
          { name: 'status_codes', filters: [{ field: 'Branch', op: '=', value: 'main' }] },
          { name: 'methods', filters: [{ field: 'Branch', op: '=', value: 'main' }] },
          { name: 'content_types', filters: [{ field: 'Branch', op: '=', value: 'main' }] },
        ]
      }
    }]
  } : {
    data: [{
      attributes: {
        queries: [
          { name: 'edge_requests_count', filters: [{ field: 'Branch', op: '=', value: 'main' }] },
          { name: 'edge_requests_bandwidth', filters: [{ field: 'Branch', op: '=', value: 'main' }] },
        ]
      }
    }]
  };

  const r = await bbApi('POST', `/sites/${siteId}/observability/query/${type}?from_ts=${past}&to_ts=${now}${type === 'timeseries' ? '&interval=60000' : ''}`, body);
  if (!r.ok) return printError(r);
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdListSnippets(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}/snippets`);
  if (!r.ok) return printError(r);
  const snippets = Array.isArray(r.data) ? r.data : [];
  console.log(`Snippets (${snippets.length}):`);
  for (const s of snippets) {
    console.log(`  ${s.id} | ${s.title || '(no title)'} | position=${s.general_position}`);
  }
}

async function cmdListBlobs(siteId) {
  const r = await bbApi('GET', `/sites/${siteId}/blobs`);
  if (!r.ok) return printError(r);
  console.log(`Blob stores:`);
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdAuditLog(accountId) {
  const r = await bbApi('GET', `/accounts/${accountId}/audit`);
  if (!r.ok) return printError(r);
  const entries = Array.isArray(r.data) ? r.data : [];
  console.log(`Audit log (${entries.length} entries):`);
  for (const e of entries) {
    console.log(`  ${e.created_at} | ${e.actor?.email || 'system'} | ${e.action} | ${e.resource_type}:${e.resource_id}`);
  }
}

async function cmdRaw(method, path, bodyJson) {
  let body = null;
  if (bodyJson) {
    try { body = JSON.parse(bodyJson); } catch { body = bodyJson; }
  }
  const r = await bbApi(method.toUpperCase(), path, body);
  console.log(`HTTP ${r.status}`);
  if (typeof r.data === 'string') {
    console.log(r.data);
  } else {
    console.log(JSON.stringify(r.data, null, 2));
  }
}

function printError(r) {
  console.error(`Error: HTTP ${r.status}`);
  if (typeof r.data === 'object') {
    console.error(JSON.stringify(r.data, null, 2));
  } else {
    console.error(r.data);
  }
  if (r.status === 401) {
    console.error('\nCookies may be expired. Re-extract from browser DevTools:');
    console.error('  Application → Cookies → app.netlify.com → copy all key=value pairs');
  }
}

// === Main ===

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  'list-accounts': () => cmdListAccounts(),
  'get-account': () => cmdGetAccount(args[0]),
  'get-bandwidth': () => cmdGetBandwidth(args[0]),
  'get-build-status': () => cmdGetBuildStatus(args[0]),
  'get-usage': () => cmdGetUsage(args[0]),
  'list-sites': () => cmdListSites(args[0]),
  'get-site': () => cmdGetSite(args[0]),
  'get-env': () => cmdGetEnv(args[0]),
  'set-env': () => cmdSetEnv(args[0], args[1], args[2]),
  'disable-sso': () => cmdDisableSso(args[0]),
  'enable-sso': () => cmdEnableSso(args[0]),
  'list-build-hooks': () => cmdListBuildHooks(args[0]),
  'create-build-hook': () => cmdCreateBuildHook(args[0], args[1], args[2]),
  'list-deploys': () => cmdListDeploys(args[0], parseInt(args[1]) || 10),
  'cancel-deploy': () => cmdCancelDeploy(args[0]),
  'list-functions': () => cmdListFunctions(args[0]),
  'get-observability': () => cmdGetObservability(args[0], args[1] || 'counts'),
  'list-snippets': () => cmdListSnippets(args[0]),
  'list-blobs': () => cmdListBlobs(args[0]),
  'audit-log': () => cmdAuditLog(args[0]),
  'raw': () => cmdRaw(args[0], args[1], args[2]),
};

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`Usage: node tools/netlify-dashboard-api.mjs <command> [args]

Commands:
  list-accounts                          List all teams/accounts
  get-account <account_id>               Get account details (capabilities, credits)
  get-bandwidth <account_id>             Get bandwidth usage
  get-build-status <slug|account_id>     Get build queue status
  get-usage <site_id>                    Get site usage breakdown
  list-sites [slug]                      List all sites (or sites in a team)
  get-site <site_id>                     Get site details
  get-env <site_id>                     Get environment variables
  set-env <site_id> <key> <value>       Set environment variable
  disable-sso <site_id>                 Disable SSO (make URLs public)
  enable-sso <site_id>                  Enable SSO (make URLs private)
  list-build-hooks <site_id>            List build hooks
  create-build-hook <site_id> <title> [branch]  Create build hook
  list-deploys <site_id> [per_page]     List recent deploys
  cancel-deploy <deploy_id>             Cancel a deploy
  list-functions <site_id>             List deployed functions
  get-observability <site_id> [type]   Get observability (counts|timeseries)
  list-snippets <site_id>              List snippets
  list-blobs <site_id>                 List blob stores
  audit-log <account_id>               Get account audit log
  raw <method> <path> [body_json]      Raw bb-api call (power user)

Environment:
  NETLIFY_COOKIE_FILE  Path to cookie file (default: /tmp/netlify-cookies.txt)
  Cookie file format:   "key=value" per line from browser DevTools

Auth:
  Requires ONLY the _nf-auth cookie from app.netlify.com (NOT a PAT, NOT a browser).
  WAF tested: plain curl works with just "Cookie: _nf-auth=nfu_xxx".
  Extract: browser DevTools → Application → Cookies → app.netlify.com → find _nf-auth`);
  process.exit(0);
}

const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

fn().catch(e => { console.error(e); process.exit(1); });
