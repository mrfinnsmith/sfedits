#!/usr/bin/env node

/**
 * Backfill script for SF Edits Wikipedia edit history.
 *
 * IMPORTANT: This script runs on the user's Mac with modern Node (global fetch available).
 * It does NOT run on the bot droplet (host Node v12).
 *
 * The script fetches the SF Edits bot's complete post history from the public AT Protocol
 * endpoint app.bsky.feed.getAuthorFeed and loads it into a Supabase table via the
 * record_wikipedia_edit RPC.
 *
 * The Supabase RPC is idempotent via `on conflict (diff_url) do nothing`, so re-running
 * this script is safe.
 *
 * Usage:
 *   source .env && node backfill-edits.js --dry-run [--from-cache <dir>]
 *   source .env && node backfill-edits.js --commit [--from-cache <dir>]
 *
 * Flags:
 *   --dry-run           Parse and show summary without making write requests (default)
 *   --commit            Actually write to Supabase
 *   --from-cache <dir>  Use pre-downloaded JSON files instead of fetching live
 *
 * Environment variables required:
 *   SUPABASE_URL        - Supabase project URL (e.g., https://xyz.supabase.co)
 *   SUPABASE_SECRET_KEY - the sfedits project's secret key (sb_secret_...)
 */

const fs = require('fs');
const path = require('path');

// Parse command-line arguments
let mode = 'dry-run';
let fromCache = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--commit') {
    mode = 'commit';
  } else if (arg === '--dry-run') {
    mode = 'dry-run';
  } else if (arg === '--from-cache') {
    fromCache = process.argv[++i];
  }
}

// Verify environment variables. Only --commit needs them: a dry run parses
// and validates without talking to Supabase at all, so it must stay runnable
// by anyone, on any machine, with no credentials present.
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (mode === 'commit' && missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Set them via: source .env && node backfill-edits.js --commit');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

// Regex to parse post text: "Article Title Wikipedia article edited by Editor https://..."
// Pattern: ^(.+?) Wikipedia article edited by (.+) (https?:\/\/\S+)$
// Groups: 1 = article_title, 2 = editor (greedy, can contain spaces), 3 = diff_url (anchored to http)
// The editor group is greedy so it captures the full editor name including spaces.
// The URL group is anchored to https?:// and matches non-whitespace, so it stops at the first space.
const TEXT_PATTERN = /^(.+?) Wikipedia article edited by (.+) (https?:\/\/\S+)$/;

// Regex to detect IPv4 and IPv6 addresses
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_PATTERN = /^[0-9a-fA-F:]+$/;

/**
 * Check if a string is an IP address (IPv4 or IPv6)
 */
function isIpAddress(str) {
  if (IPV4_PATTERN.test(str)) return true;
  if (IPV6_PATTERN.test(str) && str.includes(':')) return true;
  return false;
}

/**
 * Extract language code from a Wikipedia diff URL.
 * Examples:
 *   https://en.wikipedia.org/w/index.php?diff=...  -> "en"
 *   https://ru.wikipedia.org/w/index.php?diff=...  -> "ru"
 *   https://pt.wikipedia.org/w/index.php?diff=...  -> "pt"
 */
function extractLanguage(diffUrl) {
  // Match pattern: https://XX.wikipedia.org or https://XX-REGION.wikipedia.org
  const match = diffUrl.match(/https:\/\/([a-z]{2}(?:-[a-z]+)?)\./);
  if (match && match[1]) {
    return match[1].split('-')[0]; // Return just the language part, e.g. "en" not "en-gb"
  }
  return null;
}

/**
 * Validate a parsed edit record.
 * Returns {valid: true} or {valid: false, error: string}
 */
function validateEdit(edit) {
  // Check that diff_url starts with http
  if (!edit.diff_url.startsWith('http')) {
    return {
      valid: false,
      error: `diff_url does not start with http: ${edit.diff_url}`,
    };
  }

  // Check that diff_url contains no spaces
  if (edit.diff_url.includes(' ')) {
    return {
      valid: false,
      error: `diff_url contains spaces: ${edit.diff_url}`,
    };
  }

  // Check that diff_url contains 'diff='
  if (!edit.diff_url.includes('diff=')) {
    return {
      valid: false,
      error: `diff_url does not contain 'diff=': ${edit.diff_url}`,
    };
  }

  return { valid: true };
}

/**
 * Parse a single post record into edit fields.
 * Returns an object with keys: article_title, lang, editor, editor_country, diff_url, posted_at
 */
function parsePost(postRecord) {
  const text = postRecord.text;
  const createdAt = postRecord.createdAt;

  const match = text.match(TEXT_PATTERN);
  if (!match) {
    return null;
  }

  const articleTitle = match[1];
  const editorRaw = match[2];
  const diffUrl = match[3];

  // Extract language from URL
  const lang = extractLanguage(diffUrl);
  if (!lang) {
    return null;
  }

  // Check if editor is an IP address
  let editor = editorRaw;
  let editorCountry = null;
  if (isIpAddress(editorRaw)) {
    editor = null;
    editorCountry = null;
    // Note: These 18 IP rows could optionally be enriched via MaxMind, but it's not worth blocking on.
  }

  return {
    article_title: articleTitle,
    lang,
    editor,
    editor_country: editorCountry,
    diff_url: diffUrl,
    posted_at: createdAt,
  };
}

/**
 * Fetch posts from the public AT Protocol endpoint, paginating with cursor.
 */
async function fetchPostsLive() {
  const actor = 'sfedits.bsky.social';
  const posts = [];
  let cursor = null;

  // Fetch pages up to a reasonable limit
  for (let page = 0; page < 50; page++) {
    const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed');
    url.searchParams.set('actor', actor);
    url.searchParams.set('limit', '100');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch page ${page}: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.feed || data.feed.length === 0) {
      break;
    }

    posts.push(...data.feed);
    cursor = data.cursor;
    if (!cursor) {
      break;
    }
  }

  return posts;
}

/**
 * Load posts from cached JSON files.
 */
function loadPostsFromCache(cacheDir) {
  const posts = [];
  for (let i = 0; i <= 13; i++) {
    const file = path.join(cacheDir, `feed_page_${i}.json`);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.feed && Array.isArray(data.feed)) {
        posts.push(...data.feed);
      }
    }
  }
  return posts;
}

/**
 * Insert one edit. on_conflict names diff_url as the arbiter: without it
 * PostgREST falls back to the primary key and a row already present comes back
 * 409 instead of being ignored. That matters here because the feed contains
 * 1351 posts but only 1346 distinct diff urls, and because re-running the whole
 * backfill has to stay safe.
 */
async function insertEdit(edit) {
  const url = `${SUPABASE_URL}/rest/v1/wikipedia_edits?on_conflict=diff_url`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
      'Prefer': 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify({
      article_title: edit.article_title,
      lang: edit.lang,
      diff_url: edit.diff_url,
      posted_at: edit.posted_at,
      editor: edit.editor,
      editor_country: edit.editor_country,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`insert failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return null;
}

/**
 * Main backfill function.
 */
async function main() {
  console.log(`Mode: ${mode}`);
  if (fromCache) {
    console.log(`Loading from cache: ${fromCache}`);
  } else {
    console.log('Fetching live from public AT Protocol endpoint...');
  }
  console.log();

  // Load posts
  let postItems;
  try {
    if (fromCache) {
      postItems = loadPostsFromCache(fromCache);
    } else {
      postItems = await fetchPostsLive();
    }
  } catch (error) {
    console.error('Error loading posts:', error.message);
    process.exit(1);
  }

  console.log(`Loaded ${postItems.length} posts from feed`);
  console.log();

  // Parse all posts
  const edits = [];
  const parseErrors = [];
  const validationFailures = [];

  for (let i = 0; i < postItems.length; i++) {
    const postItem = postItems[i];
    const postRecord = postItem.post.record;

    const edit = parsePost(postRecord);
    if (!edit) {
      parseErrors.push({
        index: i,
        text: postRecord.text,
      });
      continue;
    }

    // Validate the parsed edit
    const validation = validateEdit(edit);
    if (!validation.valid) {
      validationFailures.push({
        index: i,
        error: validation.error,
        text: postRecord.text,
      });
      continue;
    }

    edits.push({
      ...edit,
      _index: i,
    });
  }

  console.log(`Parsed ${edits.length} valid edits`);
  if (parseErrors.length > 0) {
    console.log(`Parse errors: ${parseErrors.length}`);
    parseErrors.slice(0, 5).forEach((err) => {
      console.log(`  Index ${err.index}: ${err.text.substring(0, 80)}`);
    });
    if (parseErrors.length > 5) {
      console.log(`  ... and ${parseErrors.length - 5} more`);
    }
  }
  if (validationFailures.length > 0) {
    console.log(`Validation failures: ${validationFailures.length}`);
    validationFailures.slice(0, 5).forEach((v) => {
      console.log(`  Index ${v.index}: ${v.error}`);
    });
    if (validationFailures.length > 5) {
      console.log(`  ... and ${validationFailures.length - 5} more`);
    }
  }
  console.log();

  // Count IP editors
  const ipEditors = edits.filter(e => e.editor === null);
  console.log(`IP address editors (editor set to null): ${ipEditors.length}`);

  // Count editors with spaces
  const editorsWithSpaces = edits.filter(e => e.editor && e.editor.includes(' '));
  console.log(`Editors with spaces in name: ${editorsWithSpaces.length}`);

  // Count unique diff URLs
  const uniqueDiffUrls = new Set(edits.map(e => e.diff_url));
  console.log(`Unique diff URLs: ${uniqueDiffUrls.size}`);
  console.log(`Posts with duplicate diff URLs: ${edits.length - uniqueDiffUrls.size}`);

  // Find date range
  const dates = edits.map(e => new Date(e.posted_at));
  const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
  console.log(`Date range: ${minDate.toISOString()} to ${maxDate.toISOString()}`);
  console.log();

  if (mode === 'dry-run') {
    console.log('=== DRY RUN MODE ===');
    console.log(`Would insert ${uniqueDiffUrls.size} unique records into Supabase`);
    console.log(`(${edits.length - uniqueDiffUrls.size} posts have duplicate diff URLs and will be absorbed by ON CONFLICT)`);
    console.log();
    console.log('Sample records with editors containing spaces:');
    editorsWithSpaces.slice(0, 5).forEach((edit, i) => {
      console.log(`\n${i + 1}. ${edit.article_title}`);
      console.log(`   Editor: ${edit.editor}`);
      console.log(`   Language: ${edit.lang}`);
      console.log(`   Posted: ${edit.posted_at}`);
      console.log(`   URL: ${edit.diff_url.substring(0, 80)}...`);
    });
    console.log('\nNo records were written. Run with --commit to insert.');
    process.exit(0);
  }

  // Commit mode: write to Supabase
  console.log('=== COMMIT MODE ===');
  console.log(`Inserting ${edits.length} records (${uniqueDiffUrls.size} unique diff URLs)...`);
  console.log();

  let succeeded = 0;
  let failed = 0;
  const failedEdits = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    try {
      await insertEdit(edit);
      succeeded++;

      if ((i + 1) % 100 === 0) {
        console.log(`Progress: ${i + 1}/${edits.length} submitted`);
      }
    } catch (error) {
      failed++;
      failedEdits.push({
        index: i,
        edit,
        error: error.message,
      });

      if (failed <= 10) {
        console.error(`Error on row ${i}: ${error.message}`);
        console.error(`  Edit: ${edit.article_title} by ${edit.editor || '(IP)'}`);
      }
    }

    // Small delay to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  console.log();
  console.log('=== SUMMARY ===');
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total submitted: ${edits.length}`);
  console.log(`Unique diff URLs inserted: ${uniqueDiffUrls.size}`);
  console.log(`Duplicates absorbed by ON CONFLICT: ${edits.length - uniqueDiffUrls.size}`);

  if (failed > 0) {
    console.log(`\nFirst failed edit details:`);
    failedEdits.slice(0, 3).forEach((f) => {
      console.log(`  Index ${f.index}: ${f.error}`);
    });
    process.exit(1);
  }

  console.log('\nBackfill complete!');
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
