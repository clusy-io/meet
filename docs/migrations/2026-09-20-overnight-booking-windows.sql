-- meet: overnight booking windows (2026-09-20)
--
-- Lets a booking page open at 08:00 and close at 02:00 the next day.
--
-- window_end_min was capped at 1440 and had to be strictly greater than
-- window_start_min, which together made an overnight window unexpressible.
-- The column now carries minutes from midnight on the day the window OPENS,
-- so an overnight close keeps counting past 1440 (02:00 the next day is
-- 1560) and still sits after the open. Spans are capped at 24 hours.
--
-- Safe while older instances are still serving: every existing value is
-- <= 1440 and unchanged, and this only widens what the table accepts. Older
-- code reads those rows exactly as before.
--
-- Also applied by docs/schema.sql, which is idempotent.

-- Overnight booking windows (2026-09-20).
--
-- window_end_min used to be capped at 1440, which made "open 08:00, close
-- 02:00" unexpressible: the close had to be readable as a later number than
-- the open. It now carries minutes from midnight on the OPENING day, so an
-- overnight close counts on past 1440 (02:00 the next day is 1560) and stays
-- greater than the open. Existing rows are all <= 1440 and satisfy the new
-- bounds unchanged, so this only widens what is accepted.
--
-- The original checks were created anonymously, so they are found by what
-- they constrain rather than by name, then replaced with named ones.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.meet_page_settings'::regclass
      and con.contype = 'c'
      and con.conname not in (
        'meet_page_settings_window_start_range',
        'meet_page_settings_window_end_range',
        'meet_page_settings_window_order'
      )
      and pg_get_constraintdef(con.oid) like '%window_%_min%'
  loop
    execute format(
      'alter table public.meet_page_settings drop constraint %I',
      constraint_name
    );
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_page_settings_window_start_range'
      and conrelid = 'public.meet_page_settings'::regclass
  ) then
    alter table public.meet_page_settings
      add constraint meet_page_settings_window_start_range
      check (window_start_min between 0 and 1439);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_page_settings_window_end_range'
      and conrelid = 'public.meet_page_settings'::regclass
  ) then
    alter table public.meet_page_settings
      add constraint meet_page_settings_window_end_range
      check (window_end_min between 0 and 2880);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'meet_page_settings_window_order'
      and conrelid = 'public.meet_page_settings'::regclass
  ) then
    alter table public.meet_page_settings
      add constraint meet_page_settings_window_order
      check (
        window_start_min is null
        or window_end_min is null
        or (
          window_start_min < window_end_min
          and window_end_min - window_start_min <= 1440
        )
      );
  end if;
end $$;

notify pgrst, 'reload schema';
