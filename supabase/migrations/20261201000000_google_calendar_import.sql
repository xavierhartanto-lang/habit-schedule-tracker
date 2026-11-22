-- =============================================================
-- Google Calendar import (one-way: Google → Whitespace).
--
-- google_connections: one row per user who connected Google. Tokens are
--   encrypted by the server (AES-256-GCM) before they are stored, so the
--   row is useless outside this app even to its owner.
-- google_calendars: the user's Google calendars, which ones to import,
--   and the life area their events get.
-- commitments: imported events are ordinary fixed events with an
--   external key, so the calendar, Home and the planner all see them.
--   The unique key makes every sync an upsert: no duplicates.
--
-- Additive only. RLS: owner only.
-- =============================================================

create table if not exists public.google_connections (
  user_id                  uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  google_email             text check (google_email is null or char_length(google_email) <= 320),
  refresh_token            text not null check (char_length(refresh_token) between 1 and 4096),
  access_token             text check (access_token is null or char_length(access_token) <= 8192),
  access_token_expires_at  timestamptz,
  last_synced_at           timestamptz,
  last_sync_error          text check (last_sync_error is null or char_length(last_sync_error) <= 500),
  -- Set while a sync runs, so two tabs don't import at the same time.
  sync_started_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table if not exists public.google_calendars (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  google_calendar_id  text not null check (char_length(google_calendar_id) between 1 and 512),
  name                text not null check (char_length(name) between 1 and 200),
  color               text check (color is null or char_length(color) <= 16),
  is_primary          boolean not null default false,
  selected            boolean not null default false,
  life_area_id        uuid references public.life_areas (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, google_calendar_id)
);

alter table public.commitments
  add column if not exists external_source      text check (external_source is null or external_source in ('google')),
  add column if not exists external_calendar_id text check (external_calendar_id is null or char_length(external_calendar_id) <= 512),
  add column if not exists external_id          text check (external_id is null or char_length(external_id) <= 1024),
  add column if not exists external_url         text check (external_url is null or char_length(external_url) <= 2048);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'commitments_external_complete') then
    alter table public.commitments add constraint commitments_external_complete check (
      (external_source is null and external_id is null and external_calendar_id is null)
      or (external_source is not null and external_id is not null and external_calendar_id is not null)
    );
  end if;
  -- Nulls are distinct, so manual events are unaffected.
  if not exists (select 1 from pg_constraint where conname = 'commitments_external_key') then
    alter table public.commitments add constraint commitments_external_key
      unique (user_id, external_source, external_calendar_id, external_id);
  end if;
end $$;

-- A calendar's life area must belong to the same user.
create or replace function public.assert_google_calendar_area_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.life_area_id is not null
     and not exists (select 1 from public.life_areas where id = new.life_area_id and user_id = new.user_id) then
    raise exception 'Life area not found' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists google_calendars_area_owner on public.google_calendars;
create trigger google_calendars_area_owner before insert or update of life_area_id, user_id on public.google_calendars
  for each row execute function public.assert_google_calendar_area_owner();

drop trigger if exists google_connections_set_updated_at on public.google_connections;
create trigger google_connections_set_updated_at before update on public.google_connections
  for each row execute function public.set_updated_at();
drop trigger if exists google_calendars_set_updated_at on public.google_calendars;
create trigger google_calendars_set_updated_at before update on public.google_calendars
  for each row execute function public.set_updated_at();

alter table public.google_connections enable row level security;
alter table public.google_calendars enable row level security;

do $$
declare t text;
begin
  foreach t in array array['google_connections','google_calendars']
  loop
    execute format('drop policy if exists "%1$s: read own" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: insert own" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: update own" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: delete own" on public.%1$I', t);
    execute format('create policy "%1$s: read own"   on public.%1$I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

create index if not exists google_calendars_user_idx on public.google_calendars (user_id);
create index if not exists commitments_external_idx on public.commitments (user_id, external_calendar_id)
  where external_source is not null;
