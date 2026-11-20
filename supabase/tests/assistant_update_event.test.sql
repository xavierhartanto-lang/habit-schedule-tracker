-- =============================================================
-- Checks for 20261127000000_assistant_update_event.sql: the assistant
-- changes a saved event only after approval, only the fields asked,
-- never over a newer edit, and Undo restores it.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/assistant_update_event.test.sql
--
-- Runs in one transaction and is rolled back.
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

create function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then
    raise exception 'FAILED: %', label;
  end if;
  raise notice 'ok: %', label;
end;
$$;
grant execute on function pg_temp.expect(boolean, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

insert into public.commitments (id, title, kind, starts_at, ends_at, timezone, location, recurrence_rule) values
  ('c0000000-0000-0000-0000-000000000001', 'Tutor a kid', 'fixed', '2026-11-20 01:00+00', '2026-11-20 02:00+00', 'UTC', 'Library', null),
  ('c0000000-0000-0000-0000-000000000002', 'Basketball Practice', 'fixed', '2026-09-01 17:00+00', '2026-09-01 19:00+00', 'UTC', null, 'FREQ=WEEKLY;BYDAY=TU,TH');

insert into public.plan_proposals (id, kind) values ('a0000000-0000-0000-0000-000000000001', 'actions');
insert into public.plan_items (id, proposal_id, position, action, title, payload) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 0, 'update_event', 'Tutor a kid', '{}'),
  ('a1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 1, 'update_event', 'Basketball Practice', '{}'),
  ('a1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 2, 'update_event', 'Basketball Practice', '{}');

-- Rename only: time, place and everything else stay.
select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001',
    '[{"item_id":"a1000000-0000-0000-0000-000000000001","op":"update_event","id":"c0000000-0000-0000-0000-000000000001",
       "patch":{"title":"Math Tutoring"},
       "expect":{"title":"Tutor a kid","starts_at":"2026-11-20T01:00:00Z","ends_at":"2026-11-20T02:00:00Z","recurrence_rule":null}}]'::jsonb)) r)
  = 'applied', 'rename is applied');
select pg_temp.expect(
  (select title = 'Math Tutoring' and starts_at = '2026-11-20 01:00+00' and ends_at = '2026-11-20 02:00+00' and location = 'Library'
     from public.commitments where id = 'c0000000-0000-0000-0000-000000000001'),
  'only the title changed');

-- Move + new repeat days on a series.
select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002',
    '[{"item_id":"a1000000-0000-0000-0000-000000000002","op":"update_event","id":"c0000000-0000-0000-0000-000000000002",
       "patch":{"starts_at":"2026-09-04T18:00:00Z","ends_at":"2026-09-04T20:00:00Z","recurrence_rule":"FREQ=WEEKLY;BYDAY=FR"},
       "expect":{"title":"Basketball Practice","starts_at":"2026-09-01T17:00:00Z","ends_at":"2026-09-01T19:00:00Z","recurrence_rule":"FREQ=WEEKLY;BYDAY=TU,TH"}}]'::jsonb)) r)
  = 'applied', 'move and repeat change are applied');
select pg_temp.expect(
  (select recurrence_rule = 'FREQ=WEEKLY;BYDAY=FR' and starts_at = '2026-09-04 18:00+00' from public.commitments where id = 'c0000000-0000-0000-0000-000000000002'),
  'series now repeats on Fridays at the new time');

-- A suggestion made before that change must not overwrite it.
select pg_temp.expect(
  (select r ->> 'outcome' from jsonb_array_elements(public.apply_plan_items(
    'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000003',
    '[{"item_id":"a1000000-0000-0000-0000-000000000003","op":"update_event","id":"c0000000-0000-0000-0000-000000000002",
       "patch":{"title":"Basketball Game"},
       "expect":{"title":"Basketball Practice","starts_at":"2026-09-01T17:00:00Z","ends_at":"2026-09-01T19:00:00Z","recurrence_rule":"FREQ=WEEKLY;BYDAY=TU,TH"}}]'::jsonb)) r)
  = 'stale', 'an outdated suggestion is refused as stale');
select pg_temp.expect((select title from public.commitments where id = 'c0000000-0000-0000-0000-000000000002') = 'Basketball Practice',
  'nothing was overwritten');
select pg_temp.expect((select status from public.plan_items where id = 'a1000000-0000-0000-0000-000000000003') = 'failed',
  'the stale item is marked failed with a reason');

-- Undo restores the exact previous version.
select public.undo_plan_item('a1000000-0000-0000-0000-000000000002');
select pg_temp.expect(
  (select recurrence_rule = 'FREQ=WEEKLY;BYDAY=TU,TH' and starts_at = '2026-09-01 17:00+00' and ends_at = '2026-09-01 19:00+00'
     from public.commitments where id = 'c0000000-0000-0000-0000-000000000002'),
  'undo restores time and repeat rule');

-- Another user can't change it.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect(
  (select count(*) from public.commitments where id = 'c0000000-0000-0000-0000-000000000001') = 0,
  'RLS: the other user cannot see the event');

rollback;
