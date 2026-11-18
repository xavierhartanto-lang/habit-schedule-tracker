-- =============================================================
-- Checks for 20261119000000_personal_understanding.sql.
--
-- Run against a database with all migrations applied (local Supabase or
-- a scratch project), as a role that can insert into auth.users:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/personal_understanding.test.sql
--
-- Everything runs in one transaction and is rolled back. Any failed
-- check raises an exception and stops the script.
-- =============================================================

begin;

-- Two users. The signup trigger creates their profile and preferences.
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b');

-- Helper: act as a signed-in user.
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

-- ---------- User A creates a conversation, messages and facts ----------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');

insert into public.conversations (id, kind, title)
values ('10000000-0000-0000-0000-00000000000a', 'onboarding', 'Getting to know you');

insert into public.messages (id, conversation_id, role, content, created_at) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'assistant',
   'What does a normal school day look like?', now() - interval '1 minute'),
  ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', 'user',
   'School 8 to 3, swim Mon/Wed/Fri 4 to 6.', now() + interval '1 minute');

select pg_temp.expect(
  (select last_message_at > now() from public.conversations where id = '10000000-0000-0000-0000-00000000000a'),
  'new message moves conversation last_message_at forward');

insert into public.context_items (category, title, area, attributes, source, source_message_id)
values ('routine', 'Swim practice', 'athletics',
        '{"days":["mo","we","fr"],"startTime":"16:00","endTime":"18:00"}',
        'conversation', '20000000-0000-0000-0000-0000000000a2');

insert into public.commitments (title, area, kind, starts_at, ends_at, recurrence_rule, source, source_message_id)
values ('School', 'academics', 'fixed', '2026-11-23 08:00+00', '2026-11-23 15:00+00',
        'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'conversation', '20000000-0000-0000-0000-0000000000a2');

insert into public.goals (title, area, source) values ('Make state finals', 'athletics', 'conversation');

select pg_temp.expect((select source from public.goals limit 1) = 'conversation', 'goals accept a source');
select pg_temp.expect(
  (select count(*) from public.commitments where source = 'conversation') = 1,
  'commitments accept a source');

-- Constraints
select pg_temp.expect_error(
  $$insert into public.context_items (category, title) values ('routine', '')$$,
  'empty context title');
select pg_temp.expect_error(
  $$insert into public.context_items (category, title, attributes) values ('routine', 'x', '[]')$$,
  'non-object attributes');
select pg_temp.expect_error(
  $$insert into public.messages (conversation_id, role, content) values ('10000000-0000-0000-0000-00000000000a', 'user', '')$$,
  'empty message');
select pg_temp.expect_error(
  $$insert into public.messages (conversation_id, role, content) values ('10000000-0000-0000-0000-00000000000a', 'system', 'hi')$$,
  'unknown message role');

-- ---------- User B cannot see or touch A's data ----------
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');

select pg_temp.expect((select count(*) from public.conversations) = 0, 'B sees no conversations of A');
select pg_temp.expect((select count(*) from public.messages) = 0, 'B sees no messages of A');
select pg_temp.expect((select count(*) from public.context_items) = 0, 'B sees no context items of A');

select pg_temp.expect_error(
  $$insert into public.messages (conversation_id, role, content) values ('10000000-0000-0000-0000-00000000000a', 'user', 'hijack')$$,
  'B cannot post into A''s conversation');
select pg_temp.expect_error(
  $$insert into public.context_items (category, title, source_message_id) values ('interest', 'x', '20000000-0000-0000-0000-0000000000a2')$$,
  'B cannot cite A''s message as a source');
select pg_temp.expect_error(
  $$insert into public.goals (title, area, source_message_id) values ('x', 'personal', '20000000-0000-0000-0000-0000000000a2')$$,
  'B cannot cite A''s message on a goal');
select pg_temp.expect_error(
  $$insert into public.conversations (user_id, kind) values ('00000000-0000-0000-0000-00000000000a', 'assistant')$$,
  'B cannot create a conversation owned by A');

update public.context_items set title = 'hacked';
delete from public.conversations;

-- ---------- Back as A: data intact, deletes behave ----------
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');

select pg_temp.expect((select title from public.context_items) = 'Swim practice', 'B''s update did nothing');
select pg_temp.expect((select count(*) from public.conversations) = 1, 'B''s delete did nothing');

delete from public.conversations where id = '10000000-0000-0000-0000-00000000000a';
select pg_temp.expect((select count(*) from public.messages) = 0, 'deleting a conversation removes its messages');
select pg_temp.expect(
  (select count(*) from public.context_items where source_message_id is null) = 1,
  'saved facts survive their conversation being deleted');
select pg_temp.expect(
  (select count(*) from public.commitments where source_message_id is null) = 1,
  'commitments survive their conversation being deleted');

-- Anonymous visitors see nothing.
reset role;
set local role anon;
select pg_temp.expect((select count(*) from public.context_items) = 0, 'anon sees nothing');

reset role;
rollback;
