-- =============================================================
-- Checks for 20261122000000_assistant_plans.sql.
--
-- Run against a database with all migrations applied (local Supabase or
-- a scratch project), as a role that can insert into auth.users:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/assistant_plans.test.sql
--
-- Everything runs in one transaction and is rolled back. Any failed
-- check raises an exception and stops the script.
-- =============================================================

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1');

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

-- ---------- Setup as user A ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

-- A fixed one-off event and a recurring one.
insert into public.commitments (id, title, kind, starts_at, ends_at, timezone) values
  ('c0000000-0000-0000-0000-000000000001', 'Dentist', 'fixed', '2026-11-20 17:00+00', '2026-11-20 18:00+00', 'UTC');
insert into public.commitments (id, title, kind, starts_at, ends_at, timezone, recurrence_rule) values
  ('c0000000-0000-0000-0000-000000000002', 'Volleyball', 'fixed', '2026-11-19 18:00+00', '2026-11-19 20:00+00', 'UTC', 'FREQ=WEEKLY;BYDAY=TH');

insert into public.plan_proposals (id, kind) values ('a0000000-0000-0000-0000-000000000001', 'schedule');
insert into public.plan_items (id, proposal_id, position, action, title, payload) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 0, 'schedule_block', 'Study (1 of 2)', '{}'),
  ('a1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 1, 'schedule_block', 'Study (2 of 2)', '{}'),
  ('a1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 2, 'create_task', 'Buy notebook', '{}'),
  ('a1000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 3, 'skip_occurrence', 'Volleyball', '{}');

-- ---------- Approve selected items ----------
select pg_temp.expect(
  (select jsonb_agg(r ->> 'outcome') from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001',
    '[{"item_id":"a1000000-0000-0000-0000-000000000001","op":"insert_commitment","guard":true,
       "row":{"title":"Study","kind":"flexible","starts_at":"2026-11-20T15:00:00Z","ends_at":"2026-11-20T16:00:00Z","timezone":"UTC"}},
      {"item_id":"a1000000-0000-0000-0000-000000000003","op":"insert_task","row":{"title":"Buy notebook","priority":"low"}}]'::jsonb)) r)
  = '["applied","applied"]'::jsonb,
  'approving selected items applies only those');

select pg_temp.expect((select count(*) from public.commitments where plan_item_id = 'a1000000-0000-0000-0000-000000000001') = 1,
  'the session is on the calendar, linked to its plan item');
select pg_temp.expect((select status from public.plan_proposals where id = 'a0000000-0000-0000-0000-000000000001') = 'partially_applied',
  'plan is partially applied while items are open');
select pg_temp.expect((select status from public.plan_items where id = 'a1000000-0000-0000-0000-000000000002') = 'pending',
  'unselected item stays pending');

-- ---------- Duplicate submissions ----------
select public.apply_plan_items(
  'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001',
  '[{"item_id":"a1000000-0000-0000-0000-000000000001","op":"insert_commitment","guard":true,
     "row":{"title":"Study","kind":"flexible","starts_at":"2026-11-20T15:00:00Z","ends_at":"2026-11-20T16:00:00Z","timezone":"UTC"}}]'::jsonb);
select pg_temp.expect((select count(*) from public.commitments where title = 'Study') = 1,
  'same request id twice does not create a duplicate');
select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002',
    '[{"item_id":"a1000000-0000-0000-0000-000000000001","op":"insert_commitment","guard":true,
       "row":{"title":"Study","kind":"flexible","starts_at":"2026-11-20T15:00:00Z","ends_at":"2026-11-20T16:00:00Z","timezone":"UTC"}}]'::jsonb)) r)
  = 'already_applied',
  'a new request for an applied item reports already_applied');
select pg_temp.expect((select count(*) from public.commitments where title = 'Study') = 1, 'still exactly one session');

-- ---------- Stale suggestion: the time is no longer free ----------
select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000003',
    '[{"item_id":"a1000000-0000-0000-0000-000000000002","op":"insert_commitment","guard":true,
       "row":{"title":"Study","kind":"flexible","starts_at":"2026-11-20T17:30:00Z","ends_at":"2026-11-20T18:30:00Z","timezone":"UTC"}}]'::jsonb)) r)
  = 'conflict',
  'a session that now overlaps the dentist is refused');
select pg_temp.expect((select status from public.plan_items where id = 'a1000000-0000-0000-0000-000000000002') = 'conflict',
  'the item is marked conflict');
select pg_temp.expect((select count(*) from public.commitments where title = 'Study') = 1, 'nothing was written for it');

-- ---------- Fixed commitments are protected ----------
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 4, 'remove_block', 'Dentist'),
  ('a1000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 5, 'move_block', 'Dentist');
select pg_temp.expect(
  (select jsonb_agg(r ->> 'outcome') from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000004',
    '[{"item_id":"a1000000-0000-0000-0000-000000000005","op":"delete_block","id":"c0000000-0000-0000-0000-000000000001"},
      {"item_id":"a1000000-0000-0000-0000-000000000006","op":"update_block_time","id":"c0000000-0000-0000-0000-000000000001",
       "starts_at":"2026-11-21T17:00:00Z","ends_at":"2026-11-21T18:00:00Z"}]'::jsonb)) r)
  = '["failed","failed"]'::jsonb,
  'a fixed event can never be deleted or moved through a plan');
select pg_temp.expect((select starts_at from public.commitments where id = 'c0000000-0000-0000-0000-000000000001') = '2026-11-20 17:00+00',
  'the dentist appointment is unchanged');

-- ---------- Recurring: skip one date, then undo ----------
select public.apply_plan_items(
  'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000005',
  '[{"item_id":"a1000000-0000-0000-0000-000000000004","op":"skip_occurrence","id":"c0000000-0000-0000-0000-000000000002","date":"2026-11-26"}]'::jsonb);
select pg_temp.expect((select recurrence_exceptions from public.commitments where id = 'c0000000-0000-0000-0000-000000000002') = '{2026-11-26}',
  'skipping adds one exception and keeps the series');
select public.undo_plan_item('a1000000-0000-0000-0000-000000000004');
select pg_temp.expect((select recurrence_exceptions from public.commitments where id = 'c0000000-0000-0000-0000-000000000002') = '{}',
  'undo restores the occurrence');

-- ---------- Undo an auto-applied task ----------
select public.undo_plan_item('a1000000-0000-0000-0000-000000000003');
select pg_temp.expect(not exists (select 1 from public.tasks where title = 'Buy notebook'), 'undo removes the created task');
select pg_temp.expect((select status from public.plan_items where id = 'a1000000-0000-0000-0000-000000000003') = 'undone', 'item marked undone');
select pg_temp.expect_error($$select public.undo_plan_item('a1000000-0000-0000-0000-000000000003')$$, 'cannot undo twice');

-- ---------- Assistant blocks can be moved and removed ----------
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 6, 'move_block', 'Study');
select public.apply_plan_items(
  'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000006',
  jsonb_build_array(jsonb_build_object('item_id', 'a1000000-0000-0000-0000-000000000007', 'op', 'update_block_time',
    'id', (select id from public.commitments where title = 'Study'),
    'starts_at', '2026-11-21T15:00:00Z', 'ends_at', '2026-11-21T16:00:00Z')));
select pg_temp.expect((select starts_at from public.commitments where title = 'Study') = '2026-11-21 15:00+00', 'the session moved');
select public.undo_plan_item('a1000000-0000-0000-0000-000000000007');
select pg_temp.expect((select starts_at from public.commitments where title = 'Study') = '2026-11-20 15:00+00', 'undo moves it back');

select pg_temp.expect((select version from public.plan_proposals where id = 'a0000000-0000-0000-0000-000000000001') > 5,
  'every change bumps the plan version');

-- ---------- Completed work and history are kept ----------
insert into public.tasks (id, title, status, completed_at) values ('b0000000-0000-0000-0000-000000000001', 'Old essay', 'done', '2026-11-01');
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', 7, 'complete_task', 'Old essay');
select public.apply_plan_items(
  'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000007',
  '[{"item_id":"a1000000-0000-0000-0000-000000000008","op":"update_task","id":"b0000000-0000-0000-0000-000000000001","patch":{"status":"done"}}]'::jsonb);
select pg_temp.expect((select completed_at from public.tasks where id = 'b0000000-0000-0000-0000-000000000001') = '2026-11-01 00:00+00',
  'completing an already-done task keeps its original completion time');

-- ---------- User data isolation ----------
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');

select pg_temp.expect((select count(*) from public.plan_proposals) = 0, 'B sees none of A''s plans');
select pg_temp.expect((select count(*) from public.plan_items) = 0, 'B sees none of A''s plan items');
select pg_temp.expect((select count(*) from public.plan_approvals) = 0, 'B sees none of A''s approvals');
select pg_temp.expect_error(
  $$select public.apply_plan_items('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000b1', '[]'::jsonb)$$,
  'B cannot approve A''s plan');
select pg_temp.expect_error(
  $$select public.undo_plan_item('a1000000-0000-0000-0000-000000000001')$$,
  'B cannot undo A''s items');
select pg_temp.expect_error(
  $$insert into public.plan_items (proposal_id, position, action, title) values ('a0000000-0000-0000-0000-000000000001', 50, 'create_task', 'x')$$,
  'B cannot add items to A''s plan');
insert into public.plan_proposals (id, kind) values ('b0000000-0000-0000-0000-0000000000f1', 'actions');
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000f1', 0, 'update_task', 'Steal');
select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'b0000000-0000-0000-0000-0000000000f1', 'f0000000-0000-0000-0000-0000000000b2',
    '[{"item_id":"b1000000-0000-0000-0000-000000000001","op":"update_task","id":"b0000000-0000-0000-0000-000000000001","patch":{"title":"hacked"}}]'::jsonb)) r)
  = 'failed',
  'B cannot change A''s task through B''s own plan');
select pg_temp.expect_error(
  $$insert into public.commitments (title, kind, starts_at, ends_at, plan_item_id) values ('x', 'flexible', now(), now() + interval '1 hour', 'a1000000-0000-0000-0000-000000000001')$$,
  'B cannot link a commitment to A''s plan item');

reset role;
select pg_temp.expect((select title from public.tasks where id = 'b0000000-0000-0000-0000-000000000001') = 'Old essay', 'A''s task is untouched');

rollback;
