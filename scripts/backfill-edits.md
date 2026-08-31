# SF Edits Backfill Script

A one-off Node script to load the SF Edits bot's complete published post history from the public
Bluesky feed into the `wikipedia_edits` table. It ran to completion on 2026-08-31 (1,353 posts,
1,348 rows); it is idempotent, so re-running it later only adds posts the table does not yet have.

## How to Run

Run from the repo root. The `.env` file has no `export` lines, so a plain `source .env` does not
put the variables where `node` can see them; use `set -a`.

### Dry Run (Default)

Parses the feed and reports what would be inserted. Needs no credentials:

```bash
cd /path/to/sfedits
node scripts/backfill-edits.js --dry-run
```

### Commit to Supabase

After confirming the dry-run output looks correct:

```bash
set -a && source .env && set +a
node scripts/backfill-edits.js --commit
```

### Cached Feed Pages

Both modes accept `--from-cache /path/to/cache/dir` to read previously downloaded feed files
(`feed_page_0.json` through `feed_page_N.json`) instead of fetching from
`public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed`.

## Parsing Logic

### Post Text Pattern

Each post text follows this exact pattern:

```
<article_title> Wikipedia article edited by <editor> <diff_url>
```

**Regex:** `^(.+?) Wikipedia article edited by (.+) (https?:\/\/\S+)$`

**Plain English Explanation:**
- Capture everything up to the first " Wikipedia article edited by" as the article title (non-greedy, stops at the delimiter)
- Capture the editor name/identifier (greedy, so it includes full names with spaces)
- Capture the diff URL (anchored to start with `http://` or `https://`, ends at the first whitespace)

The key fix: the editor group is greedy `(.+)` and the URL is anchored to `https?://\S+`, which means the split happens at the last space before the URL, not the first space after "edited by". This correctly handles editor names with spaces like `Ser Amantio di Nicolao`, `Roving Huntsman`, `Theodore Christopher`, etc. The obvious non-greedy editor group splits at the first space instead and silently mangles 12% of the history.

**Examples:**
- `Gavin Newsom Wikipedia article edited by AUC2012 https://en.wikipedia.org/w/index.php?diff=1372098397&oldid=1372098328`
- `Daniel Lurie Wikipedia article edited by Theodore Christopher https://en.wikipedia.org/w/index.php?diff=1361702745&oldid=1361692953`
- `Харрис, Камала Wikipedia article edited by 23.163.104.37 https://ru.wikipedia.org/w/index.php?diff=151085321&oldid=150938683`

### Language Extraction

The script extracts the language code from the diff URL hostname, the same derivation
`lib/wiki-url.js` does for live edits:

- `https://en.wikipedia.org/...` → `en`
- `https://ru.wikipedia.org/...` → `ru`
- `https://pt.wikipedia.org/...` → `pt`

### Editor Handling

**If the editor field is an IPv4 or IPv6 address (18 posts in the original history):**
- Set `editor` to `null`
- Set `editor_country` to `null`
- No country enrichment via MaxMind is performed. The live bot derives a country at post time; the backfill cannot, because the IP's location may have changed since the edit and the script should not depend on MaxMind setup.

**Otherwise:**
- Editor is the username as-is, preserving all spaces and punctuation
- `editor_country` remains null (it is mutually exclusive with `editor` by table constraint)

## Supabase Write Path

The script inserts over PostgREST, the same way `lib/edit-log.js` does:

```
POST {SUPABASE_URL}/rest/v1/wikipedia_edits?on_conflict=diff_url
Prefer: resolution=ignore-duplicates
```

Naming the conflict target matters: without `on_conflict=diff_url`, PostgREST arbitrates on the
primary key and a duplicate returns 409 instead of doing nothing. With it, re-running the script
is safe and creates no duplicates.

## Validation

The script validates each parsed edit to ensure correctness:

1. **URL starts with http** - Ensures the diff_url begins with `http://` or `https://`
2. **URL contains no spaces** - Ensures the URL was not mangled by the regex
3. **URL contains 'diff='** - Ensures the URL contains the required diff parameter

Any row failing validation is reported and counted separately from parse errors. All posts in the
original history pass validation.

## What This Script Does NOT Do

1. **No IP geolocation** - IP addresses are detected but not enriched with country data.
2. **No screenshot parsing** - The script extracts data from post text only.
3. **No text normalization** - Article titles and editor names are stored exactly as posted.
4. **No deduplication** - Uniqueness is enforced by the database via `on_conflict=diff_url`.
5. **No batching** - Rows are inserted sequentially with a small delay; the full history takes a
   couple of minutes.

## Duplicates Are Expected

The feed contains a handful of posts that repeat a diff URL (five in the original history: the
same Wikipedia edit posted twice). The script submits every post; the database absorbs the
repeats. The final row count therefore lands below the post count, and the script reports both
numbers so there are no surprises.

## Verification

After a commit run, compare the table against what the script reported:

```bash
set -a && source .env && set +a
curl -s -o /dev/null -D - \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  "$SUPABASE_URL/rest/v1/wikipedia_edits?select=id" | grep -i content-range
```

The count after `/` should equal the script's "Unique diff URLs inserted" figure plus whatever
the live bot has recorded since. On 2026-08-31 the backfill produced 1,348 rows spanning
2025-02-18 to 2026-08-31. Further SQL checks are in `supabase/apply-and-verify.md`.

## Environment Variables

Commit mode requires two variables, the same two the bot uses:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

If either is missing, the script exits with a clear error before touching the network. Dry-run
mode needs neither.
