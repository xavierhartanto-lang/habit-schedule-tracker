-- =============================================================
-- Google Calendar: two-way (Whitespace can edit, move and remove
-- Google events).
--
-- google_connections.can_write: the user granted calendar.events.
--   Connections made before this stay read-only until they reconnect.
-- google_calendars.access_role: Google's role on that calendar
--   (owner / writer can change events; reader / freeBusyReader can't).
-- commitments:
--   external_series_id: the repeating Google event an occurrence belongs to,
--     so "every Debate Club" changes the series, not one day.
--   external_access: what Whitespace may do to this event in Google:
--     read, delete (remove it from your calendar), or edit (also move/rename;
--     only events you organize, or whose organizer lets guests edit).
--   external_shared: other people are invited. Bulk changes ("clear
--     tomorrow") leave these alone; a direct ask still works.
--
-- Additive only. Filled by the next sync.
-- =============================================================

alter table public.google_connections
  add column if not exists can_write boolean not null default false;

alter table public.google_calendars
  add column if not exists access_role text
    check (access_role is null or access_role in ('owner', 'writer', 'reader', 'freeBusyReader'));

alter table public.commitments
  add column if not exists external_series_id text
    check (external_series_id is null or char_length(external_series_id) <= 1024),
  add column if not exists external_access text
    check (external_access is null or external_access in ('read', 'delete', 'edit')),
  add column if not exists external_shared boolean not null default false;

create index if not exists commitments_external_series_idx on public.commitments (user_id, external_calendar_id, external_series_id)
  where external_series_id is not null;
