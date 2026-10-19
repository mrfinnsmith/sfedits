-- RETIRED (sfedits#25). This migration intentionally does nothing.
--
-- It used to be the sfedits#17 one-time fix, run once in the Supabase SQL
-- editor: `update public.wikipedia_edits set editor = null where editor ~
-- '^~[0-9]{4}-[0-9]+-[0-9]+$'`. That erased the temporary-account names
-- ("~2026-42504-55") from past edits.
--
-- It was superseded by sfedits#22 (editor keeps the username exactly as
-- Wikipedia gives it, plus new ip and anonymous columns) and sfedits#25
-- (scripts/backfill-editors.js restores the names from Wikipedia). Replaying
-- the old update, for example through `supabase db push`, would erase the
-- restored names again, so its body is removed.
--
-- The file and its version are kept so local and remote migration history
-- stay in sync if this version was ever recorded.

select 1;
