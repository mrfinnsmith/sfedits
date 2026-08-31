-- sfedits#7: a home for the Wikipedia edits the SF Edits bot has already
-- posted, written by the bot and read by the site.
--
-- The bot is not part of this repository. It runs on its own DigitalOcean
-- droplet, watches the Wikipedia IRC recent-changes feed, screens each
-- candidate edit for PII, and posts the survivors to Bluesky and Mastodon.
-- Its work is currently invisible here: the site can link to a social account
-- but cannot render, count, or archive anything the bot has done. This
-- migration gives that history a table.
--
-- WHERE THIS RUNS, AND WHY THAT DECIDES EVERYTHING BELOW.
--
-- This table lives in its own brand new Supabase project, in its own
-- organization, holding nothing else. An earlier draft of this file targeted a
-- large shared project and was built around that: a dedicated sfedits_writer
-- role, a hand-minted JWT, a `grant sfedits_writer to authenticator`, and a
-- SECURITY DEFINER function as the only write path -- all of it there to keep
-- a leaked key on the droplet from reaching the rest of that schema. There is
-- no rest of the schema here. The bot holds this project's secret key
-- (sb_secret_..., which maps to the service_role Postgres role and bypasses
-- RLS), and the entire reach of that key is one database containing one table
-- of already-public Wikipedia diff links. Every one of those mechanisms is
-- therefore deleted rather than ported: each cost a moving part and bought
-- isolation from data that does not exist.
--
-- The other reason to keep this file plain: the project is shared with an
-- outside code contributor. A schema that is one table, one index, one policy
-- and four grants is a schema they can read in a minute and cannot
-- accidentally subvert. A custom role and a definer function would be two
-- objects whose purpose is invisible from the table alone.
--
-- The rows are reader-facing the moment they are written. There is no draft
-- state here and no editorial review: by construction a row exists only
-- because the edit was already published to two public social accounts. So
-- readers get a direct SELECT grant and a permissive `using (true)` policy,
-- and there is deliberately no view in front of the table -- a view exists to
-- hide rows or columns, and there is nothing here to hide.
--
-- POSTED EDITS ONLY. This is the load-bearing rule of the whole design and it
-- is restated in the table comment. The bot screens every candidate edit for
-- PII and declines to post the ones that fail; a declined edit must never
-- reach this table, because a row here is a diff URL the site will render and
-- link to. Writing withheld edits here -- even with a flag, even unpublished
-- -- would put the exact diffs the screening rejected inside the one system
-- whose job is to publish things, and one wrong query or one loosened policy
-- would republish them. The screening decision therefore stays where it is
-- made, and the insert below happens only after a successful post. The IP
-- address of an anonymous editor is never stored at all, only the two-letter
-- country the bot derived from it via MaxMind.
--
-- PROJECT SETTINGS THIS FILE ASSUMES. The project was created with
-- "Automatically expose new tables" DISABLED and "Enable automatic RLS"
-- ENABLED. So a new table arrives with RLS already turned on by an event
-- trigger and with NO privileges handed to the Data API roles. Both halves are
-- handled explicitly below anyway: the `enable row level security` is written
-- out rather than trusted to the trigger, so this file is correct if it is
-- ever replayed into a project without that setting, and every grant a role
-- needs is stated, because nothing is granted for us.
--
-- Additive and safe to run twice: create-if-not-exists for the table and the
-- index, drop-then-add for the policy, and grants and revokes are idempotent
-- by nature. No begin/commit -- the Supabase CLI wraps each migration file in
-- its own transaction, and the dashboard SQL editor runs a pasted script as
-- one statement batch.


-- ---------------------------------------------------------------------------
-- 1. One row per posted edit.
--
--    diff_url is the natural key and carries the unique constraint. It is
--    Wikipedia's own permanent URL for a specific revision, so two rows with
--    the same diff_url are the same edit by definition, and the uniqueness is
--    what makes the writer in section 3 safe to retry. id exists anyway
--    because the site needs a stable, opaque handle for a row that is nicer
--    to put in a URL or a React key than a Wikipedia diff link.
--
--    editor and editor_country are mutually exclusive in practice and both
--    are nullable: a registered edit has a username and no country, an
--    anonymous edit has a country derived from the IP and no username, and an
--    edit the bot could not geolocate has neither. No check constraint
--    enforces the pairing, because the bot is the only writer and a row it
--    cannot classify is better stored plainly than rejected at 3am with
--    nothing to retry into.
--
--    posted_at is when the bot posted to social, supplied by the caller.
--    created_at is when this row landed, defaulted here. They differ whenever
--    a post succeeded and the insert after it had to be retried, which is
--    exactly the case the on-conflict in section 3 exists for, so collapsing
--    them into one column would lose the ability to see that happen.
-- ---------------------------------------------------------------------------

create table if not exists public.wikipedia_edits (
  id             bigint generated by default as identity primary key,
  article_title  text not null,
  lang           text not null,
  editor         text,
  editor_country text,
  diff_url       text not null unique,
  posted_at      timestamptz not null,
  created_at     timestamptz not null default now()
);

comment on table public.wikipedia_edits is
  'sfedits#7: Wikipedia edits the SF Edits bot has already POSTED to Bluesky and Mastodon. Posted edits only -- an edit withheld by the bot PII screening must never be written here, so nothing in this schema can republish a diff the bot declined to post. The editor IP is never stored, only editor_country.';

comment on column public.wikipedia_edits.diff_url is
  'Wikipedia permanent revision URL. Natural key: unique, and the conflict target the bot relies on to retry a record that failed after the social post already went out.';

comment on column public.wikipedia_edits.editor_country is
  'Two-letter country the bot derived from an anonymous editor IP via MaxMind. The IP itself is never stored. Null for registered editors and for edits that could not be geolocated.';

comment on column public.wikipedia_edits.posted_at is
  'When the bot posted to Bluesky and Mastodon, supplied by the bot. created_at is when the row landed; the gap between them is a retried record.';

-- The site reads this newest-first and nothing else. No partial predicate:
-- posted_at is not null, so every row belongs in the index.
create index if not exists wikipedia_edits_posted_at_idx
  on public.wikipedia_edits (posted_at desc);


-- ---------------------------------------------------------------------------
-- 2. Readers. RLS on explicitly, then SELECT handed to the two Data API
--    reader roles plus a permissive policy.
--
--    Both halves are required and neither substitutes for the other: a role
--    with no table privilege gets 42501 no matter how permissive the policy
--    is, and a role with the privilege but no policy sees zero rows once RLS
--    is on. "Enable automatic RLS" gives us the first half of the second
--    sentence; the grant and the policy are ours to write.
--
--    Every row is publishable by construction -- see the POSTED EDITS ONLY
--    note in the header -- so the policy is `using (true)` and there is
--    nothing for a view to filter.
--
--    anon is the role the publishable key (sb_publishable_...) maps to, which
--    is how the site reads. authenticated is granted alongside it not because
--    this project has users today but because a policy that discriminates
--    between the two would be lying: an authenticated reader of a table of
--    public Wikipedia diffs sees exactly what an anonymous one sees.
-- ---------------------------------------------------------------------------

alter table public.wikipedia_edits enable row level security;

-- Belt and braces before granting: start from nothing, so a replay into a
-- project where "Automatically expose new tables" was left ON does not
-- silently inherit INSERT/UPDATE/DELETE for anon, or UPDATE/DELETE for
-- service_role. service_role is granted back exactly INSERT in section 3.
revoke all on table public.wikipedia_edits from public, anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

grant select on table public.wikipedia_edits to anon, authenticated;

drop policy if exists "posted wikipedia edits are public" on public.wikipedia_edits;
create policy "posted wikipedia edits are public"
  on public.wikipedia_edits for select to anon, authenticated
  using (true);


-- ---------------------------------------------------------------------------
-- 3. The writer: a direct INSERT by the bot, not a SECURITY DEFINER function.
--
--    DECISION. The earlier draft routed every write through
--    public.record_wikipedia_edit(), a SECURITY DEFINER function, and revoked
--    INSERT from everyone. That was the right call there and is the wrong call
--    here, so it is gone.
--
--    The case FOR keeping it, stated fairly: a definer function is a narrow
--    door. It fixes the column list, so a caller cannot set created_at or
--    stuff an id; it hard-codes the on-conflict behaviour, so idempotency
--    cannot be forgotten at a call site; and it means the only privilege the
--    writer needs is EXECUTE on one function rather than INSERT on a table,
--    which normally shrinks what a leaked key can do.
--
--    Why that last clause does not apply. The bot authenticates with this
--    project's secret key, which maps to service_role. service_role holds
--    BYPASSRLS and, on a Supabase project, is the role the Data API uses for
--    privileged access; a definer function does not stand between it and the
--    table, because whoever holds that key can also just be granted, or grant
--    itself, anything else in this database. Wrapping the insert would be a
--    lock on a door in a building with one room, whose only key the bot
--    already has. The isolation the function bought in the shared project came
--    from the caller being sfedits_writer, a role with no table privileges at
--    all -- and that role is exactly what this project no longer needs.
--
--    So: direct INSERT, and the two smaller benefits are recovered elsewhere.
--    The column list is not a real risk (created_at has a default the bot has
--    no reason to override; id is `generated by default` so a supplied id is
--    possible but harmless and the unique constraint on diff_url still holds).
--    Idempotency is not left to a call site's memory either, because it is
--    enforced by the schema: `diff_url text not null unique` means a duplicate
--    record attempt fails loudly rather than quietly duplicating, and the bot
--    asks for it to be ignored.
--
--    HOW `on conflict (diff_url) do nothing` REACHES THE SERVER. This is the
--    requirement that made the function attractive, so it must work over the
--    direct path too. The bot posts to social first and records second, so a
--    network failure between those steps leaves a published post and no row,
--    and the retry must not raise and must not duplicate. Over PostgREST that
--    is an upsert with duplicates ignored:
--
--      supabase.from('wikipedia_edits')
--        .upsert(row, { onConflict: 'diff_url', ignoreDuplicates: true })
--
--    which sends `Prefer: resolution=ignore-duplicates` and executes
--    `insert ... on conflict (diff_url) do nothing` server-side. A plain
--    .insert() would return 409 on the retry instead. Note that ignoring
--    duplicates, not merging them, is deliberate: the first row recorded the
--    post that actually went out, and a retry must not overwrite its
--    posted_at.
--
--    A direct connection (psql, or any client that is not PostgREST) writes
--    the same statement literally.
--
--    Not granted: UPDATE and DELETE. A posted edit is a historical fact and
--    the bot has no correction workflow. If one is ever needed it should
--    arrive as its own migration with its own reasoning, not as a privilege
--    handed out today in case.
-- ---------------------------------------------------------------------------

-- INSERT alone is not enough. `insert ... on conflict (diff_url) do nothing`
-- must read the arbiter index to decide whether a row already exists, and
-- Postgres requires SELECT on the conflict target to do that: with INSERT only,
-- the retry fails 42501 "permission denied for table wikipedia_edits" instead
-- of quietly doing nothing. Verified against this project on 2026-08-31, where
-- the first insert returned 201 and the identical retry returned 403 until
-- SELECT was granted. Idempotency is the entire reason the unique constraint
-- exists, so the grant that makes it work belongs here next to it.
--
-- Still no UPDATE and no DELETE: the bot appends, and nothing it holds should
-- be able to rewrite or erase what it already published.
grant insert, select on table public.wikipedia_edits to service_role;

-- The identity column draws from a sequence, and INSERT on the table is not
-- enough on its own: a nextval() on a sequence the role holds no USAGE on
-- fails with 42501. Granted by name via pg_get_serial_sequence so this stays
-- correct if the table is ever recreated with a different sequence name, and
-- so it does not sweep in every other sequence in the schema.
do $do$
declare
  seq text := pg_get_serial_sequence('public.wikipedia_edits', 'id');
begin
  if seq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated, service_role', seq);
    execute format('grant usage, select on sequence %s to service_role', seq);
  end if;
end
$do$;

-- anon and authenticated are left with SELECT and nothing else. They are not
-- granted the sequence either: USAGE would let a reader burn ids, and SELECT
-- on the sequence would leak how many rows have ever existed, including any
-- the bot later deleted.


-- ---------------------------------------------------------------------------
-- 4. Make the new table visible to the Data API.
--
--    PostgREST caches the schema. A table created by a migration is not
--    reachable over the REST endpoint until that cache is reloaded, which
--    otherwise happens on its own schedule or on a project restart. This
--    notification is the supported nudge and is harmless if PostgREST is not
--    listening.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
