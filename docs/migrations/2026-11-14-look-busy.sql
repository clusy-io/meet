-- meet: "Make my calendar look busy" (2026-11-14)
--
-- Adds meet_page_settings.look_busy: how booked a page should look to
-- visitors ('light', 'balanced' or 'packed'), or null for off. Each person's
-- row holds their own level; the row with member_key '' (the team page's
-- page_key, as in meet_bookings) holds the team page's.
--
-- Safe in either order with the release: the column is nullable, every
-- existing row reads as off, and the store reads a missing column as off and
-- only writes it when a switch is changed. Until it exists, only saving a
-- switch fails.
--
-- Also applied by docs/schema.sql, which is idempotent.

alter table public.meet_page_settings
  add column if not exists look_busy text
    constraint meet_page_settings_look_busy_level
    check (look_busy in ('light', 'balanced', 'packed'));

notify pgrst, 'reload schema';
