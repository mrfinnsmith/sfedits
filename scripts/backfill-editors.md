# Backfill Editors Script

A one-off Node script (issue #25) that restores who made each past edit in `wikipedia_edits`.
The cleanup in #19 erased temporary-account names (`~2026-…`), and older anonymous edits never
stored a name or IP. Wikipedia still has all of it, so the script asks Wikipedia.

Run it only after the #22 migration, the site change that reads `anonymous`, and the #24 bot
change are live.

## What It Does

For every row it reads the revision id from `diff_url`, asks that wiki's API who made the revision
(`action=query&prop=revisions&rvprop=user|ids`, up to 50 revisions per request, one request at a
time with a short pause), and works out:

- `editor`: the username exactly as Wikipedia gives it (account, temporary account or IP)
- `ip`: the username when it is an IPv4 or IPv6 address, otherwise null
- `anonymous`: true when the username is an IP address or a temporary-account name
  (`~YYYY-NNNNN-NN`), the same rule as `lib/wiki-changes.js`. The rule is written out in the
  script rather than imported, because #24 may move it into an exported helper.
- `editor_country`: looked up from the IP with MaxMind (`data/GeoLite2-City.mmdb`), and only
  where the row has no country yet. A stored country is kept; a failed lookup keeps what is there.

Rows are left unchanged and listed when Wikipedia hides the user (revision deletion), when the
revision no longer exists, or when `diff_url` has no revision id.

## It Never Writes to the Database

The bot's secret key has no UPDATE on this table on purpose (see the first migration). The script
uses the key only to read. With `--sql` it writes a file of `update ... where id = N;` statements,
one per row that changes, which Finn pastes into the Supabase SQL editor. Each statement sets fixed
values, so running the file twice is harmless, and a fresh dry run afterwards reports nothing to
change.

## How to Run

From the repo root. The `.env` file has no `export` lines, so use `set -a`. Both steps need
`SUPABASE_URL` and `SUPABASE_SECRET_KEY`, because even the dry run reads the table.

### 1. Dry run (default)

```bash
set -a && source .env && set +a
node scripts/backfill-editors.js
```

Prints rows read, how many would change (by kind of change), the hidden/missing rows, and a sample
of changes. `--sample N` changes the sample size.

### 2. Write the SQL

```bash
node scripts/backfill-editors.js --sql out.sql
```

Same output, plus `out.sql`.

### 3. Run it

Open `out.sql`, check it, paste it into the Supabase SQL editor for the sfedits project, and run
it. Then repeat step 1: it should report `Would change: 0`.

## Diff URL Forms

The revision id comes from `diff=` (`index.php?diff=1372098397&oldid=1372098328`, also with a
`title=` first). For `diff=prev` or a new-page URL with only `oldid=`, it is `oldid`.
`/wiki/Special:Diff/N` and `/diff/N` also work. The API host is the diff URL's own host, so
`simple.wikipedia.org` and other wikis need nothing special.

## Tests

`test/backfill-editors.test.js` covers revision-id extraction, the anonymous rule, hidden and
missing revisions, batching, the row derivation and the SQL quoting, all with stubbed fetch.
