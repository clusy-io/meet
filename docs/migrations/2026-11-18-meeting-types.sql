-- Booking types and cross-page Investor host reservations (2026-11-18).
-- Apply before deploying the booking type selector. Existing bookings keep
-- NULL and their previous team or personal-page behavior. PostgreSQL 14+.
-- The same definitions are included in docs/schema.sql.

alter table public.meet_bookings
  add column if not exists meeting_type text check (meeting_type in ('chat', 'meeting', 'investor'));

-- Represent each host key as a singleton range so GiST can test set overlap.
-- Binary ordering preserves the application's exact member-key comparison.
do $$
begin
  if to_regtype('public.meet_key_range') is null then
    create type public.meet_key_range as range (
      subtype = text, collation = "C", multirange_type_name = public.meet_key_multirange
    );
  end if;
end $$;

create or replace function public.meet_booking_host_ranges(keys jsonb)
returns public.meet_key_multirange
language sql immutable strict parallel safe
set search_path = pg_catalog
as $$
  select case when keys = '[]'::jsonb then
    -- An unassigned legacy booking occupies every host in availability.
    public.meet_key_multirange(public.meet_key_range(null, null))
  else
    (select range_agg(public.meet_key_range(key, key, '[]'))
     from jsonb_array_elements_text(keys) as hosts(key))
  end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_bookings_investor_host_overlap'
      and conrelid = 'public.meet_bookings'::regclass
  ) then
    alter table public.meet_bookings
      add constraint meet_bookings_investor_host_overlap exclude using gist (
        tstzrange(start_at, end_at, '[)') with &&,
        public.meet_booking_host_ranges(attendee_member_keys) with &&,
        -- Distinct non-Investor rows have disjoint IDs. Investor spans all
        -- IDs so a clash on time and host rejects a write in either order.
        (case when meeting_type = 'investor' then public.meet_key_range(null, null)
              else public.meet_key_range(id::text, id::text, '[]') end) with &&
      ) where (status = 'confirmed');
  end if;
end $$;

notify pgrst, 'reload schema';
