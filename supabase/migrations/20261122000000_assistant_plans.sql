-- =============================================================
-- Phase 4: AI actions and approvals.
--
-- Everything the assistant wants to change is stored as a *plan*
-- (plan_proposals) with one row per change (plan_items). Nothing in the
-- user's calendar, tasks, habits or goals changes until an item is
-- applied through apply_plan_items(), which runs in one transaction with
-- a per-user lock and an idempotency key.
--
-- Reuses existing tables for the records themselves:
--   commitments (events and assistant-scheduled work sessions), tasks,
--   habits, goals, context_items. Commitments gain links to the task a
--   session is for and to the plan item that created it.
--
-- Depends on 20261121000000_scheduling_preferences.sql only by order.
-- Every new table is owned by a user and protected by Row Level Security.
-- =============================================================

-- ---------- Types ----------
create type public.plan_kind as enum ('actions', 'schedule', 'reschedule');
create type public.plan_status as enum ('pending', 'partially_applied', 'applied', 'rejected', 'stale');
create type public.plan_item_status as enum ('pending', 'applied', 'rejected', 'conflict', 'failed', 'undone');

-- ---------- Plans ----------
create table public.plan_proposals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id    uuid references public.conversations (id) on delete set null,
  -- The assistant message that presented the plan, and the user message it answers.
  message_id         uuid references public.messages (id) on delete set null,
  source_message_id  uuid references public.messages (id) on delete set null,
  kind               public.plan_kind not null,
  status             public.plan_status not null default 'pending',
  summary            text check (summary is null or char_length(summary) <= 1000),
  -- Work the scheduler could not fit: [{title, minutes, reason}].
  unscheduled        jsonb not null default '[]'::jsonb
                     check (jsonb_typeof(unscheduled) = 'array' and pg_column_size(unscheduled) <= 8192),
  -- Engine inputs needed to find alternatives later (window, requests).
  context            jsonb not null default '{}'::jsonb
                     check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 32768),
  -- Bumped on every change, so clients can tell a plan moved under them.
  version            integer not null default 1 check (version >= 1),
  expires_at         timestamptz not null default (now() + interval '24 hours'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.plan_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  proposal_id  uuid not null references public.plan_proposals (id) on delete cascade,
  position     smallint not null check (position between 0 and 200),
  action       text not null check (action in (
                 'create_event', 'schedule_block', 'move_block', 'remove_block', 'skip_occurrence',
                 'create_task', 'update_task', 'complete_task',
                 'create_habit', 'update_habit',
                 'create_goal', 'update_goal',
                 'set_life_area', 'update_preferences', 'save_fact')),
  status       public.plan_item_status not null default 'pending',
  auto_applied boolean not null default false,
  title        text not null check (char_length(title) between 1 and 300),
  -- Validated input for the write. Re-validated on the server before applying.
  payload      jsonb not null default '{}'::jsonb
               check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  -- What the approval card shows: timing, reason, trade-offs, conflicts, warnings.
  display      jsonb not null default '{}'::jsonb
               check (jsonb_typeof(display) = 'object' and pg_column_size(display) <= 16384),
  target_id    uuid,
  result_id    uuid,
  -- How to revert an applied item (written by apply_plan_items).
  undo         jsonb check (undo is null or (jsonb_typeof(undo) = 'object' and pg_column_size(undo) <= 16384)),
  error        text check (error is null or char_length(error) <= 500),
  applied_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (proposal_id, position)
);

-- One row per approval request, so a retried or double-clicked approval
-- returns the first result instead of applying twice.
create table public.plan_approvals (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  request_id   uuid not null,
  proposal_id  uuid not null references public.plan_proposals (id) on delete cascade,
  result       jsonb not null default '[]'::jsonb check (pg_column_size(result) <= 16384),
  created_at   timestamptz not null default now(),
  primary key (user_id, request_id)
);

-- ---------- Links from records to plans ----------
alter table public.commitments
  -- The task a scheduled work session is for.
  add column task_id      uuid references public.tasks (id) on delete set null,
  -- The plan item that created this row. Set only for rows the assistant created.
  add column plan_item_id uuid references public.plan_items (id) on delete set null;

-- Unfinished follow-up questions in a conversation (drafts the assistant is
-- still collecting details for), so it never asks the same thing twice.
alter table public.conversations
  add column planning_state jsonb not null default '{}'::jsonb
    check (jsonb_typeof(planning_state) = 'object' and pg_column_size(planning_state) <= 16384);

-- ---------- Indexes ----------
create index plan_proposals_user_recent_idx  on public.plan_proposals (user_id, created_at desc);
create index plan_proposals_conversation_idx on public.plan_proposals (conversation_id) where conversation_id is not null;
create index plan_proposals_message_idx      on public.plan_proposals (message_id) where message_id is not null;
create index plan_proposals_source_msg_idx   on public.plan_proposals (source_message_id) where source_message_id is not null;
create index plan_items_proposal_idx         on public.plan_items (proposal_id, position);
create index plan_items_user_status_idx      on public.plan_items (user_id, status);
create index plan_approvals_proposal_idx     on public.plan_approvals (proposal_id);
create index commitments_task_idx            on public.commitments (task_id) where task_id is not null;
create index commitments_plan_item_idx       on public.commitments (plan_item_id) where plan_item_id is not null;

-- ---------- updated_at ----------
create trigger plan_proposals_set_updated_at before update on public.plan_proposals
  for each row execute function public.set_updated_at();
create trigger plan_items_set_updated_at before update on public.plan_items
  for each row execute function public.set_updated_at();

-- ---------- Row Level Security ----------
alter table public.plan_proposals enable row level security;
alter table public.plan_items     enable row level security;
alter table public.plan_approvals enable row level security;

do $$
declare t text;
begin
  foreach t in array array['plan_proposals', 'plan_items']
  loop
    execute format('create policy "%1$s: read own"   on public.%1$I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- Approvals are written only by apply_plan_items and never edited.
create policy "plan_approvals: read own"   on public.plan_approvals for select to authenticated using ((select auth.uid()) = user_id);
create policy "plan_approvals: insert own" on public.plan_approvals for insert to authenticated with check ((select auth.uid()) = user_id);

-- ---------- Ownership checks ----------
-- Children must point at parents the same user owns.
create or replace function public.assert_plan_links_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_table_name = 'plan_items' then
    if not exists (select 1 from public.plan_proposals where id = new.proposal_id and user_id = new.user_id) then
      raise exception 'Plan not found' using errcode = '23503';
    end if;
  elsif tg_table_name = 'plan_approvals' then
    if not exists (select 1 from public.plan_proposals where id = new.proposal_id and user_id = new.user_id) then
      raise exception 'Plan not found' using errcode = '23503';
    end if;
  elsif tg_table_name = 'plan_proposals' then
    if new.conversation_id is not null
       and not exists (select 1 from public.conversations where id = new.conversation_id and user_id = new.user_id) then
      raise exception 'Conversation not found' using errcode = '23503';
    end if;
    if new.message_id is not null
       and not exists (select 1 from public.messages where id = new.message_id and user_id = new.user_id) then
      raise exception 'Message not found' using errcode = '23503';
    end if;
    if new.source_message_id is not null
       and not exists (select 1 from public.messages where id = new.source_message_id and user_id = new.user_id) then
      raise exception 'Message not found' using errcode = '23503';
    end if;
  elsif tg_table_name = 'commitments' then
    if new.task_id is not null
       and not exists (select 1 from public.tasks where id = new.task_id and user_id = new.user_id) then
      raise exception 'Task not found' using errcode = '23503';
    end if;
    if new.plan_item_id is not null
       and not exists (select 1 from public.plan_items where id = new.plan_item_id and user_id = new.user_id) then
      raise exception 'Plan item not found' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

create trigger plan_proposals_links_owner before insert or update of conversation_id, message_id, source_message_id, user_id
  on public.plan_proposals for each row execute function public.assert_plan_links_owner();
create trigger plan_items_links_owner before insert or update of proposal_id, user_id
  on public.plan_items for each row execute function public.assert_plan_links_owner();
create trigger plan_approvals_links_owner before insert
  on public.plan_approvals for each row execute function public.assert_plan_links_owner();
create trigger commitments_plan_links_owner before insert or update of task_id, plan_item_id, user_id
  on public.commitments for each row execute function public.assert_plan_links_owner();

revoke execute on function public.assert_plan_links_owner() from public, anon, authenticated;

-- ---------- Plan status from its items ----------
create or replace function public.plan_status_from_items(p_proposal uuid)
returns public.plan_status language sql stable security invoker set search_path = '' as $$
  select case
    when count(*) = 0 then 'pending'::public.plan_status
    when count(*) filter (where status in ('pending', 'conflict', 'failed')) = 0
         and count(*) filter (where status = 'applied') > 0 then 'applied'::public.plan_status
    when count(*) filter (where status = 'applied') > 0 then 'partially_applied'::public.plan_status
    when count(*) filter (where status in ('pending', 'conflict', 'failed')) = 0 then 'rejected'::public.plan_status
    else 'pending'::public.plan_status
  end
  from public.plan_items where proposal_id = p_proposal;
$$;

-- True when a one-off timed commitment already covers part of [p_start, p_end).
-- Recurring events are checked by the scheduling engine in the app just before this runs.
create or replace function public.plan_one_off_overlap(p_user uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid)
returns text language sql stable security invoker set search_path = '' as $$
  select title from public.commitments
   where user_id = p_user
     and recurrence_rule is null
     and not all_day
     and starts_at is not null and ends_at is not null
     and starts_at < p_end and ends_at > p_start
     and (p_exclude is null or id <> p_exclude)
   order by starts_at
   limit 1;
$$;

-- ---------- Apply approved items in one transaction ----------
-- p_ops: [{ item_id, op, ...op fields }] computed and validated by the app
-- from the stored items. Supported ops:
--   insert_commitment  { row, guard }       guard = refuse when a one-off event overlaps
--   update_block_time  { id, starts_at, ends_at }   assistant-scheduled flexible sessions only
--   delete_block       { id }                       assistant-scheduled flexible sessions only
--   skip_occurrence    { id, date }
--   insert_task        { row }     update_task  { id, patch }
--   insert_habit       { row }     update_habit { id, patch }
--   insert_goal        { row }     update_goal  { id, patch }
--   insert_context_item { row }
--   set_life_area      { table, id, life_area_id }
--   mark_applied       { result_id, undo }   for writes the app already made (preferences)
-- Returns [{ item_id, outcome, message }]. Items that are no longer pending
-- are skipped, so running the same approval twice changes nothing.
create or replace function public.apply_plan_items(p_proposal_id uuid, p_request_id uuid, p_ops jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid        uuid := auth.uid();
  prior      jsonb;
  op         jsonb;
  item       public.plan_items%rowtype;
  results    jsonb := '[]'::jsonb;
  new_id     uuid;
  undo_data  jsonb;
  clash      text;
  r          jsonb;
  p          jsonb;
  before_row jsonb;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_request_id is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'Invalid approval' using errcode = '22023';
  end if;

  -- One approval at a time per user: concurrent tabs or double clicks queue here.
  perform pg_advisory_xact_lock(hashtextextended('whitespace-plan:' || uid::text, 0));

  select result into prior from public.plan_approvals where user_id = uid and request_id = p_request_id;
  if found then
    return prior;
  end if;

  perform 1 from public.plan_proposals where id = p_proposal_id and user_id = uid for update;
  if not found then
    raise exception 'Plan not found' using errcode = 'P0002';
  end if;

  for op in select * from jsonb_array_elements(p_ops)
  loop
    select * into item from public.plan_items
     where id = (op ->> 'item_id')::uuid and proposal_id = p_proposal_id and user_id = uid
     for update;
    if not found then
      results := results || jsonb_build_array(jsonb_build_object('item_id', op ->> 'item_id', 'outcome', 'failed', 'message', 'Item not found'));
      continue;
    end if;
    if item.status = 'applied' then
      results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'already_applied'));
      continue;
    end if;
    if item.status not in ('pending', 'conflict', 'failed') then
      results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'stale', 'message', 'This change was already ' || item.status::text || '.'));
      continue;
    end if;

    new_id := null;
    undo_data := null;
    r := op -> 'row';
    p := op -> 'patch';

    begin
      case op ->> 'op'
      when 'insert_commitment' then
        if coalesce((op ->> 'guard')::boolean, false) then
          clash := public.plan_one_off_overlap(uid, (r ->> 'starts_at')::timestamptz, (r ->> 'ends_at')::timestamptz, null);
          if clash is not null then
            update public.plan_items set status = 'conflict', error = left('Now overlaps ' || clash || '.', 500) where id = item.id;
            results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'conflict', 'message', 'Now overlaps ' || clash || '.'));
            continue;
          end if;
        end if;
        insert into public.commitments (
          user_id, title, life_area_id, area, kind, starts_at, ends_at, timezone, all_day,
          recurrence_rule, location, notes, source, source_message_id, task_id, plan_item_id)
        values (
          uid,
          r ->> 'title',
          nullif(r ->> 'life_area_id', '')::uuid,
          case when nullif(r ->> 'life_area_id', '') is null then nullif(r ->> 'area', '')::public.life_area end,
          (r ->> 'kind')::public.commitment_kind,
          (r ->> 'starts_at')::timestamptz,
          (r ->> 'ends_at')::timestamptz,
          nullif(r ->> 'timezone', ''),
          coalesce((r ->> 'all_day')::boolean, false),
          nullif(r ->> 'recurrence_rule', ''),
          nullif(r ->> 'location', ''),
          nullif(r ->> 'notes', ''),
          'conversation',
          nullif(r ->> 'source_message_id', '')::uuid,
          nullif(r ->> 'task_id', '')::uuid,
          item.id)
        returning id into new_id;
        undo_data := jsonb_build_object('op', 'delete_commitment', 'id', new_id);

      when 'update_block_time' then
        select to_jsonb(c) into before_row from public.commitments c
         where c.id = (op ->> 'id')::uuid and c.user_id = uid and c.kind = 'flexible' and c.plan_item_id is not null;
        if before_row is null then
          raise exception 'Only sessions the assistant scheduled can be moved' using errcode = 'P0002';
        end if;
        clash := public.plan_one_off_overlap(uid, (op ->> 'starts_at')::timestamptz, (op ->> 'ends_at')::timestamptz, (op ->> 'id')::uuid);
        if clash is not null then
          update public.plan_items set status = 'conflict', error = left('Now overlaps ' || clash || '.', 500) where id = item.id;
          results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'conflict', 'message', 'Now overlaps ' || clash || '.'));
          continue;
        end if;
        update public.commitments
           set starts_at = (op ->> 'starts_at')::timestamptz, ends_at = (op ->> 'ends_at')::timestamptz
         where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'restore_block_time', 'id', new_id,
                                        'starts_at', before_row ->> 'starts_at', 'ends_at', before_row ->> 'ends_at');

      when 'delete_block' then
        select to_jsonb(c) into before_row from public.commitments c
         where c.id = (op ->> 'id')::uuid and c.user_id = uid and c.kind = 'flexible' and c.plan_item_id is not null;
        if before_row is null then
          raise exception 'Only sessions the assistant scheduled can be removed' using errcode = 'P0002';
        end if;
        delete from public.commitments where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'reinsert_block', 'row', before_row);

      when 'skip_occurrence' then
        update public.commitments
           set recurrence_exceptions = (
             select array_agg(distinct d order by d)
               from unnest(recurrence_exceptions || array[(op ->> 'date')::date]) as d)
         where id = (op ->> 'id')::uuid and user_id = uid and recurrence_rule is not null
        returning id into new_id;
        if new_id is null then
          raise exception 'Repeating event not found' using errcode = 'P0002';
        end if;
        undo_data := jsonb_build_object('op', 'unskip_occurrence', 'id', new_id, 'date', op ->> 'date');

      when 'insert_task' then
        insert into public.tasks (user_id, title, description, life_area_id, area, goal_id, priority, status, due_at, estimated_minutes)
        values (
          uid, r ->> 'title', nullif(r ->> 'description', ''),
          nullif(r ->> 'life_area_id', '')::uuid,
          case when nullif(r ->> 'life_area_id', '') is null then nullif(r ->> 'area', '')::public.life_area end,
          nullif(r ->> 'goal_id', '')::uuid,
          coalesce(nullif(r ->> 'priority', ''), 'medium')::public.task_priority,
          'todo',
          nullif(r ->> 'due_at', '')::timestamptz,
          nullif(r ->> 'estimated_minutes', '')::integer)
        returning id into new_id;
        undo_data := jsonb_build_object('op', 'delete_task', 'id', new_id);

      when 'update_task' then
        select to_jsonb(t) into before_row from public.tasks t where t.id = (op ->> 'id')::uuid and t.user_id = uid for update;
        if before_row is null then
          raise exception 'Task not found' using errcode = 'P0002';
        end if;
        update public.tasks set
          title             = case when p ? 'title' then p ->> 'title' else title end,
          description       = case when p ? 'description' then nullif(p ->> 'description', '') else description end,
          priority          = case when p ? 'priority' then (p ->> 'priority')::public.task_priority else priority end,
          due_at            = case when p ? 'due_at' then nullif(p ->> 'due_at', '')::timestamptz else due_at end,
          estimated_minutes = case when p ? 'estimated_minutes' then nullif(p ->> 'estimated_minutes', '')::integer else estimated_minutes end,
          status            = case when p ? 'status' then (p ->> 'status')::public.task_status else status end,
          completed_at      = case
                                when not (p ? 'status') then completed_at
                                when p ->> 'status' = 'done' then coalesce(completed_at, now())
                                else null end
         where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'restore_task', 'id', new_id, 'row', before_row);

      when 'insert_habit' then
        insert into public.habits (user_id, title, description, life_area_id, area, cadence, times_per_week, weekdays)
        values (
          uid, r ->> 'title', nullif(r ->> 'description', ''),
          nullif(r ->> 'life_area_id', '')::uuid,
          case when nullif(r ->> 'life_area_id', '') is null then nullif(r ->> 'area', '')::public.life_area end,
          (r ->> 'cadence')::public.habit_cadence,
          nullif(r ->> 'times_per_week', '')::smallint,
          case when jsonb_typeof(r -> 'weekdays') = 'array'
               then array(select jsonb_array_elements_text(r -> 'weekdays')::smallint) end)
        returning id into new_id;
        undo_data := jsonb_build_object('op', 'delete_habit', 'id', new_id);

      when 'update_habit' then
        select to_jsonb(h) into before_row from public.habits h where h.id = (op ->> 'id')::uuid and h.user_id = uid for update;
        if before_row is null then
          raise exception 'Habit not found' using errcode = 'P0002';
        end if;
        update public.habits set
          title          = case when p ? 'title' then p ->> 'title' else title end,
          cadence        = case when p ? 'cadence' then (p ->> 'cadence')::public.habit_cadence else cadence end,
          times_per_week = case when p ? 'cadence' then nullif(p ->> 'times_per_week', '')::smallint else times_per_week end,
          weekdays       = case when p ? 'cadence' then
                             case when jsonb_typeof(p -> 'weekdays') = 'array'
                                  then array(select jsonb_array_elements_text(p -> 'weekdays')::smallint) end
                           else weekdays end
         where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'restore_habit', 'id', new_id, 'row', before_row);

      when 'insert_goal' then
        insert into public.goals (user_id, title, description, life_area_id, area, target_date, horizon, source, source_message_id)
        values (
          uid, r ->> 'title', nullif(r ->> 'description', ''),
          nullif(r ->> 'life_area_id', '')::uuid,
          case when nullif(r ->> 'life_area_id', '') is null then nullif(r ->> 'area', '')::public.life_area end,
          nullif(r ->> 'target_date', '')::date,
          nullif(r ->> 'horizon', '')::public.goal_horizon,
          'conversation',
          nullif(r ->> 'source_message_id', '')::uuid)
        returning id into new_id;
        undo_data := jsonb_build_object('op', 'delete_goal', 'id', new_id);

      when 'update_goal' then
        select to_jsonb(g) into before_row from public.goals g where g.id = (op ->> 'id')::uuid and g.user_id = uid for update;
        if before_row is null then
          raise exception 'Goal not found' using errcode = 'P0002';
        end if;
        update public.goals set
          title       = case when p ? 'title' then p ->> 'title' else title end,
          progress    = case when p ? 'progress' then (p ->> 'progress')::smallint else progress end,
          status      = case when p ? 'status' then (p ->> 'status')::public.goal_status
                             when p ? 'progress' and (p ->> 'progress')::smallint = 100 then 'completed'
                             else status end,
          target_date = case when p ? 'target_date' then nullif(p ->> 'target_date', '')::date else target_date end
         where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'restore_goal', 'id', new_id, 'row', before_row);

      when 'insert_context_item' then
        insert into public.context_items (user_id, category, title, details, life_area_id, area, attributes, source, source_message_id)
        values (
          uid, (r ->> 'category')::public.context_category, r ->> 'title', nullif(r ->> 'details', ''),
          nullif(r ->> 'life_area_id', '')::uuid,
          case when nullif(r ->> 'life_area_id', '') is null then nullif(r ->> 'area', '')::public.life_area end,
          coalesce(r -> 'attributes', '{}'::jsonb),
          'conversation',
          nullif(r ->> 'source_message_id', '')::uuid)
        returning id into new_id;
        undo_data := jsonb_build_object('op', 'delete_context_item', 'id', new_id);

      when 'set_life_area' then
        if op ->> 'table' not in ('commitments', 'tasks', 'habits', 'goals', 'context_items') then
          raise exception 'Unknown record type' using errcode = '22023';
        end if;
        execute format('select life_area_id from public.%I where id = $1 and user_id = $2', op ->> 'table')
           into undo_data using (op ->> 'id')::uuid, uid;
        execute format('update public.%I set life_area_id = $1 where id = $2 and user_id = $3 returning id', op ->> 'table')
           into new_id using nullif(op ->> 'life_area_id', '')::uuid, (op ->> 'id')::uuid, uid;
        if new_id is null then
          raise exception 'Record not found' using errcode = 'P0002';
        end if;
        undo_data := jsonb_build_object('op', 'restore_life_area', 'table', op ->> 'table', 'id', new_id,
                                        'life_area_id', undo_data);

      when 'mark_applied' then
        new_id := nullif(op ->> 'result_id', '')::uuid;
        undo_data := op -> 'undo';

      else
        raise exception 'Unknown operation' using errcode = '22023';
      end case;

      update public.plan_items
         set status = 'applied', result_id = new_id, undo = undo_data, applied_at = now(), error = null
       where id = item.id;
      results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'applied', 'result_id', new_id));
    exception
      when others then
        -- Only this item's changes are rolled back (sub-transaction); the rest continue.
        update public.plan_items set status = 'failed', error = left(sqlerrm, 500) where id = item.id;
        results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'failed', 'message', left(sqlerrm, 300)));
    end;
  end loop;

  update public.plan_proposals
     set status = public.plan_status_from_items(p_proposal_id), version = version + 1
   where id = p_proposal_id and user_id = uid;

  insert into public.plan_approvals (user_id, request_id, proposal_id, result)
  values (uid, p_request_id, p_proposal_id, results);

  return results;
end;
$$;

-- ---------- Undo one applied item ----------
-- Reverts what apply_plan_items wrote for one item. Fixed events the user
-- had before are never touched: undo only removes or restores rows this
-- plan created or changed.
create or replace function public.undo_plan_item(p_item_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  uid  uuid := auth.uid();
  item public.plan_items%rowtype;
  u    jsonb;
  b    jsonb;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('whitespace-plan:' || uid::text, 0));

  select * into item from public.plan_items where id = p_item_id and user_id = uid for update;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  if item.status <> 'applied' or item.undo is null then
    raise exception 'Nothing to undo' using errcode = '22023';
  end if;
  u := item.undo;
  b := u -> 'row';

  case u ->> 'op'
  when 'delete_commitment' then
    delete from public.commitments where id = (u ->> 'id')::uuid and user_id = uid and plan_item_id = item.id;
  when 'restore_block_time' then
    update public.commitments set starts_at = (u ->> 'starts_at')::timestamptz, ends_at = (u ->> 'ends_at')::timestamptz
     where id = (u ->> 'id')::uuid and user_id = uid;
  when 'reinsert_block' then
    insert into public.commitments (id, user_id, title, life_area_id, kind, starts_at, ends_at, timezone, all_day,
                                    location, notes, source, source_message_id, task_id, plan_item_id)
    values ((b ->> 'id')::uuid, uid, b ->> 'title', nullif(b ->> 'life_area_id', '')::uuid, 'flexible',
            (b ->> 'starts_at')::timestamptz, (b ->> 'ends_at')::timestamptz, nullif(b ->> 'timezone', ''),
            coalesce((b ->> 'all_day')::boolean, false), nullif(b ->> 'location', ''), nullif(b ->> 'notes', ''),
            'conversation',
            (select id from public.messages where id = nullif(b ->> 'source_message_id', '')::uuid and user_id = uid),
            (select id from public.tasks where id = nullif(b ->> 'task_id', '')::uuid and user_id = uid),
            (select id from public.plan_items where id = nullif(b ->> 'plan_item_id', '')::uuid and user_id = uid))
    on conflict (id) do nothing;
  when 'unskip_occurrence' then
    update public.commitments set recurrence_exceptions = array_remove(recurrence_exceptions, (u ->> 'date')::date)
     where id = (u ->> 'id')::uuid and user_id = uid;
  when 'delete_task' then
    delete from public.tasks where id = (u ->> 'id')::uuid and user_id = uid;
  when 'restore_task' then
    update public.tasks set
      title = b ->> 'title', description = b ->> 'description',
      priority = (b ->> 'priority')::public.task_priority, status = (b ->> 'status')::public.task_status,
      due_at = (b ->> 'due_at')::timestamptz, estimated_minutes = (b ->> 'estimated_minutes')::integer,
      completed_at = (b ->> 'completed_at')::timestamptz
     where id = (u ->> 'id')::uuid and user_id = uid;
  when 'delete_habit' then
    delete from public.habits where id = (u ->> 'id')::uuid and user_id = uid;
  when 'restore_habit' then
    update public.habits set
      title = b ->> 'title', cadence = (b ->> 'cadence')::public.habit_cadence,
      times_per_week = (b ->> 'times_per_week')::smallint,
      weekdays = case when jsonb_typeof(b -> 'weekdays') = 'array'
                      then array(select jsonb_array_elements_text(b -> 'weekdays')::smallint) end
     where id = (u ->> 'id')::uuid and user_id = uid;
  when 'delete_goal' then
    delete from public.goals where id = (u ->> 'id')::uuid and user_id = uid;
  when 'restore_goal' then
    update public.goals set
      title = b ->> 'title', progress = (b ->> 'progress')::smallint,
      status = (b ->> 'status')::public.goal_status, target_date = (b ->> 'target_date')::date
     where id = (u ->> 'id')::uuid and user_id = uid;
  when 'delete_context_item' then
    delete from public.context_items where id = (u ->> 'id')::uuid and user_id = uid;
  when 'restore_life_area' then
    if u ->> 'table' not in ('commitments', 'tasks', 'habits', 'goals', 'context_items') then
      raise exception 'Unknown record type' using errcode = '22023';
    end if;
    execute format('update public.%I set life_area_id = $1 where id = $2 and user_id = $3', u ->> 'table')
      using nullif(u ->> 'life_area_id', '')::uuid, (u ->> 'id')::uuid, uid;
  when 'none' then
    null; -- e.g. preferences: the app restores them before calling this.
  else
    raise exception 'Unknown undo' using errcode = '22023';
  end case;

  update public.plan_items set status = 'undone' where id = item.id;
  update public.plan_proposals
     set status = public.plan_status_from_items(item.proposal_id), version = version + 1
   where id = item.proposal_id and user_id = uid;
end;
$$;

revoke execute on function public.apply_plan_items(uuid, uuid, jsonb) from public, anon;
grant  execute on function public.apply_plan_items(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.undo_plan_item(uuid) from public, anon;
grant  execute on function public.undo_plan_item(uuid) to authenticated;
revoke execute on function public.plan_status_from_items(uuid) from public, anon;
grant  execute on function public.plan_status_from_items(uuid) to authenticated;
revoke execute on function public.plan_one_off_overlap(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.plan_one_off_overlap(uuid, timestamptz, timestamptz, uuid) to authenticated;
