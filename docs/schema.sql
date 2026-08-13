-- clusy/meet — Supabase / Postgres schema.
-- Additive and rerunnable. CREATE TABLE provisions new installations; the
-- ALTER statements below upgrade installations created before guest support
-- and reminder delivery were added. Apply via the Supabase SQL editor or psql,
-- then: NOTIFY pgrst, 'reload schema';

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
  constraint meet_bookings_time_order check (end_at > start_at)
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
create unique index if not exists meet_bookings_confirmed_slot
  on public.meet_bookings (start_at)
  where status = 'confirmed';

create index if not exists meet_bookings_range
  on public.meet_bookings (start_at)
  where status = 'confirmed';

-- Reject overlapping confirmed ranges, not only identical start timestamps.
-- btree_gist is available on Supabase. Existing deployments must resolve any
-- overlapping rows before this additive constraint can be installed.
create extension if not exists btree_gist;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_bookings_no_overlap'
      and conrelid = 'public.meet_bookings'::regclass
  ) then
    alter table public.meet_bookings
      add constraint meet_bookings_no_overlap
      exclude using gist (tstzrange(start_at, end_at, '[)') with &&)
      where (status = 'confirmed');
  end if;
end $$;

-- Service-role access only: RLS on with no policies means anon/authenticated
-- API keys can read nothing; the meet backend uses the service-role key.
alter table public.meet_accounts enable row level security;
alter table public.meet_bookings enable row level security;
