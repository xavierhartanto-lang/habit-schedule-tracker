-- =============================================================
-- Checks for 20261128000000_phase7_intelligence.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase7_intelligence.test.sql
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

-- New kinds are accepted; unknown kinds still are not.
insert into public.recommendations (dedupe_key, kind, priority, title, reason, message)
values ('commitment_conflict:a:b', 'commitment_conflict', 'high', 't', 'r', 'm'),
       ('deadline_cluster:x:y', 'deadline_cluster', 'medium', 't', 'r', 'm'),
       ('neglected_area:z', 'neglected_area', 'low', 't', 'r', 'm'),
       ('overdue:old', 'overdue', 'medium', 't', 'r', 'm');
select pg_temp.expect((select count(*) from public.recommendations) = 4, 'new and old kinds insert');
select pg_temp.expect_error($$insert into public.recommendations (dedupe_key, kind, priority, title, reason, message) values ('k', 'made_up', 'low', 't', 'r', 'm')$$, 'unknown kind rejected');

-- Session outcomes.
insert into public.commitments (id, title, kind, starts_at, ends_at)
values ('00000000-0000-0000-0000-00000000c001', 'Essay session', 'flexible', now() - interval '2 hours', now() - interval '1 hour');
select pg_temp.expect((select outcome is null from public.commitments where id = '00000000-0000-0000-0000-00000000c001'), 'outcome defaults to null');
update public.commitments set outcome = 'missed', outcome_at = now(), outcome_source = 'user' where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.expect((select outcome = 'missed' from public.commitments where id = '00000000-0000-0000-0000-00000000c001'), 'owner records an outcome');
select pg_temp.expect_error($$update public.commitments set outcome = 'skipped', outcome_at = now(), outcome_source = 'user' where id = '00000000-0000-0000-0000-00000000c001'$$, 'unknown outcome rejected');
select pg_temp.expect_error($$update public.commitments set outcome = 'done', outcome_at = null, outcome_source = 'user' where id = '00000000-0000-0000-0000-00000000c001'$$, 'outcome without a time rejected');
update public.commitments set outcome = null, outcome_at = null, outcome_source = null where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.expect((select outcome is null from public.commitments where id = '00000000-0000-0000-0000-00000000c001'), 'outcome can be cleared');

-- Another user can't see or change it.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
update public.commitments set outcome = 'done', outcome_at = now(), outcome_source = 'user' where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect((select outcome is null from public.commitments where id = '00000000-0000-0000-0000-00000000c001'), 'RLS: other users cannot record outcomes');

rollback;
