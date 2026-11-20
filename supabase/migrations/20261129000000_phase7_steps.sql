-- =============================================================
-- Phase 7.3: task steps and exam prep.
--
-- 1. tasks.parent_task_id: a step of a bigger task is a real task, so it
--    gets its own estimate, due date, sessions and completion through every
--    existing system. One level only (a step has no steps), and a step
--    always belongs to the same user as its parent.
--    If the parent is deleted, its steps stay as ordinary tasks (set null):
--    nothing the user wrote is lost silently.
-- 2. recommendations.kind accepts 'exam_prep' (an exam soon with nothing
--    planned to study for it).
--
-- Additive only: no existing row changes, no data is deleted. Older app
-- versions ignore the new column. RLS is unchanged.
-- Depends on 20261128000000_phase7_intelligence.sql.
-- =============================================================

-- ---------- 1. Steps ----------
alter table public.tasks
  add column if not exists parent_task_id uuid references public.tasks (id) on delete set null;

alter table public.tasks drop constraint if exists tasks_parent_not_self;
alter table public.tasks add constraint tasks_parent_not_self check (parent_task_id is null or parent_task_id <> id);

create index if not exists tasks_parent_idx on public.tasks (user_id, parent_task_id)
  where parent_task_id is not null;

-- Same owner, one level. A foreign key alone would accept another user's
-- task id (key checks bypass row level security).
create or replace function public.tasks_check_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent record;
begin
  if new.parent_task_id is null then
    return new;
  end if;
  select user_id, parent_task_id into parent from public.tasks where id = new.parent_task_id;
  if not found or parent.user_id <> new.user_id then
    raise exception 'parent task not found' using errcode = '23503';
  end if;
  if parent.parent_task_id is not null then
    raise exception 'a step cannot have steps' using errcode = '23514';
  end if;
  if exists (select 1 from public.tasks where parent_task_id = new.id) then
    raise exception 'a task with steps cannot become a step' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_check_parent on public.tasks;
create trigger tasks_check_parent
  before insert or update of parent_task_id on public.tasks
  for each row execute function public.tasks_check_parent();

-- ---------- 2. New recommendation kind ----------
alter table public.recommendations drop constraint if exists recommendations_kind_check;
alter table public.recommendations add constraint recommendations_kind_check check (kind in (
  'deadline_soon', 'start_early', 'deadline_at_risk', 'overdue', 'postponed',
  'missed_session', 'overload_day', 'overload_week', 'plan_broken',
  'commitment_conflict', 'deadline_cluster', 'neglected_area',
  'exam_prep'));
