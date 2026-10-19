#!/usr/bin/env node

/**
 * Backfill editor usernames, IPs and the anonymous flag for past edits (issue #25).
 *
 * IMPORTANT: This script runs on the user's Mac with modern Node (global fetch available).
 * It does NOT run on the bot droplet (host Node v12).
 *
 * The cleanup in #19 erased temporary-account names ("~2026-...") from past rows, and
 * older anonymous rows never stored a name or IP at all. Wikipedia still knows who made
 * every revision, so this script reads every row of wikipedia_edits, takes the revision
 * id from its diff_url, asks that wiki's API who made the revision, and fills:
 *
 *   editor          the username exactly as Wikipedia gives it
 *   ip              the username when it is an IP address, otherwise null
 *   anonymous       true when the username is an IP address or a temporary account
 *   editor_country  looked up from the IP via MaxMind, only where it is missing
 *
 * Rows whose user Wikipedia hides (revision deleted) or whose revision is gone are left
 * unchanged and listed.
 *
 * The script never writes to the database. The bot's key has no UPDATE on this table on
 * purpose, so --sql writes a file of UPDATE statements (by id, changed rows only) that
 * Finn pastes into the Supabase SQL editor. Each statement sets fixed values, so running
 * the file twice is harmless, and a fresh dry run afterwards reports nothing to change.
 *
 * Run it only after the #22 migration, the site change and the #24 bot change are live.
 *
 * Usage:
 *   set -a && source .env && set +a && node scripts/backfill-editors.js                  (dry run)
 *   set -a && source .env && set +a && node scripts/backfill-editors.js --sql out.sql
 *
 * Flags:
 *   --dry-run    Read everything and print what would change (default)
 *   --sql FILE   Also write the UPDATE statements to FILE for the SQL editor
 *   --sample N   How many example changes to print (default 20)
 *
 * Environment variables required (always, since even a dry run reads the table; the
 * secret key is used only to read):
 *   SUPABASE_URL        - Supabase project URL (e.g., https://xyz.supabase.co)
 *   SUPABASE_SECRET_KEY - the sfedits project's secret key (sb_secret_...)
 */

const net = require('net');

// Wikimedia asks API clients to identify themselves:
// https://meta.wikimedia.org/wiki/User-Agent_policy
const USER_AGENT = 'sfedits-backfill-editors/1.0 (https://github.com/mrfinnsmith/sfedits; issue #25)';

// The API accepts up to 50 revids per request for normal clients.
const REVIDS_PER_REQUEST = 50;

// Pause between Wikipedia API requests. Requests are also made one at a time.
const WIKI_REQUEST_DELAY_MS = 500;

// Rows read from Supabase per page.
const SUPABASE_PAGE_SIZE = 1000;

// Since January 2026 Wikipedia shows logged-out editors as temporary accounts
// ("~2026-42504-55"). Some wikis, such as Czech Wikipedia, use a shorter form
// with only one dash group ("~2026-67040"). Same pattern lib/editor-identity.js
// uses. Kept local rather than imported because #24 may move that rule into an
// exported helper.
const TEMPORARY_ACCOUNT_PATTERN = /^~\d{4}-\d+(-\d+)?$/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * True when the username is an IPv4 or IPv6 address.
 */
function isIpAddress(name) {
  return typeof name === 'string' && net.isIP(name) !== 0;
}

/**
 * The bot's anonymous rule: the username is an IP address or a temporary-account name.
 */
function isAnonymousName(name) {
  return isIpAddress(name) || (typeof name === 'string' && TEMPORARY_ACCOUNT_PATTERN.test(name));
}

/**
 * Revision id from a diff URL the bot wrote. Handles:
 *   https://en.wikipedia.org/w/index.php?diff=1372098397&oldid=1372098328   -> 1372098397
 *   https://en.wikipedia.org/w/index.php?title=Cat&diff=123&oldid=456       -> 123
 *   https://en.wikipedia.org/w/index.php?diff=prev&oldid=123                -> 123
 *   https://en.wikipedia.org/w/index.php?oldid=123&rcid=456  (new page)     -> 123
 *   https://en.wikipedia.org/wiki/Special:Diff/123                           -> 123
 *   https://en.wikipedia.org/diff/123                                        -> 123
 * Returns null when no revision id can be found.
 */
function revidFromDiffUrl(diffUrl) {
  let url;
  try {
    url = new URL(diffUrl);
  } catch {
    return null;
  }

  const isNumber = v => typeof v === 'string' && /^\d+$/.test(v);
  const diff = url.searchParams.get('diff');
  const oldid = url.searchParams.get('oldid');

  if (isNumber(diff)) return Number(diff);
  // diff=prev (or no diff at all) means the revision shown is oldid itself.
  if ((diff === null || diff === 'prev') && isNumber(oldid)) return Number(oldid);

  const pathMatch = decodeURIComponent(url.pathname).match(/\/(?:wiki\/Special:Diff|diff)\/(?:\d+\/)?(\d+)$/);
  if (pathMatch) return Number(pathMatch[1]);

  return null;
}

/**
 * API endpoint for the wiki a diff URL belongs to, e.g. https://en.wikipedia.org/w/api.php.
 * Taken from the URL's own host so wikis like simple.wikipedia.org work unchanged.
 */
function apiUrlForDiffUrl(diffUrl) {
  try {
    const url = new URL(diffUrl);
    return `${url.protocol}//${url.host}/w/api.php`;
  } catch {
    return null;
  }
}

/**
 * Parse one prop=revisions response (formatversion=2) into a Map of revid -> info:
 *   { user: 'Name' }      the revision's username
 *   { hidden: true }      Wikipedia hides the user (revision deletion)
 *   { missing: true }     the revision does not exist or its page was deleted
 */
function parseRevisionsResponse(data) {
  const result = new Map();
  const query = (data && data.query) || {};

  for (const page of query.pages || []) {
    for (const rev of page.revisions || []) {
      if (!rev.userhidden && typeof rev.user === 'string') {
        result.set(rev.revid, { user: rev.user });
      } else {
        // userhidden, or no user for any other reason: never guess a name.
        result.set(rev.revid, { hidden: true });
      }
    }
  }

  // formatversion=2 gives badrevids as an object keyed by revid; tolerate an array too.
  const bad = query.badrevids || {};
  for (const entry of Array.isArray(bad) ? bad : Object.values(bad)) {
    if (entry && entry.revid !== undefined) {
      result.set(Number(entry.revid), { missing: true });
    }
  }

  return result;
}

/**
 * Ask one wiki who made each of the given revisions, 50 at a time, one request at a time.
 * Returns a Map of revid -> info (see parseRevisionsResponse). Revids the API did not
 * mention at all come back as { missing: true }.
 */
async function fetchRevisionUsers(apiUrl, revids, { fetchImpl = fetch, delayMs = WIKI_REQUEST_DELAY_MS } = {}) {
  const result = new Map();

  for (let i = 0; i < revids.length; i += REVIDS_PER_REQUEST) {
    const chunk = revids.slice(i, i + REVIDS_PER_REQUEST);
    const url = new URL(apiUrl);
    url.searchParams.set('action', 'query');
    url.searchParams.set('prop', 'revisions');
    url.searchParams.set('revids', chunk.join('|'));
    url.searchParams.set('rvprop', 'user|ids');
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    url.searchParams.set('maxlag', '5');

    let data = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await fetchImpl(url.toString(), {
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 4) {
        await sleep(delayMs * 4 * attempt);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Wikipedia API ${apiUrl} returned ${response.status}`);
      }
      data = await response.json();
      if (data && data.error && data.error.code === 'maxlag' && attempt < 4) {
        await sleep(5000);
        continue;
      }
      if (data && data.error) {
        throw new Error(`Wikipedia API ${apiUrl} error: ${data.error.code} ${data.error.info || ''}`);
      }
      break;
    }

    for (const [revid, info] of parseRevisionsResponse(data)) {
      result.set(revid, info);
    }
    for (const revid of chunk) {
      if (!result.has(revid)) result.set(revid, { missing: true });
    }

    if (i + REVIDS_PER_REQUEST < revids.length) await sleep(delayMs);
  }

  return result;
}

/**
 * Work out what one row should become.
 *
 * row:      { id, diff_url, editor, ip, anonymous, editor_country }
 * info:     what Wikipedia said about the revision (see parseRevisionsResponse), or undefined
 * lookupCountry: async ip -> two-letter code or null
 *
 * Returns { status, patch, kinds } where status is one of:
 *   'unparseable' no revision id in diff_url, row unchanged
 *   'hidden'      Wikipedia hides the user, row unchanged
 *   'missing'     revision not found, row unchanged
 *   'unchanged'   already correct
 *   'change'      patch holds only the columns that differ; kinds names them
 */
async function deriveUpdate(row, info, lookupCountry) {
  if (!info) return { status: 'unparseable', patch: null, kinds: [] };
  if (info.hidden) return { status: 'hidden', patch: null, kinds: [] };
  if (info.missing) return { status: 'missing', patch: null, kinds: [] };

  const user = info.user;
  const ip = isIpAddress(user) ? user : null;
  const target = {
    editor: user,
    ip,
    anonymous: isAnonymousName(user),
  };

  // Country only where it is missing: the value stored at post time came from the
  // MaxMind data of that day, which is closer to the edit than today's data.
  if (ip && !row.editor_country) {
    const country = await lookupCountry(ip);
    if (country) target.editor_country = country;
  }

  const patch = {};
  const kinds = [];

  if (row.editor !== target.editor) {
    patch.editor = target.editor;
    kinds.push(row.editor == null ? 'editor filled' : 'editor changed');
  }
  if ((row.ip == null ? null : row.ip) !== target.ip) {
    patch.ip = target.ip;
    kinds.push(target.ip == null ? 'ip cleared' : (row.ip == null ? 'ip filled' : 'ip changed'));
  }
  if (row.anonymous !== target.anonymous) {
    patch.anonymous = target.anonymous;
    kinds.push(row.anonymous == null ? 'anonymous filled' : `anonymous ${row.anonymous} -> ${target.anonymous}`);
  }
  if (target.editor_country !== undefined && row.editor_country !== target.editor_country) {
    patch.editor_country = target.editor_country;
    kinds.push('country filled');
  }

  if (kinds.length === 0) return { status: 'unchanged', patch: null, kinds };
  return { status: 'change', patch, kinds };
}

function supabaseHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

/**
 * Read every row, keyset-paginated on id so a server-side row cap cannot end the
 * loop early.
 */
async function fetchAllRows(supabaseUrl, key, { fetchImpl = fetch, pageSize = SUPABASE_PAGE_SIZE } = {}) {
  const rows = [];
  let lastId = null;

  for (;;) {
    const url = new URL(`${supabaseUrl}/rest/v1/wikipedia_edits`);
    url.searchParams.set('select', 'id,diff_url,lang,editor,ip,anonymous,editor_country');
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(pageSize));
    if (lastId !== null) url.searchParams.set('id', `gt.${lastId}`);

    const response = await fetchImpl(url.toString(), { headers: supabaseHeaders(key) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Supabase read failed: ${response.status} ${detail.slice(0, 300)}`);
    }
    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) break;

    rows.push(...page);
    lastId = page[page.length - 1].id;
  }

  return rows;
}

/**
 * A SQL literal for a value going into an UPDATE. Strings are single-quoted with
 * embedded quotes doubled (standard_conforming_strings is on in Postgres, so a
 * backslash is an ordinary character). Usernames can contain any character.
 */
function sqlLiteral(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new Error('string contains a NUL byte');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new Error(`cannot write ${typeof value} as SQL`);
}

/**
 * The SQL script Finn pastes into the Supabase SQL editor: one UPDATE by id per
 * changed row. No begin/commit: the SQL editor runs a pasted script as one batch.
 * Each statement sets fixed values, so running the file twice is harmless.
 */
function buildSql(changes, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    '-- sfedits#25: restore editor usernames, IPs and the anonymous flag from Wikipedia.',
    `-- Generated by scripts/backfill-editors.js at ${generatedAt}.`,
    `-- ${changes.length} rows. Each statement sets fixed values by id, so running this twice is harmless.`,
    '-- Paste into the Supabase SQL editor (runs as postgres; the bot key has no UPDATE on purpose).',
    '',
  ];
  for (const r of changes) {
    const id = Number(r.row.id);
    if (!Number.isInteger(id)) throw new Error(`row id is not an integer: ${r.row.id}`);
    const sets = Object.entries(r.patch).map(([col, value]) => {
      if (!/^[a-z_]+$/.test(col)) throw new Error(`unexpected column name: ${col}`);
      return `${col} = ${sqlLiteral(value)}`;
    });
    lines.push(`update public.wikipedia_edits set ${sets.join(', ')} where id = ${id};`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Look up every row's revision on its wiki and derive the update for each.
 * Returns { results: [{ row, revid, status, patch, kinds }] }.
 */
async function planBackfill(rows, { fetchImpl = fetch, lookupCountry, delayMs = WIKI_REQUEST_DELAY_MS, log = () => {} } = {}) {
  const byApi = new Map();
  const revidOf = new Map();

  for (const row of rows) {
    const revid = revidFromDiffUrl(row.diff_url);
    const apiUrl = apiUrlForDiffUrl(row.diff_url);
    if (revid === null || apiUrl === null) continue;
    revidOf.set(row.id, { revid, apiUrl });
    if (!byApi.has(apiUrl)) byApi.set(apiUrl, new Set());
    byApi.get(apiUrl).add(revid);
  }

  const infoByApi = new Map();
  for (const [apiUrl, revidSet] of byApi) {
    const revids = [...revidSet];
    log(`Asking ${apiUrl} about ${revids.length} revisions...`);
    infoByApi.set(apiUrl, await fetchRevisionUsers(apiUrl, revids, { fetchImpl, delayMs }));
  }

  const results = [];
  for (const row of rows) {
    const where = revidOf.get(row.id);
    const info = where ? infoByApi.get(where.apiUrl).get(where.revid) : undefined;
    const derived = await deriveUpdate(row, info, lookupCountry);
    results.push({ row, revid: where ? where.revid : null, ...derived });
  }

  return { results };
}

function summarize(results) {
  const counts = { change: 0, unchanged: 0, hidden: 0, missing: 0, unparseable: 0 };
  const kinds = {};
  for (const r of results) {
    counts[r.status]++;
    for (const k of r.kinds) kinds[k] = (kinds[k] || 0) + 1;
  }
  return { counts, kinds };
}

function describeChange(r) {
  const parts = Object.entries(r.patch).map(([col, value]) => `${col}: ${JSON.stringify(r.row[col])} -> ${JSON.stringify(value)}`);
  return `id ${r.row.id} (${r.row.diff_url})\n     ${parts.join('; ')}`;
}

async function main() {
  let sqlFile = null;
  let sampleSize = 20;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--sql') {
      sqlFile = process.argv[++i];
      if (!sqlFile) {
        console.error('Error: --sql needs a file name, e.g. --sql out.sql');
        process.exit(1);
      }
    } else if (arg === '--dry-run') {
      sqlFile = null;
    } else if (arg === '--sample') {
      sampleSize = Number(process.argv[++i]) || 0;
    } else {
      console.error(`Error: unknown argument ${arg}`);
      process.exit(1);
    }
  }
  const mode = sqlFile ? `write SQL to ${sqlFile}` : 'dry-run';

  // Both modes read the table, so both need the credentials.
  const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
  const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingEnvVars.length > 0) {
    console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
    console.error('Set them via: set -a && source .env && set +a && node scripts/backfill-editors.js');
    process.exit(1);
  }
  const SUPABASE_URL = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  const { initializeReader, getCountryCode } = require('../lib/geolocation');
  if (!(await initializeReader())) {
    console.warn('MaxMind database not found (data/GeoLite2-City.mmdb): countries will not be filled, existing ones are kept.');
  }

  console.log(`Mode: ${mode}`);
  console.log();

  const rows = await fetchAllRows(SUPABASE_URL, SUPABASE_SECRET_KEY);
  console.log(`Rows read: ${rows.length}`);

  const { results } = await planBackfill(rows, {
    lookupCountry: getCountryCode,
    log: msg => console.log(msg),
  });
  const { counts, kinds } = summarize(results);
  const changes = results.filter(r => r.status === 'change');

  console.log();
  console.log(`Would change: ${counts.change}`);
  console.log(`Already correct: ${counts.unchanged}`);
  console.log(`User hidden by Wikipedia (left unchanged): ${counts.hidden}`);
  console.log(`Revision not found (left unchanged): ${counts.missing}`);
  console.log(`No revision id in diff_url (left unchanged): ${counts.unparseable}`);
  console.log();
  console.log('Changes by kind (a row can have several):');
  for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${n}`);
  }

  const leftAlone = results.filter(r => ['hidden', 'missing', 'unparseable'].includes(r.status));
  if (leftAlone.length > 0) {
    console.log();
    console.log('Rows left unchanged:');
    for (const r of leftAlone) {
      console.log(`  ${r.status}: id ${r.row.id} revid ${r.revid} ${r.row.diff_url}`);
    }
  }

  if (sampleSize > 0 && changes.length > 0) {
    console.log();
    console.log(`Sample of changes (${Math.min(sampleSize, changes.length)} of ${changes.length}):`);
    changes.slice(0, sampleSize).forEach((r, i) => console.log(`  ${i + 1}. ${describeChange(r)}`));
  }

  if (!sqlFile) {
    console.log('\nNothing was written. Run with --sql out.sql to write the UPDATE statements.');
    return;
  }

  require('fs').writeFileSync(sqlFile, buildSql(changes));
  console.log();
  console.log(`Wrote ${changes.length} UPDATE statements to ${sqlFile}.`);
  console.log('Paste it into the Supabase SQL editor and run it. The database itself was not touched.');
}

module.exports = {
  isIpAddress,
  isAnonymousName,
  revidFromDiffUrl,
  apiUrlForDiffUrl,
  parseRevisionsResponse,
  fetchRevisionUsers,
  deriveUpdate,
  fetchAllRows,
  sqlLiteral,
  buildSql,
  planBackfill,
  summarize,
  USER_AGENT,
};

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error.message || error);
    process.exit(1);
  });
}
