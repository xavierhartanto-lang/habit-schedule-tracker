-- =============================================================
-- Initial schema: profiles, preferences and user-owned planning data.
-- Every table is owned by a user and protected by Row Level Security.
-- =============================================================

create extension if not exists "pgcrypto";

-- ---------- Types ----------
create type public.life_area as enum
  ('academics', 'extracurricular', 'athletics', 'creative', 'personal', 'rest');
create type public.commitment_kind as enum ('fixed', 'flexible');
create type public.task_priority as enum ('high', 'medium', 'low');
create type public.task_status as enum ('todo', 'in_progress', 'done');
create type public.habit_cadence as enum ('daily', 'weekly');
create type public.goal_status as enum ('active', 'paused', 'completed');

-- ---------- Helpers ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- Profiles ----------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text check (char_length(display_name) <= 80),
  grade_level   smallint check (grade_level between 6 and 13),
  school        text check (char_length(school) <= 120),
  timezone      text not null default 'UTC',
  onboarded_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.user_preferences (
  user_id                     uuid primary key references auth.users (id) on delete cascade,
  week_starts_on              smallint not null default 1 check (week_starts_on in (0, 1)),
  day_start_time              time not null default '07:00',
  day_end_time                time not null default '22:30',
  ai_personalization_enabled  boolean not null default true,
  ai_memory_enabled           boolean not null default true,
  share_usage_analytics       boolean not null default false,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ---------- Goals (before tasks, which can reference them) ----------
create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  description  text,
  area         public.life_area not null,
  target_date  date,
  status       public.goal_status not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.goal_milestones (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  goal_id     uuid not null references public.goals (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  position    integer not null default 0,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- Commitments: fixed events and flexible work ----------
create table public.commitments (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 200),
  area               public.life_area not null,
  kind               public.commitment_kind not null,
  starts_at          timestamptz,
  ends_at            timestamptz,
  recurrence_rule    text,          -- RFC 5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR
  estimated_minutes  integer check (estimated_minutes > 0),
  due_at             timestamptz,
  location           text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint commitments_time_order check (ends_at is null or starts_at is null or ends_at > starts_at),
  -- Fixed commitments always have a time; flexible ones may be unplaced.
  constraint commitments_fixed_has_time check (kind = 'flexible' or (starts_at is not null and ends_at is not null))
);

-- ---------- Tasks ----------
create table public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  commitment_id      uuid references public.commitments (id) on delete set null,
  goal_id            uuid references public.goals (id) on delete set null,
  title              text not null check (char_length(title) between 1 and 300),
  area               public.life_area not null,
  priority           public.task_priority not null default 'medium',
  status             public.task_status not null default 'todo',
  due_at             timestamptz,
  estimated_minutes  integer check (estimated_minutes > 0),
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------- Habits ----------
create table public.habits (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 200),
  area            public.life_area not null,
  cadence         public.habit_cadence not null,
  times_per_week  smallint check (times_per_week between 1 and 7),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint habits_weekly_needs_target check (cadence = 'daily' or times_per_week is not null)
);

create table public.habit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  habit_id    uuid not null references public.habits (id) on delete cascade,
  logged_on   date not null,
  created_at  timestamptz not null default now(),
  unique (habit_id, logged_on)
);

-- ---------- Indexes ----------
create index commitments_user_time_idx on public.commitments (user_id, starts_at);
create index tasks_user_status_idx     on public.tasks (user_id, status, due_at);
create index habits_user_idx           on public.habits (user_id) where archived_at is null;
create index habit_logs_user_day_idx   on public.habit_logs (user_id, logged_on);
create index goals_user_idx            on public.goals (user_id, status);
create index goal_milestones_goal_idx  on public.goal_milestones (goal_id, position);

-- ---------- updated_at triggers ----------
do $$
declare t text;
begin
  foreach t in array array['profiles','user_preferences','goals','goal_milestones','commitments','tasks','habits']
  loop
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t, t);
  end loop;
end $$;

-- ---------- Row Level Security ----------
alter table public.profiles          enable row level security;
alter table public.user_preferences  enable row level security;
alter table public.goals             enable row level security;
alter table public.goal_milestones   enable row level security;
alter table public.commitments       enable row level security;
alter table public.tasks             enable row level security;
alter table public.habits            enable row level security;
alter table public.habit_logs        enable row level security;

-- Profiles and preferences are created by the signup trigger, so users
-- may read and update their own row but not insert or delete it.
create policy "profiles: read own"   on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "preferences: read own"   on public.user_preferences for select to authenticated using ((select auth.uid()) = user_id);
create policy "preferences: update own" on public.user_preferences for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Full CRUD on everything else, scoped to the owner.
do $$
declare t text;
begin
  foreach t in array array['goals','goal_milestones','commitments','tasks','habits','habit_logs']
  loop
    execute format('create policy "%1$s: read own"   on public.%1$I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- Child rows must point at a parent the same user owns.
create or replace function public.assert_same_owner()
returns trigger language plpgsql security invoker as $$
declare parent_owner uuid;
begin
  if tg_table_name = 'goal_milestones' then
    select user_id into parent_owner from public.goals where id = new.goal_id;
  elsif tg_table_name = 'habit_logs' then
    select user_id into parent_owner from public.habits where id = new.habit_id;
  end if;
  if parent_owner is distinct from new.user_id then
    raise exception 'Parent record not found';
  end if;
  return new;
end;
$$;

create trigger goal_milestones_same_owner before insert or update on public.goal_milestones
  for each row execute function public.assert_same_owner();
create trigger habit_logs_same_owner before insert or update on public.habit_logs
  for each row execute function public.assert_same_owner();

-- ---------- New user bootstrap ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''));
  insert into public.user_preferences (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The trigger function should not be callable through the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
