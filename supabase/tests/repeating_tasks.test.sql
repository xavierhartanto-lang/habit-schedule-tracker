-- =============================================================
-- Checks for 20261203000000_repeating_tasks.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/repeating_tasks.test.sql
-- One transaction, rolled back.
-- =============================================================

begin;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1');

create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.expect_error(stmt text, label text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok: % (%)', label, sqlerrm;
    return;
  end;
  raise exception 'FAILED: % should have been rejected', label;
end;
$$;

create function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then
    raise exception 'FAILED: %', label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

grant execute on function pg_temp.expect(boolean, text) to authenticated;
grant execute on function pg_temp.expect_error(text, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

insert into public.tasks (id, title, repeat, due_at) values
  ('00000000-0000-0000-0000-00000000e001', 'Check school assignments', 'daily', '2026-11-18 23:59+00');
select pg_temp.expect((select repeat from public.tasks where id = '00000000-0000-0000-0000-00000000e001') = 'daily', 'daily repeat is stored');

select pg_temp.expect_error(
  $$insert into public.tasks (title, repeat) values ('Nope', 'hourly')$$,
  'unknown repeat is rejected');

insert into public.tasks (id, title, parent_task_id) values
  ('00000000-0000-0000-0000-00000000e002', 'Open the portal', '00000000-0000-0000-0000-00000000e001');
select pg_temp.expect_error(
  $$update public.tasks set repeat = 'weekly' where id = '00000000-0000-0000-0000-00000000e002'$$,
  'a step cannot repeat');

-- Checking off this occurrence moves the due date and is not a postponement.
update public.tasks
   set due_at = '2026-11-19 23:59+00', completed_at = now(), status = 'todo'
 where id = '00000000-0000-0000-0000-00000000e001';
select pg_temp.expect((select postpone_count from public.tasks where id = '00000000-0000-0000-0000-00000000e001') = 0,
  'rolling a repeating task forward is not a postponement');

-- Pushing the due date without finishing the occurrence still counts.
update public.tasks set due_at = '2026-11-21 23:59+00' where id = '00000000-0000-0000-0000-00000000e001';
select pg_temp.expect((select postpone_count from public.tasks where id = '00000000-0000-0000-0000-00000000e001') = 1,
  'moving the due date later is still a postponement');

-- The assistant can turn a repeat on, roll the task forward, and undo both.
insert into public.plan_proposals (id, kind) values ('a0000000-0000-0000-0000-0000000000e1', 'actions');
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-0000000000e1', 'a0000000-0000-0000-0000-0000000000e1', 0, 'create_task', 'Check school assignments'),
  ('a1000000-0000-0000-0000-0000000000e2', 'a0000000-0000-0000-0000-0000000000e1', 1, 'update_task', 'Check school assignments'),
  ('a1000000-0000-0000-0000-0000000000e3', 'a0000000-0000-0000-0000-0000000000e1', 2, 'complete_task', 'Check school assignments');

select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-0000000000e1', 'f0000000-0000-0000-0000-0000000000e1',
    '[{"item_id":"a1000000-0000-0000-0000-0000000000e1","op":"insert_task","row":{"title":"Pack bag","priority":"medium","repeat":"weekdays","due_at":"2026-11-18T07:59:00Z"}}]'::jsonb)) r)
  = 'applied',
  'the assistant can create a repeating task');
select pg_temp.expect(
  (select repeat = 'weekdays' and status = 'todo' from public.tasks where title = 'Pack bag'),
  'the new task repeats on weekdays');

select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-0000000000e1', 'f0000000-0000-0000-0000-0000000000e2',
    jsonb_build_array(jsonb_build_object(
      'item_id', 'a1000000-0000-0000-0000-0000000000e2',
      'op', 'update_task',
      'id', '00000000-0000-0000-0000-00000000e001',
      'patch', jsonb_build_object('repeat', 'weekly'))))) r)
  = 'applied',
  'the assistant can turn a repeat on');
select pg_temp.expect((select repeat from public.tasks where id = '00000000-0000-0000-0000-00000000e001') = 'weekly', 'repeat is now weekly');

select public.undo_plan_item('a1000000-0000-0000-0000-0000000000e2');
select pg_temp.expect((select repeat from public.tasks where id = '00000000-0000-0000-0000-00000000e001') = 'daily', 'undo restores the previous repeat');

select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-0000000000e1', 'f0000000-0000-0000-0000-0000000000e3',
    '[{"item_id":"a1000000-0000-0000-0000-0000000000e3","op":"update_task","id":"00000000-0000-0000-0000-00000000e001","patch":{"due_at":"2026-11-19T07:59:00Z","occurrence_done":true}}]'::jsonb)) r)
  = 'applied',
  'checking off a repeating task applies');
select pg_temp.expect(
  (select status = 'todo' and due_at = '2026-11-19 07:59+00' and completed_at is not null and repeat = 'daily'
     from public.tasks where id = '00000000-0000-0000-0000-00000000e001'),
  'the task stays open, due next time, and still repeats');

rollback;
