# Applying `20260831000001_wikipedia_edits.sql` to project `proaulxkhgbipkcsesze`

Target: the brand new, empty Supabase project `proaulxkhgbipkcsesze`, in its own
organization, created with **"Automatically expose new tables" DISABLED** and
**"Enable automatic RLS" ENABLED**.

Repo path for the migration file: `supabase/migrations/20260831000001_wikipedia_edits.sql`.

Nothing below prints or requires a key value. The dashboard SQL editor connects
as the project's `postgres` role; you never paste a secret into it.

---

## 1. Apply

1. Open the Supabase dashboard and confirm the project ref in the URL is
   `proaulxkhgbipkcsesze` before doing anything. This is the whole point of the
   new project, and an accidental paste into the shared project is the one
   mistake this file cannot undo for you.
2. Go to **SQL Editor** and open a new query.
3. Paste the entire contents of
   `supabase/migrations/20260831000001_wikipedia_edits.sql`. Paste all of it,
   including the header comment; it is the documentation for why the schema is
   shaped this way and it costs nothing to store.
4. Run it. Expect `Success. No rows returned`.
5. Re-run the exact same script a second time. It must also succeed with no
   rows returned. The file is written to be idempotent, and this is the cheapest
   possible check of that claim.

If you prefer the CLI instead of the dashboard, the equivalent is
`supabase link --project-ref proaulxkhgbipkcsesze` then `supabase db push`; the
verification below is unchanged.

---

## 2. Verify

Run each block below in the SQL editor. Each one states what a pass looks like.
Blocks 3 to 6 use `set local role` inside a transaction that is rolled back, so
they leave no rows behind and cannot change privileges.

### 2.1 The table exists with the right columns

```sql
select column_name, data_type, is_nullable, column_default, is_identity
from information_schema.columns
where table_schema = 'public' and table_name = 'wikipedia_edits'
order by ordinal_position;
```

**Pass:** exactly eight rows, in this order.

| column | type | nullable | notes |
|---|---|---|---|
| `id` | bigint | NO | `is_identity = YES` |
| `article_title` | text | NO | |
| `lang` | text | NO | |
| `editor` | text | YES | |
| `editor_country` | text | YES | |
| `diff_url` | text | NO | |
| `posted_at` | timestamp with time zone | NO | |
| `created_at` | timestamp with time zone | NO | default `now()` |

And the constraints, index and comment:

```sql
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.wikipedia_edits'::regclass
order by contype, conname;

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'wikipedia_edits'
order by indexname;

select obj_description('public.wikipedia_edits'::regclass, 'pg_class') as table_comment;
```

**Pass:** a primary key on `(id)`, a unique constraint on `(diff_url)`, and an
index `wikipedia_edits_posted_at_idx` on `(posted_at DESC)` alongside the two
constraint-backed indexes. The table comment begins `sfedits#7:` and contains
`Posted edits only`.

### 2.2 RLS is on, and the grants are exactly what was intended

```sql
select relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where oid = 'public.wikipedia_edits'::regclass;

select policyname, permissive, roles, cmd, qual
from pg_policies
where schemaname = 'public' and tablename = 'wikipedia_edits';

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'wikipedia_edits'
  and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
order by grantee, privilege_type;
```

**Pass:**
- `rls_enabled = true`.
- One policy, `posted wikipedia edits are public`, `PERMISSIVE`, roles
  `{anon,authenticated}`, `cmd = SELECT`, `qual = true`.
- Grants are exactly: `anon SELECT`, `authenticated SELECT`,
  `service_role INSERT`. Nothing else. In particular no `anon INSERT`, no
  `service_role UPDATE` or `DELETE`, and no `PUBLIC` row at all.

And the identity sequence:

```sql
select
  pg_get_serial_sequence('public.wikipedia_edits', 'id') as seq,
  has_sequence_privilege('service_role', pg_get_serial_sequence('public.wikipedia_edits','id'), 'USAGE') as service_role_usage,
  has_sequence_privilege('anon',         pg_get_serial_sequence('public.wikipedia_edits','id'), 'USAGE') as anon_usage;
```

**Pass:** `service_role_usage = true`, `anon_usage = false`.

### 2.3 anon CAN select

```sql
begin;
  set local role anon;
  select count(*) as anon_visible_rows from public.wikipedia_edits;
rollback;
```

**Pass:** a count comes back without error (`0` on a fresh table). An error
`permission denied for table wikipedia_edits` means the grant in section 2 of
the migration did not apply.

### 2.4 anon CANNOT insert

```sql
begin;
  set local role anon;
  insert into public.wikipedia_edits (article_title, lang, diff_url, posted_at)
  values ('Anon Probe', 'en', 'https://en.wikipedia.org/w/index.php?diff=probe-anon', now());
rollback;
```

**Pass: this must FAIL**, with
`ERROR: permission denied for table wikipedia_edits` (SQLSTATE 42501). If it
succeeds, stop and fix the grants before pointing the bot at this project.

The failure aborts the transaction; the `rollback` is there to clear it. Run it
on its own if the editor stops at the error.

> Note on what this proves. The failure comes from the missing INSERT
> **privilege**, not from RLS, so it holds regardless of policies. That is the
> stronger guarantee of the two, which is why the migration revokes before it
> grants.

### 2.5 service_role CAN insert

```sql
begin;
  set local role service_role;
  insert into public.wikipedia_edits (article_title, lang, editor_country, diff_url, posted_at)
  values ('Service Probe', 'en', 'US', 'https://en.wikipedia.org/w/index.php?diff=probe-1', now())
  returning id, article_title, diff_url, posted_at, created_at;
rollback;
```

**Pass:** one row returned, with a non-null `id` (proving the sequence grant)
and a `created_at` filled in by the default. The `rollback` discards it, so the
table is still empty afterwards.

### 2.6 A duplicate `diff_url` is silently ignored

This is the behaviour the bot depends on: it posts to social first and records
second, so a retry after a network failure must neither raise nor duplicate.

```sql
begin;
  set local role service_role;

  insert into public.wikipedia_edits (article_title, lang, diff_url, posted_at)
  values ('Dup Probe', 'en', 'https://en.wikipedia.org/w/index.php?diff=probe-2', now())
  on conflict (diff_url) do nothing;

  -- the bot's retry: same diff_url, different posted_at
  insert into public.wikipedia_edits (article_title, lang, diff_url, posted_at)
  values ('Dup Probe', 'en', 'https://en.wikipedia.org/w/index.php?diff=probe-2', now() + interval '1 minute')
  on conflict (diff_url) do nothing;

  select count(*) as rows_for_probe_2
  from public.wikipedia_edits
  where diff_url = 'https://en.wikipedia.org/w/index.php?diff=probe-2';
rollback;
```

**Pass:** the second insert reports `INSERT 0 0` and raises nothing, and
`rows_for_probe_2 = 1`. The surviving row keeps the **first** `posted_at`,
which is the one that matches the post that actually went out.

For contrast, confirm the constraint is real by omitting the on-conflict clause:

```sql
begin;
  set local role service_role;
  insert into public.wikipedia_edits (article_title, lang, diff_url, posted_at)
  values ('Dup Probe', 'en', 'https://en.wikipedia.org/w/index.php?diff=probe-3', now());
  insert into public.wikipedia_edits (article_title, lang, diff_url, posted_at)
  values ('Dup Probe', 'en', 'https://en.wikipedia.org/w/index.php?diff=probe-3', now());
rollback;
```

**Pass: the second insert must FAIL** with
`duplicate key value violates unique constraint "wikipedia_edits_diff_url_key"`
(SQLSTATE 23505). That error is what the bot's client must avoid by sending the
on-conflict form, so it is worth seeing once.

### 2.7 The table is clean afterwards

```sql
select count(*) as total_rows from public.wikipedia_edits;
```

**Pass:** `0`. Every probe above ran inside a rolled-back transaction. If this
is not zero, something was run outside a `begin`/`rollback` pair; delete the
probe rows by `diff_url` before the site reads the table.

---

## 3. Verify over the REST API (optional but recommended)

The SQL checks above prove the database is right. They do not prove PostgREST
has noticed the new table, which is a separate failure mode on a project created
with "Automatically expose new tables" disabled.

From a shell, with the publishable key in an environment variable already
exported by your shell profile or `.env` (never inline the value in a command,
and never paste a secret key into anything that logs):

```bash
source .env && curl -s \
  "https://proaulxkhgbipkcsesze.supabase.co/rest/v1/wikipedia_edits?select=id&limit=1" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_PUBLISHABLE_KEY"
```

**Pass:** `[]` (an empty array). A `404` with
`"Could not find the table 'public.wikipedia_edits' in the schema cache"` means
PostgREST has not reloaded; re-run `notify pgrst, 'reload schema';` in the SQL
editor, or restart the project under **Settings → General**. A `401`/`42501`
means the `anon` grant did not apply.

Then confirm the publishable key cannot write:

```bash
source .env && curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://proaulxkhgbipkcsesze.supabase.co/rest/v1/wikipedia_edits" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_PUBLISHABLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"article_title":"Anon Probe","lang":"en","diff_url":"https://example.invalid/probe","posted_at":"2026-08-31T00:00:00Z"}'
```

**Pass:** `401` or `403`. A `201` means anon holds INSERT and the migration's
grants are wrong.
