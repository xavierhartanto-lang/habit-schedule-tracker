-- Checks for 20261206000000_email_templates.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/email_templates.test.sql

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
  'a0000000-0000-0000-0000-0000000000f1',
  'Office print request',
  'email_template',
  '{"kind":"manual"}'::jsonb,
  '{"to":"office@school.edu","subject":"Print for {student_name}","body":"Grade {grade}: {materials}","match":"tutoring"}'::jsonb
);
select pg_temp.expect((select count(*) from public.templates where template_type = 'email_template') = 1, 'an email template can be saved');
select pg_temp.expect_error(
  $$insert into public.templates (title, template_type) values ('nope', 'spam')$$,
  'unknown template types are still rejected');
select pg_temp.expect_error(
  $$insert into public.templates (user_id, title, template_type) values ('00000000-0000-0000-0000-0000000000b2', 'theirs', 'email_template')$$,
  'a template cannot be saved for someone else');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect((select count(*) from public.templates) = 0, 'someone else cannot see the template');
update public.templates set title = 'hijacked' where id = 'a0000000-0000-0000-0000-0000000000f1';
delete from public.templates where id = 'a0000000-0000-0000-0000-0000000000f1';

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select title from public.templates where id = 'a0000000-0000-0000-0000-0000000000f1') = 'Office print request', 'someone else cannot change or delete it');

rollback;
