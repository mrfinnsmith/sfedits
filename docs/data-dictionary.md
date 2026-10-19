# Data dictionary: `wikipedia_edits`

The SF Edits bot writes one row to `public.wikipedia_edits` (Supabase) for each
Wikipedia edit it has posted to Bluesky and Mastodon. Edits the bot held back
in its personal-information screening are never written here. The site reads
this table to show and count the edits.

The schema lives in `supabase/migrations/`. The same descriptions are stored
as Postgres column comments, so they show up in the Supabase table editor.

## Columns

| Column | Type | Can be empty | What it holds |
|---|---|---|---|
| `id` | bigint | no | Row number assigned by the database. A stable handle for the site. Not a Wikipedia id. |
| `article_title` | text | no | Title of the Wikipedia page that was edited. |
| `lang` | text | no | Wikipedia language edition, for example `en`. |
| `editor` | text | yes | The username exactly as Wikipedia gives it. See below. |
| `ip` | text | yes | The editor's IP address, when Wikipedia gives one. Not readable with the public key. See below. |
| `anonymous` | boolean | yes | Whether we count the editor as anonymous. Our judgment, not a Wikipedia field. See below. |
| `editor_country` | text | yes | Two-letter country code worked out from the IP address (MaxMind). Empty when there is no IP or it could not be placed. |
| `diff_url` | text | no | Wikipedia's permanent link to this exact revision. Unique: one row per edit. |
| `posted_at` | timestamptz | no | When the bot posted the edit to Bluesky and Mastodon. |
| `created_at` | timestamptz | no | When the row was written. Usually seconds after `posted_at`; a bigger gap means the bot had to retry the write. |

## `editor`

The username as Wikipedia reports it, unchanged. It is one of three things:

- an account name, for a registered editor;
- a temporary-account name such as `~2026-12345-67`. Since 2026 Wikipedia gives
  logged-out editors these instead of showing their IP address;
- an IP address, for older logged-out edits.

Older rows may have `editor` empty for anonymous edits, because the bot used to
store no name for them. A later backfill fills these in from Wikipedia.

## `ip`

The editor's IP address, when Wikipedia gives one. Usually that is only the
older logged-out edits, where the username is the IP address. It is empty for
registered accounts and for temporary accounts, where Wikipedia hides the IP.

The IP is stored, but the site's public key cannot read this column. The table
can be read with that key, so anything readable can be downloaded in bulk; the
database grants the public key every column except `ip`. The bot's private key
can read and write it.

Making `ip` readable with the public key is Finn's call. It is one line, run in
the Supabase SQL editor:

```sql
grant select (ip) on public.wikipedia_edits to anon, authenticated;
```

## `anonymous`

Wikipedia's data has no "anonymous" field. The bot decides this when it
records the edit: `true` when the username is an IP address or a
temporary-account name (one that starts with `~` and a year, like
`~2026-12345-67`), `false` otherwise.

So it is our judgment, not a fact from the source. If the rule changes, it can
be worked out again from the username for every row.

It can be empty. A bot version that did not send it writes rows with
`anonymous` empty; for those, treat the edit as anonymous when `editor` is
empty. Rows that existed when the column was added were filled the same way:
`true` where `editor` was empty, `false` otherwise.

## `editor_country`

A two-letter country code the bot worked out from the IP address using
MaxMind. It is empty when there is no IP (registered and temporary accounts)
or the address could not be placed.

## Who can read what

- **Public key** (the site): every column except `ip`, every row.
- **Bot key** (service role): reads every column and adds rows. It cannot
  change or delete rows.
- Fixes to existing rows are run by hand in the Supabase SQL editor.

A column added to this table later is not readable with the public key until
it is added to the column grant in a migration.
