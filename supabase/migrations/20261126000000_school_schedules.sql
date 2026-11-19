-- =============================================================
-- School bell schedule (asked once, during onboarding).
--
-- One row per user. `schedule` is the structured bell schedule the user
-- confirmed (day types, periods, lunch, A/B rotation), validated in the
-- app (zod). Saving turns each day type into one repeating fixed
-- "School" event in `commitments`, which the scheduling engine already
-- treats as busy time. `commitment_ids` remembers those events, so a
-- later edit replaces them instead of stacking duplicates.
--
-- status = 'skipped' means the user chose not to set it up; onboarding
-- doesn't ask again. Nothing is saved until the user taps Save.
-- Owned by the user and protected by Row Level Security.
-- =============================================================

create table public.school_schedules (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  status          text not null check (status in ('saved', 'skipped')),
  school          text check (school is null or char_length(school) <= 120),
  district        text check (district is null or char_length(district) <= 120),
  schedule        jsonb check (schedule is null or jsonb_typeof(schedule) = 'object'),
  commitment_ids  uuid[] not null default '{}' check (cardinality(commitment_ids) <= 20),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint school_schedules_saved_has_schedule check (status = 'skipped' or schedule is not null)
);

create trigger school_schedules_set_updated_at before update on public.school_schedules
  for each row execute function public.set_updated_at();

alter table public.school_schedules enable row level security;

create policy "school_schedules: read own"   on public.school_schedules for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "school_schedules: insert own" on public.school_schedules for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "school_schedules: update own" on public.school_schedules for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "school_schedules: delete own" on public.school_schedules for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.school_schedules to authenticated;

-- ---------- Save in one transaction ----------
-- Replaces the user's previous school events with p_blocks, stores the
-- schedule and fills in profiles.school when it is empty.
-- p_blocks: [{ title, starts_at, ends_at, recurrence_rule, timezone, notes }]
-- Runs as the caller, so RLS applies to every statement.
create or replace function public.save_school_schedule(
  p_schedule jsonb,
  p_school   text,
  p_district text,
  p_blocks   jsonb
) returns uuid[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  old_ids uuid[];
  new_ids uuid[] := '{}';
  b       jsonb;
  new_id  uuid;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(p_blocks) <> 'array' or jsonb_array_length(p_blocks) not between 1 and 7 then
    raise exception 'Invalid school blocks' using errcode = '22023';
  end if;

  select commitment_ids into old_ids from public.school_schedules where user_id = uid for update;
  if old_ids is not null and cardinality(old_ids) > 0 then
    delete from public.commitments where user_id = uid and id = any (old_ids);
  end if;

  for b in select * from jsonb_array_elements(p_blocks) loop
    insert into public.commitments (
      user_id, title, area, kind, starts_at, ends_at, recurrence_rule, timezone, notes, source
    ) values (
      uid,
      b ->> 'title',
      'academics',
      'fixed',
      (b ->> 'starts_at')::timestamptz,
      (b ->> 'ends_at')::timestamptz,
      b ->> 'recurrence_rule',
      b ->> 'timezone',
      nullif(b ->> 'notes', ''),
      'manual'
    ) returning id into new_id;
    new_ids := new_ids || new_id;
  end loop;

  insert into public.school_schedules (user_id, status, school, district, schedule, commitment_ids)
  values (uid, 'saved', nullif(trim(p_school), ''), nullif(trim(p_district), ''), p_schedule, new_ids)
  on conflict (user_id) do update
    set status = 'saved',
        school = excluded.school,
        district = excluded.district,
        schedule = excluded.schedule,
        commitment_ids = excluded.commitment_ids;

  if nullif(trim(p_school), '') is not null then
    update public.profiles set school = left(trim(p_school), 120)
     where id = uid and (school is null or trim(school) = '');
  end if;

  return new_ids;
end;
$$;

revoke all on function public.save_school_schedule(jsonb, text, text, jsonb) from public;
grant execute on function public.save_school_schedule(jsonb, text, text, jsonb) to authenticated;
