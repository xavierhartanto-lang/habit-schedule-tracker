-- =============================================================
-- Checks for 20261129000000_phase7_steps.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase7_steps.test.sql
-- One transaction, rolled back.
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

-- exam_prep is accepted; unknown kinds still are not.
insert into public.recommendations (dedupe_key, kind, priority, title, reason, message)
values ('exam_prep:e:2026-11-20', 'exam_prep', 'high', 't', 'r', 'm');
select pg_temp.expect((select count(*) from public.recommendations where kind = 'exam_prep') = 1, 'exam_prep kind inserts');
select pg_temp.expect_error($$insert into public.recommendations (dedupe_key, kind, priority, title, reason, message) values ('k', 'made_up', 'low', 't', 'r', 'm')$$, 'unknown kind rejected');

-- Steps.
insert into public.tasks (id, title, area) values
  ('00000000-0000-0000-0000-00000000d001', 'History essay', 'academics');
insert into public.tasks (id, title, area, parent_task_id) values
  ('00000000-0000-0000-0000-00000000d002', 'Outline', 'academics', '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-00000000d003', 'First draft', 'academics', '00000000-0000-0000-0000-00000000d001');
select pg_temp.expect((select count(*) from public.tasks where parent_task_id = '00000000-0000-0000-0000-00000000d001') = 2, 'owner adds steps');
select pg_temp.expect_error($$insert into public.tasks (title, area, parent_task_id) values ('Sub-step', 'academics', '00000000-0000-0000-0000-00000000d002')$$, 'a step cannot have steps');
select pg_temp.expect_error($$update public.tasks set parent_task_id = '00000000-0000-0000-0000-00000000d001' where id = '00000000-0000-0000-0000-00000000d001'$$, 'a task cannot be its own step');
insert into public.tasks (id, title, area) values ('00000000-0000-0000-0000-00000000d004', 'Other', 'academics');
select pg_temp.expect_error($$update public.tasks set parent_task_id = '00000000-0000-0000-0000-00000000d004' where id = '00000000-0000-0000-0000-00000000d001'$$, 'a task with steps cannot become a step');

-- Another user can't hang steps on someone else's task.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect_error($$insert into public.tasks (title, area, parent_task_id) values ('Sneaky', 'academics', '00000000-0000-0000-0000-00000000d001')$$, 'steps only on your own tasks');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

-- Deleting the parent keeps its steps as ordinary tasks.
delete from public.tasks where id = '00000000-0000-0000-0000-00000000d001';
select pg_temp.expect((select count(*) from public.tasks where id in ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000d003') and parent_task_id is null) = 2, 'steps survive their parent');

rollback;
