-- sfedits#17: one-time fix for edits by Wikipedia temporary accounts.
--
-- Since January 2026 Wikipedia shows logged-out editors as temporary accounts
-- ("~2026-42504-55") instead of IP addresses. Until sfedits#14 the bot stored
-- those edits as registered: editor = the temporary-account name, no country.
-- This makes them look like every other anonymous row: editor null. The
-- country stays null because these edits never had an IP to look up.
--
-- Run it once, after the bot with the #14 fix is deployed, so no new wrong
-- rows arrive afterwards. Clearing the names can't be undone here, but the
-- same names are still in the public Bluesky posts.
--
-- The bot's key has no UPDATE on this table on purpose (see the first
-- migration), so this runs as postgres: Supabase SQL editor or
-- `supabase db push`. Safe to run twice: the second run matches nothing.

update public.wikipedia_edits
   set editor = null
 where editor ~ '^~[0-9]{4}-[0-9]+-[0-9]+$';

-- Check afterwards; expect 0:
--   select count(*) from public.wikipedia_edits
--    where editor ~ '^~[0-9]{4}-[0-9]+-[0-9]+$';
