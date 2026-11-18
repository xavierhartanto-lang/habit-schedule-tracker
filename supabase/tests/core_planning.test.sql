-- =============================================================
-- Checks for 20261120000000_core_planning.sql.
--
-- Run against a database with all migrations applied (local Supabase or
-- a scratch project), as a role that can insert into auth.users:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/core_planning.test.sql
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

-- ---------- Defaults ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

select pg_temp.expect((select count(*) from public.life_areas) = 7, 'signup creates 7 default life areas, visible only to the owner');
select pg_temp.expect(
  (select array_agg(name order by position) from public.life_areas)
    = array['Academics','Extracurriculars','Sports','Hobbies','Personal Projects','Social','Personal & Rest'],
  'defaults are in the expected order');

-- ---------- Sync between life_area_id and the legacy enum ----------
-- Phase 2 style write: only the enum.
insert into public.goals (id, title, area) values ('30000000-0000-0000-0000-0000000000a1', 'Make varsity', 'athletics');
select pg_temp.expect(
  (select la.name from public.goals g join public.life_areas la on la.id = g.life_area_id
    where g.id = '30000000-0000-0000-0000-0000000000a1') = 'Sports',
  'legacy enum write maps to the matching life area');

insert into public.context_items (title, category, area) values ('Nap', 'routine', 'rest');
select pg_temp.expect(
  (select la.name from public.context_items c join public.life_areas la on la.id = c.life_area_id where c.title = 'Nap') = 'Personal & Rest',
  '"rest" falls back to Personal & Rest');

-- Phase 3 style write: a custom area.
insert into public.life_areas (id, name, color) values ('40000000-0000-0000-0000-0000000000a1', 'Debate', 'teal');
insert into public.tasks (id, title, life_area_id, priority)
values ('50000000-0000-0000-0000-0000000000a1', 'Prep rebuttal', '40000000-0000-0000-0000-0000000000a1', 'high');
select pg_temp.expect(
  (select area is null from public.tasks where id = '50000000-0000-0000-0000-0000000000a1'),
  'custom areas have no legacy enum value');

insert into public.commitments (id, title, kind, starts_at, ends_at, life_area_id, all_day, timezone, recurrence_rule)
values ('60000000-0000-0000-0000-0000000000a1', 'Debate practice', 'fixed', '2026-11-18 23:00+00', '2026-11-19 01:00+00',
        '40000000-0000-0000-0000-0000000000a1', false, 'America/Los_Angeles', 'FREQ=WEEKLY;BYDAY=WE');

insert into public.habits (id, title, cadence, weekdays, life_area_id)
values ('70000000-0000-0000-0000-0000000000a1', 'Read', 'specific_days', '{1,3,5}', '40000000-0000-0000-0000-0000000000a1');

select pg_temp.expect_error(
  $$insert into public.habits (title, cadence) values ('Bad', 'specific_days')$$,
  'specific_days habits need weekdays');
select pg_temp.expect_error(
  $$insert into public.habits (title, cadence, weekdays) values ('Bad', 'specific_days', '{0,8}')$$,
  'weekdays must be 1-7');
select pg_temp.expect_error(
  $$update public.goals set progress = 120 where id = '30000000-0000-0000-0000-0000000000a1'$$,
  'goal progress is 0-100');
select pg_temp.expect_error(
  $$insert into public.life_areas (name, color) values ('debate ', 'blue')$$,
  'area names are unique per user, ignoring case and spaces');
select pg_temp.expect_error(
  $$insert into public.life_areas (name, color) values ('Neon', 'neon')$$,
  'area colors come from the palette');

update public.life_areas set legacy_key = 'academics' where id = '40000000-0000-0000-0000-0000000000a1';
select pg_temp.expect(
  (select legacy_key is null from public.life_areas where id = '40000000-0000-0000-0000-0000000000a1'),
  'legacy_key cannot be changed');

-- ---------- User B cannot see or touch A's data ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');

select pg_temp.expect((select count(*) from public.life_areas) = 7, 'B sees only their own areas');
select pg_temp.expect((select count(*) from public.tasks) = 0, 'B cannot read A''s tasks');
select pg_temp.expect((select count(*) from public.commitments) = 0, 'B cannot read A''s events');
select pg_temp.expect((select count(*) from public.habits) = 0, 'B cannot read A''s habits');
select pg_temp.expect((select count(*) from public.goals) = 0, 'B cannot read A''s goals');

update public.tasks set title = 'hacked' where id = '50000000-0000-0000-0000-0000000000a1';
delete from public.commitments where id = '60000000-0000-0000-0000-0000000000a1';
delete from public.life_areas where id = '40000000-0000-0000-0000-0000000000a1';

select pg_temp.expect_error(
  $$insert into public.tasks (title, life_area_id) values ('Mine', '40000000-0000-0000-0000-0000000000a1')$$,
  'B cannot file a task under A''s life area');
select pg_temp.expect_error(
  $$insert into public.tasks (title, goal_id) values ('Mine', '30000000-0000-0000-0000-0000000000a1')$$,
  'B cannot link a task to A''s goal');
select pg_temp.expect_error(
  $$insert into public.habit_logs (habit_id, logged_on) values ('70000000-0000-0000-0000-0000000000a1', '2026-11-18')$$,
  'B cannot check off A''s habit');
select pg_temp.expect_error(
  $$insert into public.life_areas (user_id, name, color) values ('00000000-0000-0000-0000-0000000000a1', 'Planted', 'blue')$$,
  'B cannot create an area for A');
select pg_temp.expect_error(
  $$select public.delete_life_area('40000000-0000-0000-0000-0000000000a1', null)$$,
  'B cannot delete A''s area through the function');

-- B's own area cannot be used as a reassignment target for A (checked below as A).
insert into public.life_areas (id, name, color) values ('40000000-0000-0000-0000-0000000000b1', 'B only', 'pink');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect(
  (select title from public.tasks where id = '50000000-0000-0000-0000-0000000000a1') = 'Prep rebuttal',
  'B''s update did not change A''s task');
select pg_temp.expect(
  exists (select 1 from public.commitments where id = '60000000-0000-0000-0000-0000000000a1'),
  'B''s delete did not remove A''s event');
select pg_temp.expect(
  exists (select 1 from public.life_areas where id = '40000000-0000-0000-0000-0000000000a1'),
  'B''s delete did not remove A''s area');

select pg_temp.expect_error(
  $$select public.delete_life_area('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000b1')$$,
  'A cannot move items into an area they do not own');

-- ---------- Deleting an area never deletes data ----------
select public.delete_life_area(
  '40000000-0000-0000-0000-0000000000a1',
  (select id from public.life_areas where name = 'Extracurriculars'));

select pg_temp.expect(
  (select la.name from public.tasks t join public.life_areas la on la.id = t.life_area_id
    where t.id = '50000000-0000-0000-0000-0000000000a1') = 'Extracurriculars',
  'reassign moves tasks to the chosen area');
select pg_temp.expect(
  (select area from public.tasks where id = '50000000-0000-0000-0000-0000000000a1') = 'extracurricular',
  'reassign keeps the legacy enum in sync');
select pg_temp.expect(
  (select count(*) from public.commitments where life_area_id = (select id from public.life_areas where name = 'Extracurriculars')) = 1
  and (select count(*) from public.habits where life_area_id = (select id from public.life_areas where name = 'Extracurriculars')) = 1,
  'reassign moves events and habits too');
select pg_temp.expect(
  not exists (select 1 from public.life_areas where id = '40000000-0000-0000-0000-0000000000a1'),
  'the area itself is deleted');

-- Plain delete (no reassignment): records become uncategorized.
delete from public.life_areas where name = 'Sports';
select pg_temp.expect(
  (select life_area_id is null and area is null from public.goals where id = '30000000-0000-0000-0000-0000000000a1'),
  'deleting an area leaves its records uncategorized, not deleted');

-- ---------- Signed-out visitors see nothing ----------
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select pg_temp.expect((select count(*) from public.life_areas) = 0, 'anon cannot read life areas');
select pg_temp.expect((select count(*) from public.tasks) = 0, 'anon cannot read tasks');
select pg_temp.expect_error($$select public.delete_life_area(gen_random_uuid(), null)$$, 'anon cannot call delete_life_area');

reset role;
select pg_temp.expect(
  not has_function_privilege('authenticated', 'public.seed_default_life_areas(uuid)', 'execute'),
  'users cannot call the seeding function directly');

rollback;
