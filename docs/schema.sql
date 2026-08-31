-- clusy/meet — Supabase / Postgres schema.
-- Additive and rerunnable. CREATE TABLE provisions new installations; the
-- ALTER statements below upgrade installations created before runtime members, guest support
-- and reminder delivery were added. Apply via the Supabase SQL editor or psql,
-- then: NOTIFY pgrst, 'reload schema';

-- Runtime roster overlay. MEET_MEMBERS remains the bootstrap/baseline roster;
-- rows here add people, override baseline identity, or soft-archive a stable
-- member key without deleting accounts, settings, or booking history.
create table if not exists public.meet_members (
  member_key text primary key,
  name text not null,
  email text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Keep persistence compatible with legacy MEET_MEMBERS keys. New runtime
  -- members are still held to route-safe key rules by the admin API.
  constraint meet_members_member_key_nonempty check (length(member_key) > 0),
  check (length(name) between 1 and 120),
  check (length(email) between 3 and 320)
);

-- CREATE TABLE IF NOT EXISTS cannot loosen checks installed by an earlier run.
-- Remove preview-era route/length checks while retaining the nonempty invariant.
do $$
declare
  stale_constraint text;
begin
  for stale_constraint in
    select constraint_row.conname
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.meet_members'::regclass
      and constraint_row.contype = 'c'
      and constraint_row.conname <> 'meet_members_member_key_nonempty'
      and pg_get_constraintdef(constraint_row.oid) like '%member_key%'
  loop
    execute format(
      'alter table public.meet_members drop constraint %I',
      stale_constraint
    );
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_members_member_key_nonempty'
      and conrelid = 'public.meet_members'::regclass
  ) then
    alter table public.meet_members
      add constraint meet_members_member_key_nonempty
      check (length(member_key) > 0);
  end if;
end $$;

create unique index if not exists meet_members_email_lower
  on public.meet_members (lower(email));

create table if not exists public.meet_accounts (
  id uuid primary key default gen_random_uuid(),
  member_key text not null,
  provider text not null check (provider in ('google', 'microsoft')),
  email text not null,
  refresh_token_enc text not null,
  selected_calendars jsonb not null default '[]'::jsonb,
  status text not null default 'ok' check (status in ('ok', 'reauth_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_key, provider, email)
);

create table if not exists public.meet_bookings (
  id uuid primary key,
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_minutes int not null constraint meet_bookings_duration_positive check (duration_minutes > 0),
  name text not null,
  email text not null,
  notes text,
  timezone text not null,
  attendee_member_keys jsonb not null default '[]'::jsonb,
  guests jsonb not null default '[]'::jsonb,
  event_refs jsonb not null default '[]'::jsonb,
  meeting_url text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  manage_token text not null unique,
  history jsonb not null default '[]'::jsonb,
  reminders_sent jsonb not null default '[]'::jsonb,
  sync_status text not null default 'synced' check (sync_status in ('synced', 'partial', 'failed')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint meet_bookings_time_order check (end_at > start_at),
  -- Which booking page produced this row: '' = the team page, a member key =
  -- that person's page (/<key>). Empty string rather than NULL on purpose:
  -- NULLs compare as DISTINCT in a unique index, so a nullable column would
  -- let two confirmed team bookings share one start_at and quietly destroy the
  -- race guarantee the index exists to provide.
  page_key text not null default ''
);

-- Upgrade earlier Meet installations. CREATE TABLE IF NOT EXISTS does not add
-- columns to a table that already exists, so later fields need explicit ALTERs.
alter table public.meet_bookings
  add column if not exists guests jsonb not null default '[]'::jsonb,
  add column if not exists reminders_sent jsonb not null default '[]'::jsonb;

-- Add integrity checks to installations created before they were part of the
-- base table definition. Resolve invalid legacy rows before applying.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_bookings_duration_positive'
      and conrelid = 'public.meet_bookings'::regclass
  ) then
    alter table public.meet_bookings
      add constraint meet_bookings_duration_positive check (duration_minutes > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_bookings_time_order'
      and conrelid = 'public.meet_bookings'::regclass
  ) then
    alter table public.meet_bookings
      add constraint meet_bookings_time_order check (end_at > start_at);
  end if;
end $$;

-- One confirmed booking per slot start. Cancelled rows free the slot.
-- Existing installations predate personal pages; every row they hold is a team
-- booking, which is what the '' default backfills them as (metadata-only on
-- PG 11+, no rewrite). Keep the default until the previous deployment has
-- drained: during a rolling deploy the old code still inserts without it.
alter table public.meet_bookings
  add column if not exists page_key text not null default '';

-- One confirmed booking per (page, slot start). Two DIFFERENT pages may hold
-- the SAME instant — that is the entire point of per-person pages, and the old
-- global index rejected the second one as a duplicate. One page may still not
-- hold it twice. Create the replacement BEFORE dropping the old guard so there
-- is never a window with no uniqueness arbiter.
create unique index if not exists meet_bookings_confirmed_page_slot
  on public.meet_bookings (page_key, start_at)
  where status = 'confirmed';

drop index if exists public.meet_bookings_confirmed_slot;

create index if not exists meet_bookings_range
  on public.meet_bookings (start_at)
  where status = 'confirmed';

create index if not exists meet_bookings_page_start
  on public.meet_bookings (page_key, start_at);

create index if not exists meet_bookings_attendee_keys
  on public.meet_bookings using gin (attendee_member_keys);

-- Reject overlapping confirmed ranges, not only identical start timestamps.
-- SCOPED BY page_key: without that scope one person's booking would block that
-- interval on every other page, which is exactly what per-person pages must
-- not do. btree_gist supplies the `=` operator for the text column as well as
-- the range overlap. Existing deployments must resolve any overlapping rows
-- before this additive constraint can be installed. An installation that
-- already has the unscoped version is upgraded in place by the block below.
create extension if not exists btree_gist;
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def
  from pg_constraint
  where conname = 'meet_bookings_no_overlap'
    and conrelid = 'public.meet_bookings'::regclass;

  -- Guard on the DEFINITION, not the name. An installation created before
  -- personal pages holds the UNSCOPED constraint under this same name, so a
  -- name-only check would skip and leave it in place — and every personal
  -- booking overlapping someone else's would then fail with 23P01. Re-running
  -- this file is documented as the whole upgrade path, so it has to heal that
  -- itself rather than ask the operator to drop anything by hand.
  --
  -- The drop and re-add take ACCESS EXCLUSIVE and rebuild the GiST index; on a
  -- fresh install both branches are skipped entirely.
  if def is not null and def not like '%page_key%' then
    alter table public.meet_bookings drop constraint meet_bookings_no_overlap;
    def := null;
  end if;

  if def is null then
    alter table public.meet_bookings
      add constraint meet_bookings_no_overlap
      exclude using gist (page_key with =, tstzrange(start_at, end_at, '[)') with &&)
      where (status = 'confirmed');
  end if;
end $$;

-- Per-person booking pages (/<member key>), editable at runtime from /admin.
-- One row per member key; every nullable column means "inherit the global
-- MEET_* value", so a page stores only its own overrides and raising the
-- team-wide window raises everyone's with it.
--
-- These live in the DB rather than in env precisely because they are edited
-- from the admin console: getMeetConfig() memoizes one object for the life of
-- the process, so an env-backed setting would need a redeploy to take effect
-- and would differ between instances until then.
--
-- A member with no row at all is a live page on fully inherited settings.
-- There is deliberately no FK to meet_members: bootstrap MEET_MEMBERS entries
-- need no overlay row. App code validates against the merged roster, and no
-- FK from meet_bookings.page_key means archive can never cascade into history.
create table if not exists public.meet_page_settings (
  member_key text primary key,
  enabled boolean not null default true,
  headline text,
  blurb text,
  timezone text,
  timezone_until_date text,
  timezone_until_zone text,
  window_start_min int check (window_start_min between 0 and 1440),
  window_end_min int check (window_end_min between 0 and 1440),
  bookable_weekdays jsonb,
  duration_minutes int check (duration_minutes > 0),
  slot_step_minutes int check (slot_step_minutes > 0),
  min_notice_minutes int check (min_notice_minutes >= 0),
  horizon_days int check (horizon_days between 0 and 366),
  event_title text,
  event_description text,
  -- AES-256-GCM (crypto.ts encryptSecret), never plaintext: a webhook URL is a
  -- live posting credential for the channel behind it, and it would otherwise
  -- sit in every database dump.
  slack_webhook_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    window_start_min is null
    or window_end_min is null
    or window_start_min < window_end_min
  ),
  constraint meet_page_settings_timezone_until_pair
    check ((timezone_until_date is null) = (timezone_until_zone is null))
);

alter table public.meet_page_settings
  add column if not exists timezone text,
  add column if not exists timezone_until_date text,
  add column if not exists timezone_until_zone text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_page_settings_timezone_until_pair'
      and conrelid = 'public.meet_page_settings'::regclass
  ) then
    alter table public.meet_page_settings
      add constraint meet_page_settings_timezone_until_pair
      check ((timezone_until_date is null) = (timezone_until_zone is null));
  end if;
end $$;

-- Service-role access only: RLS on with no policies means anon/authenticated
-- API keys can read nothing; the meet backend uses the service-role key.
alter table public.meet_accounts enable row level security;
alter table public.meet_bookings enable row level security;
alter table public.meet_page_settings enable row level security;
alter table public.meet_members enable row level security;

notify pgrst, 'reload schema';
