-- =============================================================
-- Checks for 20261130000000_weekly_briefings.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/weekly_briefings.test.sql
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

-- User A writes a briefing.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.weekly_briefings (week_start, facts_hash, summary) values ('2026-11-23', 'abc', 'A calm week.');
select pg_temp.expect((select count(*) from public.weekly_briefings) = 1, 'owner inserts and reads');
select pg_temp.expect((select user_id from public.weekly_briefings) = '00000000-0000-0000-0000-0000000000a1', 'user_id defaults to the caller');

-- Idempotent: one row per user per week.
select pg_temp.expect_error($$insert into public.weekly_briefings (week_start, facts_hash) values ('2026-11-23', 'def')$$, 'second row for the same week rejected');
insert into public.weekly_briefings (week_start, facts_hash) values ('2026-11-23', 'def')
  on conflict (user_id, week_start) do update set facts_hash = excluded.facts_hash, summary = null;
select pg_temp.expect((select facts_hash from public.weekly_briefings) = 'def', 'upsert refreshes the row');
select pg_temp.expect_error($$insert into public.weekly_briefings (week_start, facts_hash) values ('2026-11-30', '')$$, 'empty hash rejected');
select pg_temp.expect_error($$insert into public.weekly_briefings (user_id, week_start, facts_hash) values ('00000000-0000-0000-0000-0000000000b1', '2026-11-30', 'x')$$, 'cannot write a row for someone else');

-- User B sees nothing of A's and cannot change it.
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect((select count(*) from public.weekly_briefings) = 0, 'other user reads nothing');
update public.weekly_briefings set dismissed_at = now();
delete from public.weekly_briefings;
reset role;
select pg_temp.expect((select dismissed_at is null from public.weekly_briefings where user_id = '00000000-0000-0000-0000-0000000000a1'), 'other user cannot dismiss');
select pg_temp.expect((select count(*) from public.weekly_briefings) = 1, 'other user cannot delete');

-- Deleting the account removes its briefings.
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.expect((select count(*) from public.weekly_briefings) = 0, 'cascade on account delete');

rollback;
