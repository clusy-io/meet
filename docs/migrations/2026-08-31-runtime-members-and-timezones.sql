-- Runtime roster + per-member timezone upgrade for existing Clusy Meet installs.
-- Additive and rerunnable. Apply before deploying code that reads meet_members.

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

create index if not exists meet_bookings_page_start
  on public.meet_bookings (page_key, start_at);

create index if not exists meet_bookings_attendee_keys
  on public.meet_bookings using gin (attendee_member_keys);

alter table public.meet_members enable row level security;

notify pgrst, 'reload schema';
