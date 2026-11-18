-- =============================================================
-- Checks for 20261121000000_scheduling_preferences.sql.
--
-- Run against a database with all migrations applied (local Supabase or
-- a scratch project), as a role that can insert into auth.users:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/scheduling_preferences.test.sql
--
-- Everything runs in one transaction and is rolled back.
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
  raise exception 'expected an error: %', label;
end;
$$;

grant execute on function pg_temp.expect_error(text, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

-- Defaults fill in; user_id defaults to the caller.
insert into public.scheduling_preferences (working_hours) values ('{"mo":[{"start":"15:30","end":"21:30"}]}');
do $$
declare r public.scheduling_preferences;
begin
  select * into r from public.scheduling_preferences;
  if r.user_id <> '00000000-0000-0000-0000-0000000000a1' then raise exception 'user_id default'; end if;
  if r.max_session_minutes <> 90 or r.buffer_minutes <> 10 or r.keep_free_percent <> 30 then raise exception 'defaults'; end if;
  raise notice 'ok: insert with defaults';
end $$;

-- Constraints.
select pg_temp.expect_error($q$update public.scheduling_preferences set buffer_minutes = 61$q$, 'buffer range');
select pg_temp.expect_error($q$update public.scheduling_preferences set min_session_minutes = 120, max_session_minutes = 60$q$, 'min <= max');
select pg_temp.expect_error($q$update public.scheduling_preferences set working_hours = '[]'$q$, 'working_hours is an object');
select pg_temp.expect_error($q$update public.scheduling_preferences set protected_times = '{}'$q$, 'protected_times is an array');
select pg_temp.expect_error($q$insert into public.scheduling_preferences (user_id) values ('00000000-0000-0000-0000-0000000000a1')$q$, 'one row per user');

-- RLS: user B can't see, change or create A's row.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
do $$
declare n int;
begin
  select count(*) into n from public.scheduling_preferences;
  if n <> 0 then raise exception 'B sees A''s row'; end if;
  update public.scheduling_preferences set buffer_minutes = 0;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B updated A''s row'; end if;
  delete from public.scheduling_preferences;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'B deleted A''s row'; end if;
  raise notice 'ok: RLS hides other users';
end $$;
select pg_temp.expect_error(
  $q$insert into public.scheduling_preferences (user_id) values ('00000000-0000-0000-0000-0000000000a1')$q$,
  'cannot insert for another user');

-- Upsert as used by saveSchedulingPreferences.
insert into public.scheduling_preferences (user_id, buffer_minutes) values ('00000000-0000-0000-0000-0000000000b1', 5)
  on conflict (user_id) do update set buffer_minutes = excluded.buffer_minutes;
insert into public.scheduling_preferences (user_id, buffer_minutes) values ('00000000-0000-0000-0000-0000000000b1', 15)
  on conflict (user_id) do update set buffer_minutes = excluded.buffer_minutes;
do $$
begin
  if (select buffer_minutes from public.scheduling_preferences) <> 15 then raise exception 'upsert'; end if;
  raise notice 'ok: upsert';
end $$;

-- Deleting the user removes their preferences.
reset role;
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
do $$
begin
  if exists (select 1 from public.scheduling_preferences where user_id = '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'cascade';
  end if;
  raise notice 'ok: cascade on user delete';
end $$;

rollback;
