-- Checks for 20261204000000_gmail_send.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/gmail_send.test.sql
-- One transaction, rolled back.

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

insert into public.google_connections (user_id, refresh_token) values ('00000000-0000-0000-0000-0000000000a1', 'token');
select pg_temp.expect((select can_send from public.google_connections) = false, 'email starts off until they allow it');
update public.google_connections set can_send = true;
select pg_temp.expect((select can_send from public.google_connections) = true, 'reconnect can allow sending');

insert into public.plan_proposals (id, kind) values ('a0000000-0000-0000-0000-0000000000e1', 'actions');
insert into public.plan_items (id, proposal_id, position, action, title) values
  ('a1000000-0000-0000-0000-0000000000e1', 'a0000000-0000-0000-0000-0000000000e1', 0, 'send_email', 'Late to practice');
select pg_temp.expect((select count(*) from public.plan_items where action = 'send_email') = 1, 'an email card can be stored');
select pg_temp.expect_error(
  $$insert into public.plan_items (proposal_id, position, action, title) values ('a0000000-0000-0000-0000-0000000000e1', 1, 'post_tweet', 'no')$$,
  'unknown plan actions are still rejected');

rollback;
