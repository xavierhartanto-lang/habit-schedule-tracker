-- =============================================================
-- Phase 7.2: contextual intelligence.
--
-- 1. recommendations.kind accepts three new detector kinds:
--      commitment_conflict  two fixed events overlap ("which one is right?")
--      deadline_cluster     several deadlines bunched together that only fit
--                           if work starts earlier
--      neglected_area       a life area that has had no time lately (7.6)
-- 2. commitments gain a session outcome, so Whitespace can compare plans
--    with reality: did a scheduled work session happen?
--      outcome         'done' | 'partial' | 'missed' (null = not recorded)
--      outcome_at      when it was recorded
--      outcome_source  'user' (the user said so) or 'task_done' (the task
--                      was marked done, so its past sessions count as done)
--
-- Additive only: no existing row changes, no data is deleted. Older app
-- versions ignore the new columns. RLS is unchanged (rows stay the user's own).
-- Depends on 20261124000000_proactive_recommendations.sql.
-- =============================================================

-- ---------- 1. New recommendation kinds ----------
alter table public.recommendations drop constraint if exists recommendations_kind_check;
alter table public.recommendations add constraint recommendations_kind_check check (kind in (
  'deadline_soon', 'start_early', 'deadline_at_risk', 'overdue', 'postponed',
  'missed_session', 'overload_day', 'overload_week', 'plan_broken',
  'commitment_conflict', 'deadline_cluster', 'neglected_area'));

-- ---------- 2. Session outcomes (plan vs reality) ----------
alter table public.commitments
  add column if not exists outcome        text check (outcome in ('done', 'partial', 'missed')),
  add column if not exists outcome_at     timestamptz,
  add column if not exists outcome_source text check (outcome_source in ('user', 'task_done'));

alter table public.commitments drop constraint if exists commitments_outcome_complete;
alter table public.commitments add constraint commitments_outcome_complete check (
  (outcome is null) = (outcome_at is null) and (outcome is null) = (outcome_source is null)
);

-- Outcome history for later learning ("sessions on Fridays are often missed").
create index if not exists commitments_outcome_idx on public.commitments (user_id, outcome_at)
  where outcome is not null;
