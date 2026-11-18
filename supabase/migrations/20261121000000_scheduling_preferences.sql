-- =============================================================
-- Phase 4: Scheduling preferences.
--
-- One row per user with the settings the deterministic scheduling
-- engine (src/lib/scheduling/planner) reads: when new work may be
-- placed, protected rest time, session lengths, buffers and how full a
-- day may get. A missing row means "use defaults" (derived in code from
-- user_preferences.day_start_time / day_end_time), so existing users
-- need no backfill.
--
-- The JSON columns are validated in the app (zod) and given a basic
-- shape check here. Owned by the user and protected by Row Level Security.
-- =============================================================

create table public.scheduling_preferences (
  user_id              uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- { "mo": [{"start":"15:30","end":"22:00"}], "tu": [...], ... "su": [] }
  working_hours        jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(working_hours) = 'object'),
  -- [{ "label": "Dinner", "days": ["mo","tu"], "start": "18:30", "end": "19:15" }]
  protected_times      jsonb not null default '[]'::jsonb
                       check (jsonb_typeof(protected_times) = 'array' and jsonb_array_length(protected_times) <= 30),
  min_session_minutes  smallint not null default 30  check (min_session_minutes between 15 and 240),
  max_session_minutes  smallint not null default 90  check (max_session_minutes between 15 and 480),
  buffer_minutes       smallint not null default 10  check (buffer_minutes between 0 and 60),
  daily_cap_minutes    smallint not null default 180 check (daily_cap_minutes between 0 and 720),
  keep_free_percent    smallint not null default 30  check (keep_free_percent between 0 and 90),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint scheduling_preferences_session_range check (min_session_minutes <= max_session_minutes)
);

create trigger scheduling_preferences_set_updated_at before update on public.scheduling_preferences
  for each row execute function public.set_updated_at();

alter table public.scheduling_preferences enable row level security;

create policy "scheduling_preferences: read own"   on public.scheduling_preferences for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "scheduling_preferences: insert own" on public.scheduling_preferences for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "scheduling_preferences: update own" on public.scheduling_preferences for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "scheduling_preferences: delete own" on public.scheduling_preferences for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.scheduling_preferences to authenticated;
