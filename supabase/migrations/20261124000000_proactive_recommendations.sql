-- =============================================================
-- Phase 5: Proactive intelligence.
--
-- 1. scheduling_preferences gains the assistant's proactivity level and
--    quiet hours (extends the Phase 4 settings row; no new settings table).
-- 2. tasks gain postpone tracking, kept up to date by triggers: an open
--    task's due date moving later, or a Whitespace work session for it
--    moving later, counts as one postponement.
-- 3. recommendations: what the deterministic detectors found, one row per
--    (user, dedupe_key), so a recommendation is never duplicated and an
--    acknowledged one never comes back for the same situation.
--
-- Recommendations never change the user's data. Acting on one creates a
-- normal Phase 4 plan (plan_proposals) that the user approves.
-- Owned by the user and protected by Row Level Security.
-- Depends on 20261122000000_assistant_plans.sql (plan_proposals, commitments.task_id).
-- =============================================================

-- ---------- 1. Proactivity settings ----------
alter table public.scheduling_preferences
  add column proactivity       text not null default 'balanced'
                               check (proactivity in ('minimal', 'balanced', 'proactive')),
  -- Local wall-clock times in the profile time zone. Both null = no quiet hours.
  -- end < start crosses midnight (22:00 -> 07:00).
  add column quiet_hours_start time,
  add column quiet_hours_end   time,
  add constraint scheduling_preferences_quiet_hours check (
    (quiet_hours_start is null) = (quiet_hours_end is null)
    and (quiet_hours_start is null or quiet_hours_start <> quiet_hours_end)
  );

-- ---------- 2. Postpone tracking ----------
alter table public.tasks
  add column postpone_count    smallint not null default 0 check (postpone_count between 0 and 1000),
  add column last_postponed_at timestamptz;

-- A due date moving later by more than an hour on an open task is a postponement.
create or replace function public.track_task_postpone()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.status <> 'done' and new.status <> 'done'
     and old.due_at is not null and new.due_at is not null
     and new.due_at > old.due_at + interval '1 hour' then
    new.postpone_count := least(old.postpone_count + 1, 1000);
    new.last_postponed_at := now();
  end if;
  return new;
end;
$$;

create trigger tasks_track_postpone before update of due_at on public.tasks
  for each row execute function public.track_task_postpone();

-- A Whitespace work session for a task moving later (to another day or
-- more than an hour later) also counts. Runs as the user; RLS applies.
create or replace function public.track_session_postpone()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.task_id is not null and new.plan_item_id is not null
     and old.starts_at is not null and new.starts_at is not null
     and new.starts_at > old.starts_at + interval '1 hour' then
    update public.tasks
       set postpone_count = least(postpone_count + 1, 1000),
           last_postponed_at = now()
     where id = new.task_id and user_id = new.user_id and status <> 'done';
  end if;
  return null;
end;
$$;

create trigger commitments_track_session_postpone after update of starts_at on public.commitments
  for each row execute function public.track_session_postpone();

revoke execute on function public.track_task_postpone() from public, anon, authenticated;
revoke execute on function public.track_session_postpone() from public, anon, authenticated;

-- ---------- 3. Recommendations ----------
create table public.recommendations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Identifies the situation, e.g. "deadline_soon:<task id>:<due date>".
  dedupe_key     text not null check (char_length(dedupe_key) between 1 and 200),
  kind           text not null check (kind in (
                   'deadline_soon', 'start_early', 'deadline_at_risk', 'overdue', 'postponed',
                   'missed_session', 'overload_day', 'overload_week', 'plan_broken')),
  priority       text not null check (priority in ('high', 'medium', 'low')),
  status         text not null default 'open' check (status in (
                   'open', 'proposed', 'snoozed', 'dismissed', 'acted', 'resolved')),
  title          text not null check (char_length(title) between 1 and 300),
  reason         text not null check (char_length(reason) between 1 and 1000),
  message        text not null check (char_length(message) between 1 and 1000),
  -- Supporting facts shown with the recommendation: ["Due Fri, Nov 27", ...].
  facts          jsonb not null default '[]'::jsonb
                 check (jsonb_typeof(facts) = 'array' and pg_column_size(facts) <= 4096),
  -- Suggested actions: [{ id, kind, label, params }]. Validated in the app.
  actions        jsonb not null default '[]'::jsonb
                 check (jsonb_typeof(actions) = 'array' and pg_column_size(actions) <= 8192),
  task_id        uuid references public.tasks (id) on delete cascade,
  commitment_ids uuid[] not null default '{}' check (cardinality(commitment_ids) <= 20),
  -- Local YYYY-MM-DD the recommendation is about (overloaded day), if any.
  target_date    date,
  plan_id        uuid references public.plan_proposals (id) on delete set null,
  snoozed_until  timestamptz,
  last_shown_at  timestamptz,
  shown_count    integer not null default 0 check (shown_count >= 0),
  -- Last time a detector still found this situation.
  last_seen_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create index recommendations_user_status_idx on public.recommendations (user_id, status);
create index recommendations_task_idx        on public.recommendations (task_id) where task_id is not null;
create index recommendations_plan_idx        on public.recommendations (plan_id) where plan_id is not null;

create trigger recommendations_set_updated_at before update on public.recommendations
  for each row execute function public.set_updated_at();

alter table public.recommendations enable row level security;

create policy "recommendations: read own"   on public.recommendations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "recommendations: insert own" on public.recommendations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "recommendations: update own" on public.recommendations for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "recommendations: delete own" on public.recommendations for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.recommendations to authenticated;

-- Linked task and plan must belong to the same user.
create or replace function public.assert_recommendation_links_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.task_id is not null
     and not exists (select 1 from public.tasks where id = new.task_id and user_id = new.user_id) then
    raise exception 'Task not found' using errcode = '23503';
  end if;
  if new.plan_id is not null
     and not exists (select 1 from public.plan_proposals where id = new.plan_id and user_id = new.user_id) then
    raise exception 'Plan not found' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger recommendations_links_owner before insert or update of task_id, plan_id, user_id
  on public.recommendations for each row execute function public.assert_recommendation_links_owner();

revoke execute on function public.assert_recommendation_links_owner() from public, anon, authenticated;
