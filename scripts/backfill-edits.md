# SF Edits Backfill Script

A one-off Node script to load the SF Edits bot's complete historical post record into a Supabase table.

## How to Run

### Dry Run (Recommended First)

Test parsing and see what would be inserted without making any changes:

```bash
cd /path/to/sfedits
source .env
node backfill-edits.js --dry-run --from-cache /path/to/cache/dir
```

The cache directory should contain the downloaded feed files: `feed_page_0.json` through `feed_page_13.json`.

### Commit to Supabase

After confirming the dry-run output looks correct:

```bash
source .env
node backfill-edits.js --commit --from-cache /path/to/cache/dir
```

### Fetch Live (Not Using Cache)

To fetch posts directly from the public AT Protocol endpoint instead of using cached files:

```bash
source .env
node backfill-edits.js --dry-run
node backfill-edits.js --commit
```

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

The key fix: the editor group is greedy `(.+)` and the URL is anchored to `https?://\S+`, which means the split happens at the last space before the URL, not the first space after "edited by". This correctly handles editor names with spaces like `Ser Amantio di Nicolao`, `Roving Huntsman`, `Theodore Christopher`, etc.

**Examples:**
- `Gavin Newsom Wikipedia article edited by AUC2012 https://en.wikipedia.org/w/index.php?diff=1372098397&oldid=1372098328`
- `Daniel Lurie Wikipedia article edited by Theodore Christopher https://en.wikipedia.org/w/index.php?diff=1361702745&oldid=1361692953`
- `Харрис, Камала Wikipedia article edited by 23.163.104.37 https://ru.wikipedia.org/w/index.php?diff=151085321&oldid=150938683`

### Language Extraction

The script extracts the 2-letter language code from the diff URL hostname:

- `https://en.wikipedia.org/...` → `en`
- `https://ru.wikipedia.org/...` → `ru`
- `https://pt.wikipedia.org/...` → `pt`

Regex: `https://([a-z]{2}(?:-[a-z]+)?)\./`

For hyphenated codes (e.g., `en-GB`), only the language part is kept: `en`.

### Editor Handling

**If the editor field is an IPv4 or IPv6 address (18 posts):**
- Set `editor` to `null`
- Set `editor_country` to `null`
- No country enrichment via MaxMind is performed (not worth blocking on, and would require additional setup)

**Examples of IP editors:**
- `23.163.104.37`
- `46.63.243.1`

**Otherwise (1333 posts):**
- Editor is the username as-is, preserving all spaces and punctuation
- editor_country remains null (future enhancement possible)
- 166 of these posts (12%) have editor names containing spaces

**Examples of editors with spaces:**
- `Ser Amantio di Nicolao`
- `Roving Huntsman`
- `Theodore Christopher`
- `Pac Veten`
- `ClueBot NG`
- `EVA3.0 (bot)`
- `Servite et contribuere`

## Supabase RPC Call

The script calls the `record_wikipedia_edit` RPC with these parameters:

```
p_article_title    - Article title from the post
p_lang             - 2-letter language code from URL
p_diff_url         - Full diff URL (unique key)
p_posted_at        - Post creation timestamp (ISO 8601)
p_editor           - Username or null for IP addresses
p_editor_country   - Always null in this version
```

The RPC uses `ON CONFLICT (diff_url) DO NOTHING`, making it **idempotent**. Re-running the script is safe and will not create duplicates.

## Validation

The script validates each parsed edit to ensure correctness:

1. **URL starts with http** - Ensures the diff_url begins with `http://` or `https://`
2. **URL contains no spaces** - Ensures the URL was not mangled by the regex
3. **URL contains 'diff='** - Ensures the URL contains the required diff parameter

Any row failing validation is reported and counted separately from parse errors. All 1351 posts pass validation.

## What This Script Does NOT Do

1. **No IP geolocation** - IP addresses are detected but not enriched with country data. This is intentional to keep the script simple and independent of MaxMind setup.

2. **No screenshot parsing** - The script extracts data from post metadata only; it does not download or analyze screenshot images.

3. **No text normalization** - Article titles and editor names are stored exactly as they appear in the post (including Unicode, punctuation, spacing).

4. **No deduplication** - The Supabase RPC handles uniqueness via `ON CONFLICT (diff_url)`, not this script.

5. **No rate limiting for writes** - The script inserts sequentially with a 10ms delay between requests. Adjust if Supabase applies stricter limits.

6. **No performance optimization** - Posts are fetched one at a time. For 1351 records this takes a few seconds; batching could make it faster but would complicate error handling.

## Unique URLs and Deduplication

The feed contains **1351 posts** but only **1346 unique diff URLs**. Five posts have duplicate URLs (the same Wikipedia edit was posted twice). The Supabase RPC handles this via `ON CONFLICT (diff_url) DO NOTHING`, so:

- The script attempts to insert all 1351 rows
- Only 1346 unique rows succeed (the 5 duplicates are absorbed by the ON CONFLICT clause)
- The final row count in Supabase is **1346**, not 1351

This is normal and expected. The script reports both the total posts submitted and the unique count so there are no surprises.

## Verification Query

After backfill completes, verify the row count in Supabase:

```sql
SELECT COUNT(*) as total_edits, COUNT(DISTINCT editor) as unique_editors, COUNT(*) FILTER (WHERE editor IS NULL) as ip_addresses
FROM wikipedia_edits;
```

Expected results:
- `total_edits`: 1346 (unique diff URLs only)
- `ip_addresses`: 18 (editors that were IP addresses)
- `unique_editors`: The number of distinct non-null editor values (should be around 632, since 1346 - 18 IP editors)

You can also check the date range:

```sql
SELECT MIN(posted_at) as earliest, MAX(posted_at) as latest, COUNT(*) as count
FROM wikipedia_edits;
```

Expected:
- `earliest`: 2025-02-18T22:17:00.541Z
- `latest`: 2026-08-30T08:27:56.399Z
- `count`: 1346

## Environment Variables

The script requires three environment variables. Set them in `.env` and source it before running:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_public_key
SUPABASE_EDITS_TOKEN=your_service_role_token
```

If any are missing, the script exits with a clear error message.

## Output Example

### Dry Run
```
Mode: dry-run
Loading from cache: /path/to/cache

Loaded 1351 posts from feed
Parsed 1351 valid edits

IP address editors (editor set to null): 18
Editors with spaces in name: 166
Unique diff URLs: 1346
Posts with duplicate diff URLs: 5
Date range: 2025-02-18T22:17:00.541Z to 2026-08-30T08:27:56.399Z

=== DRY RUN MODE ===
Would insert 1346 unique records into Supabase
(5 posts have duplicate diff URLs and will be absorbed by ON CONFLICT)

Sample records with editors containing spaces:

1. Gavin Newsom
   Editor: Ser Amantio di Nicolao
   Language: en
   Posted: 2026-08-29T11:24:49.963Z
   URL: https://en.wikipedia.org/w/index.php?diff=1371927735&...

2. Gavin Newsom
   Editor: Ser Amantio di Nicolao
   Language: en
   Posted: 2026-08-29T09:39:13.258Z
   URL: https://en.wikipedia.org/w/index.php?diff=1371919035&...

3. George Moscone
   Editor: Roving Huntsman
   Language: en
   Posted: 2026-08-28T03:20:47.339Z
   URL: https://en.wikipedia.org/w/index.php?diff=1371728815&...

4. George Moscone
   Editor: Roving Huntsman
   Language: en
   Posted: 2026-08-28T03:19:59.870Z
   URL: https://en.wikipedia.org/w/index.php?diff=1371728697&...

5. Nancy Pelosi
   Editor: Pac Veten
   Language: en
   Posted: 2026-08-26T03:42:34.428Z
   URL: https://en.wikipedia.org/w/index.php?diff=1371378468&...

No records were written. Run with --commit to insert.
```

### Commit Run
```
Mode: commit
Loading from cache: /path/to/cache

Loaded 1351 posts from feed
Parsed 1351 valid edits

IP address editors (editor set to null): 18
Editors with spaces in name: 166
Unique diff URLs: 1346
Posts with duplicate diff URLs: 5
Date range: 2025-02-18T22:17:00.541Z to 2026-08-30T08:27:56.399Z

=== COMMIT MODE ===
Inserting 1351 records (1346 unique diff URLs)...

Progress: 100/1351 submitted
Progress: 200/1351 submitted
[...]
Progress: 1300/1351 submitted

=== SUMMARY ===
Succeeded: 1351
Failed: 0
Total submitted: 1351
Unique diff URLs inserted: 1346
Duplicates absorbed by ON CONFLICT: 5

Backfill complete!
```
