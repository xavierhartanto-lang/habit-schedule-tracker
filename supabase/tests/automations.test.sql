-- Checks for 20261205000000_automations.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/automations.test.sql

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2');

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

insert into public.templates (id, title, template_type, schedule_rule, payload) values (
  'a0000000-0000-0000-0000-0000000000e1',
  'Science Bowl reminder',
  'recurring_automation',
  '{"kind":"weekly","weekday":"fr","time":"18:00"}'::jsonb,
  '{"to":"team@school.edu","subject":"Science Bowl","body":"Practice tonight."}'::jsonb
);
select pg_temp.expect((select is_active from public.templates) = true, 'a new automation starts on');
select pg_temp.expect_error(
  $$insert into public.templates (title, template_type) values ('nope', 'spam')$$,
  'unknown template types are rejected');

insert into public.plan_proposals (id, kind) values ('a0000000-0000-0000-0000-0000000000e2', 'actions');
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-0000000000e1', 'a0000000-0000-0000-0000-0000000000e2', 0, 'save_template', 'Science Bowl reminder');
select pg_temp.expect((select count(*) from public.plan_items where action = 'save_template') = 1, 'saving an automation can wait on a card');

insert into public.template_runs (template_id, occurrence_key, plan_id) values
  ('a0000000-0000-0000-0000-0000000000e1', '2026-11-20', 'a0000000-0000-0000-0000-0000000000e2');
select pg_temp.expect_error(
  $$insert into public.template_runs (template_id, occurrence_key) values ('a0000000-0000-0000-0000-0000000000e1', '2026-11-20')$$,
  'the same Friday is not staged twice');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect((select count(*) from public.templates) = 0, 'someone else cannot see the automation');
select pg_temp.expect((select count(*) from public.template_runs) = 0, 'someone else cannot see its runs');

rollback;
