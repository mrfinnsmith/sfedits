-- sfedits#22: store the username, the IP and an anonymous flag for every edit,
-- and keep the IP out of reach of the site's public key.
--
-- Until now an anonymous edit kept no name and no IP, only a country. Finn
-- wants everything we can learn about an edit stored, with what the site shows
-- decided separately. So:
--
--   editor          unchanged column. From the bot after sfedits#24 it holds
--                   the username exactly as Wikipedia gives it: an account
--                   name, a temporary-account name like ~2026-12345-67, or an
--                   IP address for older logged-out edits. Not renamed, so the
--                   site's reads keep working.
--   ip              NEW, text, nullable. The editor's IP when Wikipedia gives
--                   one. Null is normal, e.g. for temporary accounts, where
--                   Wikipedia hides the IP.
--   anonymous       NEW, boolean, nullable, no default. Set by the bot when it
--                   records the edit. Wikipedia's data has no "anonymous"
--                   field: the bot decides it (the username is an IP address
--                   or a temporary-account name), so it is our judgment, not a
--                   fact from the source, and can be recomputed later.
--   editor_country  unchanged. Derived from the IP; null when there is no IP.
--
-- WHY anonymous IS NULLABLE WITH NO DEFAULT. The bot deployed today does not
-- send it, and still writes editor = null for anonymous edits. Until sfedits#24
-- ships, its new rows arrive with anonymous = null. Readers treat null as
-- "unknown, fall back to editor is null". A default of false would silently
-- label those anonymous edits as registered.
--
-- PRIVACY. This replaces what the first migration said ("the IP is never
-- stored"). The IP is now stored, but the public (anon) key cannot read it:
-- table-wide SELECT is revoked from anon and authenticated and granted back
-- column by column on every column except ip. The bot's service_role keeps
-- INSERT and SELECT on the whole table, as before. The RLS policy "posted
-- wikipedia edits are public" is untouched and still applies; column grants
-- and row policies are independent. Opening ip to the public key later is one
-- line, and Finn's call:
--
--   grant select (ip) on public.wikipedia_edits to anon, authenticated;
--
-- Consequence to remember: a column added to this table in future is NOT
-- readable by anon until it is added to the column grant below. And a client
-- that asks for select=* with the anon key now gets a permission error,
-- because * includes ip. The site selects named columns only.
--
-- Data dictionary: docs/data-dictionary.md.
--
-- Run as postgres (Supabase SQL editor). Safe to run twice: add-if-not-exists
-- for the columns, the fill only touches rows still null, comments and grants
-- are idempotent. No begin/commit, same as the first migration.


-- ---------------------------------------------------------------------------
-- 1. New columns.
-- ---------------------------------------------------------------------------

alter table public.wikipedia_edits add column if not exists ip text;
alter table public.wikipedia_edits add column if not exists anonymous boolean;

-- Existing rows: fill anonymous from what is stored today. Every anonymous row
-- so far has editor = null (temporary-account names were cleared by
-- 20261019000001). The backfill (sfedits#25) later corrects every row from
-- Wikipedia. Only null rows are touched, so a re-run never overwrites a value
-- the bot or the backfill has set.
update public.wikipedia_edits
   set anonymous = (editor is null)
 where anonymous is null;


-- ---------------------------------------------------------------------------
-- 2. Comments: the table and every column. This replaces the first
--    migration's table and column comments that said the IP is never stored.
-- ---------------------------------------------------------------------------

comment on table public.wikipedia_edits is
  'sfedits#7, #22: Wikipedia edits the SF Edits bot has already POSTED to Bluesky and Mastodon. Posted edits only: an edit withheld by the bot PII screening must never be written here. The editor IP is stored in ip when Wikipedia gives one, but the public (anon) key cannot read that column. See docs/data-dictionary.md.';

comment on column public.wikipedia_edits.id is
  'Row id assigned by the database. Stable handle for the site (URLs, React keys). Not a Wikipedia id.';

comment on column public.wikipedia_edits.article_title is
  'Title of the Wikipedia page that was edited, as Wikipedia gives it.';

comment on column public.wikipedia_edits.lang is
  'Wikipedia language edition the edit was made on, e.g. en.';

comment on column public.wikipedia_edits.editor is
  'Username exactly as Wikipedia gives it: an account name, a temporary-account name (~YYYY-NNNNN-NN), or an IP address for older logged-out edits. Null on rows recorded before sfedits#24 for anonymous edits, which the bot then stored without a name.';

comment on column public.wikipedia_edits.ip is
  'Editor IP address when Wikipedia gives one (logged-out edits shown by IP). Null when Wikipedia gives none, e.g. temporary accounts, where Wikipedia hides the IP, and registered accounts. Not readable with the public (anon) key; opening it is one grant and Finn''s call.';

comment on column public.wikipedia_edits.anonymous is
  'Our judgment, not a Wikipedia field: Wikipedia''s data has no "anonymous" flag. The bot sets it when it records the edit: true when the username is an IP address or a temporary-account name (~YYYY-...), false otherwise. Can be recomputed later from the username if the rule changes. Null means the row was written by a bot version that did not send it; treat null as "anonymous if editor is null".';

comment on column public.wikipedia_edits.editor_country is
  'Two-letter country code the bot derived from the editor IP via MaxMind. Null when there is no IP (registered and temporary accounts) or the IP could not be geolocated.';

comment on column public.wikipedia_edits.diff_url is
  'Wikipedia permanent revision URL. Natural key: unique, and the conflict target the bot relies on to retry a record that failed after the social post already went out.';

comment on column public.wikipedia_edits.posted_at is
  'When the bot posted to Bluesky and Mastodon, supplied by the bot. created_at is when the row landed; the gap between them is a retried record.';

comment on column public.wikipedia_edits.created_at is
  'When this row was written to the database, set by default to now().';


-- ---------------------------------------------------------------------------
-- 3. Public readers get every column except ip.
--
--    The revoke removes the table-wide SELECT the first migration granted.
--    The column grant then hands back each column by name. service_role is not
--    touched: it keeps INSERT and SELECT on the whole table, including ip.
-- ---------------------------------------------------------------------------

revoke select on table public.wikipedia_edits from anon, authenticated;

grant select (
  id,
  article_title,
  lang,
  editor,
  editor_country,
  diff_url,
  posted_at,
  created_at,
  anonymous
) on public.wikipedia_edits to anon, authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- Verify after running (SQL editor):
--
--   -- The two new columns exist; expect ip text YES, anonymous boolean YES.
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'wikipedia_edits'
--      and column_name in ('ip', 'anonymous');
--
--   -- No row left without anonymous; expect 0.
--   select count(*) from public.wikipedia_edits where anonymous is null;
--
--   -- anon can read the public columns; expect a count, no error.
--   begin;
--     set local role anon;
--     select count(*), count(anonymous) from public.wikipedia_edits;
--   rollback;
--
--   -- anon cannot read ip; expect ERROR: permission denied for table
--   -- wikipedia_edits (42501). Run on its own.
--   begin;
--     set local role anon;
--     select ip from public.wikipedia_edits limit 1;
--   rollback;
--
--   -- Expect false, true, true.
--   select has_column_privilege('anon', 'public.wikipedia_edits', 'ip', 'select')        as anon_ip,
--          has_column_privilege('anon', 'public.wikipedia_edits', 'anonymous', 'select') as anon_anonymous,
--          has_column_privilege('service_role', 'public.wikipedia_edits', 'ip', 'select') as service_ip;
--
-- Then load the site's edits page and stats and check they still render.
-- ---------------------------------------------------------------------------
