-- =============================================================
-- Phase 7.6: weekly briefings.
--
-- One row per user per week (week_start = the first local day of the week
-- the briefing is about). It caches what the briefing was built from and
-- the short AI summary, so the AI runs at most once per week and again
-- only when the facts that matter change (facts_hash). It also remembers
-- when Home showed it and when the user dismissed it, so it never repeats.
--
-- The facts themselves are always rebuilt from live data on every load;
-- this row is a cache, never the source of truth. Deleting it is safe.
--
-- Additive only: a new table, nothing existing changes. RLS: owner only.
-- =============================================================

create table if not exists public.weekly_briefings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  week_start     date not null,
  -- Hash of the facts the summary was written from (see lib/insights/weekly.ts factsHash).
  facts_hash     text not null check (char_length(facts_hash) between 1 and 64),
  -- The deterministic facts at generation time, for debugging and auditing the summary.
  facts          jsonb not null default '{}'::jsonb,
  -- Null when the AI is off or its answer failed validation.
  summary        text check (summary is null or char_length(summary) between 1 and 1000),
  generated_at   timestamptz not null default now(),
  shown_at       timestamptz,
  dismissed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, week_start)
);

drop trigger if exists weekly_briefings_set_updated_at on public.weekly_briefings;
create trigger weekly_briefings_set_updated_at before update on public.weekly_briefings
  for each row execute function public.set_updated_at();

alter table public.weekly_briefings enable row level security;

drop policy if exists "weekly_briefings: read own" on public.weekly_briefings;
drop policy if exists "weekly_briefings: insert own" on public.weekly_briefings;
drop policy if exists "weekly_briefings: update own" on public.weekly_briefings;
drop policy if exists "weekly_briefings: delete own" on public.weekly_briefings;

create policy "weekly_briefings: read own"   on public.weekly_briefings for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "weekly_briefings: insert own" on public.weekly_briefings for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "weekly_briefings: update own" on public.weekly_briefings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "weekly_briefings: delete own" on public.weekly_briefings for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.weekly_briefings to authenticated;
