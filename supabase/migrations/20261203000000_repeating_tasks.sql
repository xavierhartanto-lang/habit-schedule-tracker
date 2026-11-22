-- Repeating tasks. A task can come back after you check it off:
-- daily, weekdays, weekly, or monthly. Checking it off (occurrence_done)
-- moves the due date forward and keeps the task open. Marking it done
-- for good clears the repeat in the app.
--
-- Also teaches apply_plan_items to store `repeat` and to roll a task
-- forward, and stops that roll from counting as a postponement.
-- Additive: existing tasks stay one-time (repeat is null). A step of a
-- bigger task cannot repeat.
-- Depends on 20261127000000_assistant_update_event.sql and
-- 20261129000000_phase7_steps.sql.

alter table public.tasks
  add column if not exists repeat text;

alter table public.tasks drop constraint if exists tasks_repeat_check;
alter table public.tasks add constraint tasks_repeat_check
  check (repeat is null or repeat in ('daily', 'weekdays', 'weekly', 'monthly'));

-- A step is one piece of a bigger task, so it does not come back on its own.
alter table public.tasks drop constraint if exists tasks_steps_do_not_repeat;
alter table public.tasks add constraint tasks_steps_do_not_repeat
  check (parent_task_id is null or repeat is null);

comment on column public.tasks.repeat is
  'When set, checking the task off schedules the next occurrence instead of finishing it.';

-- Moving the due date because this occurrence is done (completed_at changes
-- in the same update) is not a postponement.
create or replace function public.track_task_postpone()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.status <> 'done' and new.status <> 'done'
     and old.due_at is not null and new.due_at is not null
     and new.due_at > old.due_at + interval '1 hour'
     and (new.completed_at is null or new.completed_at is not distinct from old.completed_at) then
    new.postpone_count := least(old.postpone_count + 1, 1000);
    new.last_postponed_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.track_task_postpone() from public, anon, authenticated;

-- apply_plan_items and undo_plan_item, unchanged except task repeat
-- and occurrence_done. Copied forward from 20261127000000.

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

      when 'delete_event' then
        -- Removes a whole event (a repeating one goes as a series). Only
        -- proposed when the user asked, and only applied after approval.
        select to_jsonb(c) into before_row from public.commitments c
         where c.id = (op ->> 'id')::uuid and c.user_id = uid;
        if before_row is null then
          raise exception 'Event not found' using errcode = 'P0002';
        end if;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object(
          'op', 'reinsert_event',
          'row', before_row,
          'task_ids', coalesce((select jsonb_agg(t.id) from public.tasks t where t.commitment_id = new_id and t.user_id = uid), '[]'::jsonb));
        delete from public.commitments where id = new_id and user_id = uid;

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

      when 'update_event' then
        -- Changes only the fields in the patch. If the event changed since the
        -- suggestion was made, nothing is overwritten.
        select to_jsonb(c) into before_row from public.commitments c
         where c.id = (op ->> 'id')::uuid and c.user_id = uid for update;
        if before_row is null then
          raise exception 'Event not found' using errcode = 'P0002';
        end if;
        if op ? 'expect' and (
             (before_row ->> 'title') is distinct from (op -> 'expect' ->> 'title')
          or (before_row ->> 'starts_at')::timestamptz is distinct from (op -> 'expect' ->> 'starts_at')::timestamptz
          or (before_row ->> 'ends_at')::timestamptz is distinct from (op -> 'expect' ->> 'ends_at')::timestamptz
          or (before_row ->> 'recurrence_rule') is distinct from (op -> 'expect' ->> 'recurrence_rule')) then
          update public.plan_items set status = 'failed', error = 'This event changed since the suggestion. Nothing was overwritten.' where id = item.id;
          results := results || jsonb_build_array(jsonb_build_object('item_id', item.id, 'outcome', 'stale',
                                                  'message', 'This event changed since the suggestion. Nothing was overwritten.'));
          continue;
        end if;
        update public.commitments set
          title           = case when p ? 'title' then p ->> 'title' else title end,
          starts_at       = case when p ? 'starts_at' then (p ->> 'starts_at')::timestamptz else starts_at end,
          ends_at         = case when p ? 'ends_at' then (p ->> 'ends_at')::timestamptz else ends_at end,
          recurrence_rule = case when p ? 'recurrence_rule' then nullif(p ->> 'recurrence_rule', '') else recurrence_rule end,
          location        = case when p ? 'location' then nullif(p ->> 'location', '') else location end
         where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'restore_event', 'id', new_id, 'row', before_row);

      when 'insert_task' then
        insert into public.tasks (user_id, title, description, life_area_id, area, goal_id, priority, status, due_at, estimated_minutes, repeat)
        values (
          uid, r ->> 'title', nullif(r ->> 'description', ''),
          nullif(r ->> 'life_area_id', '')::uuid,
          case when nullif(r ->> 'life_area_id', '') is null then nullif(r ->> 'area', '')::public.life_area end,
          nullif(r ->> 'goal_id', '')::uuid,
          coalesce(nullif(r ->> 'priority', ''), 'medium')::public.task_priority,
          'todo',
          nullif(r ->> 'due_at', '')::timestamptz,
          nullif(r ->> 'estimated_minutes', '')::integer,
          nullif(r ->> 'repeat', ''))
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
          status            = case
                                when coalesce(p ->> 'occurrence_done', '') = 'true' then 'todo'::public.task_status
                                when p ? 'status' then (p ->> 'status')::public.task_status
                                else status end,
          completed_at      = case
                                when coalesce(p ->> 'occurrence_done', '') = 'true' then now()
                                when not (p ? 'status') then completed_at
                                when p ->> 'status' = 'done' then coalesce(completed_at, now())
                                else null end,
          repeat            = case when p ? 'repeat' then nullif(p ->> 'repeat', '') else repeat end
         where id = (op ->> 'id')::uuid and user_id = uid;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object('op', 'restore_task', 'id', new_id, 'row', before_row);

      when 'remove_task' then
        -- Deletes a task for good. Only proposed when the user asked, and only
        -- applied after approval. Sessions linked to it stay on the calendar.
        select to_jsonb(t) into before_row from public.tasks t
         where t.id = (op ->> 'id')::uuid and t.user_id = uid for update;
        if before_row is null then
          raise exception 'Task not found' using errcode = 'P0002';
        end if;
        new_id := (op ->> 'id')::uuid;
        undo_data := jsonb_build_object(
          'op', 'reinsert_task',
          'row', before_row,
          'commitment_ids', coalesce((select jsonb_agg(c.id) from public.commitments c where c.task_id = new_id and c.user_id = uid), '[]'::jsonb));
        delete from public.tasks where id = new_id and user_id = uid;

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
  when 'reinsert_event' then
    -- Links to rows that no longer exist are dropped instead of failing.
    b := b || jsonb_build_object(
      'user_id', uid,
      'life_area_id', (select id from public.life_areas where id = nullif(b ->> 'life_area_id', '')::uuid and user_id = uid),
      'source_message_id', (select id from public.messages where id = nullif(b ->> 'source_message_id', '')::uuid and user_id = uid),
      'task_id', (select id from public.tasks where id = nullif(b ->> 'task_id', '')::uuid and user_id = uid),
      'plan_item_id', (select id from public.plan_items where id = nullif(b ->> 'plan_item_id', '')::uuid and user_id = uid));
    insert into public.commitments
    select (jsonb_populate_record(null::public.commitments, b)).*
    on conflict (id) do nothing;
    update public.tasks set commitment_id = (b ->> 'id')::uuid
     where user_id = uid and commitment_id is null
       and id in (select jsonb_array_elements_text(coalesce(u -> 'task_ids', '[]'::jsonb))::uuid);
  when 'restore_event' then
    update public.commitments set
      title = b ->> 'title',
      starts_at = (b ->> 'starts_at')::timestamptz,
      ends_at = (b ->> 'ends_at')::timestamptz,
      recurrence_rule = b ->> 'recurrence_rule',
      location = b ->> 'location'
     where id = (u ->> 'id')::uuid and user_id = uid;
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
      completed_at = (b ->> 'completed_at')::timestamptz,
      repeat = nullif(b ->> 'repeat', '')
     where id = (u ->> 'id')::uuid and user_id = uid;
  when 'reinsert_task' then
    -- Links to rows that no longer exist are dropped instead of failing.
    b := b || jsonb_build_object(
      'user_id', uid,
      'life_area_id', (select id from public.life_areas where id = nullif(b ->> 'life_area_id', '')::uuid and user_id = uid),
      'goal_id', (select id from public.goals where id = nullif(b ->> 'goal_id', '')::uuid and user_id = uid),
      'commitment_id', (select id from public.commitments where id = nullif(b ->> 'commitment_id', '')::uuid and user_id = uid));
    insert into public.tasks
    select (jsonb_populate_record(null::public.tasks, b)).*
    on conflict (id) do nothing;
    update public.commitments set task_id = (b ->> 'id')::uuid
     where user_id = uid and task_id is null
       and id in (select jsonb_array_elements_text(coalesce(u -> 'commitment_ids', '[]'::jsonb))::uuid);
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
