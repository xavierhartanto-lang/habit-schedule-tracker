-- =============================================================
-- Checks for 20261124000000_proactive_recommendations.sql.
--
-- Run against a database with all migrations applied (local Supabase or
-- a scratch project), as a role that can insert into auth.users:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/proactive_recommendations.test.sql
--
-- Everything runs in one transaction and is rolled back. A failed
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

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

-- ---------- Settings ----------
insert into public.scheduling_preferences (user_id) values ('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select proactivity = 'balanced' and quiet_hours_start is null from public.scheduling_preferences), 'proactivity defaults to balanced, no quiet hours');
update public.scheduling_preferences set proactivity = 'minimal', quiet_hours_start = '22:00', quiet_hours_end = '07:00';
select pg_temp.expect((select proactivity = 'minimal' from public.scheduling_preferences), 'quiet hours across midnight are allowed');
select pg_temp.expect_error($$update public.scheduling_preferences set proactivity = 'loud'$$, 'unknown proactivity level');
select pg_temp.expect_error($$update public.scheduling_preferences set quiet_hours_end = null$$, 'quiet hours need both ends');
select pg_temp.expect_error($$update public.scheduling_preferences set quiet_hours_end = '22:00'$$, 'quiet hours need a length');

-- ---------- Postpone tracking ----------
insert into public.tasks (id, title, due_at) values ('b0000000-0000-0000-0000-000000000001', 'Essay', '2026-11-20 23:59+00');
update public.tasks set due_at = '2026-11-20 23:30+00' where id = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select postpone_count = 0 from public.tasks where id = 'b0000000-0000-0000-0000-000000000001'), 'moving a due date earlier is not a postponement');
update public.tasks set due_at = '2026-11-21 00:10+00' where id = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select postpone_count = 0 from public.tasks where id = 'b0000000-0000-0000-0000-000000000001'), 'a change under an hour is not a postponement');
update public.tasks set due_at = '2026-11-22 23:59+00' where id = 'b0000000-0000-0000-0000-000000000001';
update public.tasks set due_at = '2026-11-24 23:59+00' where id = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select postpone_count = 2 and last_postponed_at is not null from public.tasks where id = 'b0000000-0000-0000-0000-000000000001'), 'pushing the due date later counts');
update public.tasks set title = 'Essay draft' where id = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select postpone_count = 2 from public.tasks where id = 'b0000000-0000-0000-0000-000000000001'), 'other edits do not count');

-- A Whitespace session for the task moved later counts too; a manual event doesn't.
insert into public.plan_proposals (id, kind) values ('a0000000-0000-0000-0000-000000000001', 'schedule');
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 0, 'schedule_block', 'Essay');
insert into public.commitments (id, title, kind, starts_at, ends_at, task_id, plan_item_id) values
  ('c0000000-0000-0000-0000-000000000001', 'Essay', 'flexible', '2026-11-19 16:00+00', '2026-11-19 17:00+00',
   'b0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000002', 'Piano', 'fixed', '2026-11-19 18:00+00', '2026-11-19 19:00+00',
   'b0000000-0000-0000-0000-000000000001', null);
update public.commitments set starts_at = '2026-11-20 16:00+00', ends_at = '2026-11-20 17:00+00' where id = 'c0000000-0000-0000-0000-000000000001';
update public.commitments set starts_at = '2026-11-21 18:00+00', ends_at = '2026-11-21 19:00+00' where id = 'c0000000-0000-0000-0000-000000000002';
select pg_temp.expect((select postpone_count = 3 from public.tasks where id = 'b0000000-0000-0000-0000-000000000001'), 'a moved Whitespace session counts once');
update public.tasks set status = 'done', completed_at = now(), due_at = '2026-12-01 23:59+00' where id = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select postpone_count = 3 from public.tasks where id = 'b0000000-0000-0000-0000-000000000001'), 'completing a task never counts');

-- ---------- Recommendations ----------
insert into public.recommendations (dedupe_key, kind, priority, title, reason, message, task_id, facts, actions) values
  ('deadline_soon:b0000000-0000-0000-0000-000000000001:2026-11-20', 'deadline_soon', 'high', 'Essay is due tomorrow', 'r', 'm',
   'b0000000-0000-0000-0000-000000000001', '["Due Fri, Nov 20"]', '[{"id":"schedule_work","kind":"schedule_work","label":"Block out 2 h","params":{}}]');
select pg_temp.expect((select status = 'open' and user_id = '00000000-0000-0000-0000-0000000000a1' from public.recommendations), 'insert defaults: open, owned by the caller');
select pg_temp.expect_error($$insert into public.recommendations (dedupe_key, kind, priority, title, reason, message)
  values ('deadline_soon:b0000000-0000-0000-0000-000000000001:2026-11-20', 'deadline_soon', 'high', 't', 'r', 'm')$$, 'the same situation is never stored twice');
insert into public.recommendations (dedupe_key, kind, priority, title, reason, message)
  values ('deadline_soon:b0000000-0000-0000-0000-000000000001:2026-11-20', 'deadline_soon', 'high', 't', 'r', 'm')
  on conflict (user_id, dedupe_key) do nothing;
select pg_temp.expect((select count(*) = 1 from public.recommendations), 'concurrent upserts with ignore keep one row');
select pg_temp.expect_error($$insert into public.recommendations (dedupe_key, kind, priority, title, reason, message) values ('x', 'nag', 'high', 't', 'r', 'm')$$, 'unknown kind');
select pg_temp.expect_error($$update public.recommendations set status = 'gone'$$, 'unknown status');
select pg_temp.expect_error($$update public.recommendations set facts = '{}'$$, 'facts must be a list');
update public.recommendations set status = 'proposed', plan_id = 'a0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select plan_id is not null from public.recommendations), 'linking own plan works');

-- ---------- User B can't see or touch A's rows, or link to them ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect((select count(*) = 0 from public.recommendations), 'B sees none of A''s recommendations');
update public.recommendations set status = 'dismissed';
delete from public.recommendations;
select pg_temp.expect_error($$insert into public.recommendations (user_id, dedupe_key, kind, priority, title, reason, message)
  values ('00000000-0000-0000-0000-0000000000a1', 'k', 'overdue', 'high', 't', 'r', 'm')$$, 'B cannot insert rows for A');
select pg_temp.expect_error($$insert into public.recommendations (dedupe_key, kind, priority, title, reason, message, task_id)
  values ('k', 'overdue', 'high', 't', 'r', 'm', 'b0000000-0000-0000-0000-000000000001')$$, 'B cannot link A''s task');
select pg_temp.expect_error($$insert into public.recommendations (dedupe_key, kind, priority, title, reason, message, plan_id)
  values ('k2', 'overdue', 'high', 't', 'r', 'm', 'a0000000-0000-0000-0000-000000000001')$$, 'B cannot link A''s plan');
select pg_temp.expect((select count(*) = 0 from public.scheduling_preferences), 'B sees none of A''s settings');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select status = 'proposed' from public.recommendations), 'A''s row untouched by B');

-- Deleting the plan unlinks, deleting the task removes its recommendations.
delete from public.plan_proposals where id = 'a0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select plan_id is null from public.recommendations), 'deleted plan unlinks');
delete from public.tasks where id = 'b0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select count(*) = 0 from public.recommendations), 'deleted task removes its recommendations');

rollback;
