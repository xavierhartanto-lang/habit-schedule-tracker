-- =============================================================
-- Phase 3: Core planning system.
--
-- Builds on the existing tables instead of replacing them:
--   * life_areas (new): customizable, user-owned life areas. Replaces the
--     fixed `life_area` enum as the way records are categorized. The enum
--     column `area` stays on every table as a legacy mirror so Phase 2 code
--     (AI proposals) keeps working; a trigger keeps the two in sync.
--   * commitments  = calendar events (fixed or flexible). Adds all-day,
--     timezone and skipped occurrences for recurring events.
--   * tasks        = separate from events. Adds a description.
--   * habits       = adds "specific weekdays" frequency and a description.
--   * goals        = adds manual progress (0-100).
--
-- Deleting a life area never deletes records: they are moved to another
-- area (delete_life_area) or become uncategorized (on delete set null).
-- Every table stays owned by a user and protected by Row Level Security.
-- =============================================================

-- ---------- Life areas ----------
create table public.life_areas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  color       text not null default 'slate'
              check (color in ('blue','violet','green','amber','pink','slate','teal','orange','cyan','brown')),
  position    integer not null default 0 check (position between 0 and 1000),
  -- Which old enum value this area stands for. Lets AI-saved facts
  -- (which still name an enum value) land in the right area. Null for
  -- areas the user created.
  legacy_key  public.life_area,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index life_areas_user_name_key   on public.life_areas (user_id, lower(btrim(name)));
create unique index life_areas_user_legacy_key on public.life_areas (user_id, legacy_key) where legacy_key is not null;
create index life_areas_user_position_idx      on public.life_areas (user_id, position);

create trigger life_areas_set_updated_at before update on public.life_areas
  for each row execute function public.set_updated_at();

-- legacy_key is set once by the defaults and never changed afterwards.
create or replace function public.life_areas_keep_legacy_key()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.legacy_key := old.legacy_key;
  return new;
end;
$$;

create trigger life_areas_keep_legacy_key before update on public.life_areas
  for each row execute function public.life_areas_keep_legacy_key();

alter table public.life_areas enable row level security;

create policy "life_areas: read own"   on public.life_areas for select to authenticated using ((select auth.uid()) = user_id);
create policy "life_areas: insert own" on public.life_areas for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "life_areas: update own" on public.life_areas for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "life_areas: delete own" on public.life_areas for delete to authenticated using ((select auth.uid()) = user_id);

-- Sensible defaults. Safe to call twice: existing names are skipped.
create or replace function public.seed_default_life_areas(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.life_areas (user_id, name, color, position, legacy_key) values
    (p_user, 'Academics',         'blue',   0, 'academics'),
    (p_user, 'Extracurriculars',  'violet', 1, 'extracurricular'),
    (p_user, 'Sports',            'green',  2, 'athletics'),
    (p_user, 'Hobbies',           'amber',  3, 'creative'),
    (p_user, 'Personal Projects', 'teal',   4, null),
    (p_user, 'Social',            'orange', 5, null),
    (p_user, 'Personal & Rest',   'slate',  6, 'personal')
  on conflict do nothing;
$$;

revoke execute on function public.seed_default_life_areas(uuid) from public, anon, authenticated;

-- New users get the defaults along with their profile and preferences.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''));
  insert into public.user_preferences (user_id) values (new.id);
  perform public.seed_default_life_areas(new.id);
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Existing users get the defaults too.
do $$
declare r record;
begin
  for r in select id from auth.users loop
    perform public.seed_default_life_areas(r.id);
  end loop;
end $$;

-- Maps an old enum value to the user's matching area. "rest" falls back to
-- "Personal & Rest". Returns null when the user has no matching area.
create or replace function public.life_area_for_key(p_user uuid, p_key public.life_area)
returns uuid language sql stable security invoker set search_path = '' as $$
  select id
    from public.life_areas
   where user_id = p_user
     and p_key is not null
     and legacy_key in (p_key, case when p_key = 'rest' then 'personal'::public.life_area end)
   order by (legacy_key = p_key) desc
   limit 1;
$$;

-- ---------- Calendar events (commitments) ----------
alter table public.commitments
  add column life_area_id          uuid references public.life_areas (id) on delete set null,
  add column all_day               boolean not null default false,
  -- IANA zone the event was created in. Recurring events repeat at the same
  -- local time in this zone, across daylight saving changes.
  add column timezone              text check (timezone is null or char_length(timezone) between 1 and 64),
  -- Local dates (in `timezone`) of occurrences the user removed from a series.
  add column recurrence_exceptions date[] not null default '{}'
                                   check (cardinality(recurrence_exceptions) <= 500),
  alter column area drop not null,
  add constraint commitments_notes_length check (notes is null or char_length(notes) <= 2000),
  add constraint commitments_location_length check (location is null or char_length(location) <= 200),
  add constraint commitments_rrule_length check (recurrence_rule is null or char_length(recurrence_rule) <= 300);

-- ---------- Tasks ----------
alter table public.tasks
  add column life_area_id uuid references public.life_areas (id) on delete set null,
  add column description  text check (description is null or char_length(description) <= 2000),
  alter column area drop not null,
  add constraint tasks_estimated_minutes_max check (estimated_minutes is null or estimated_minutes <= 1440);

-- ---------- Habits ----------
-- New frequency: on specific weekdays. Only compared as text below, so the
-- new value is never "used" inside this transaction.
alter type public.habit_cadence add value if not exists 'specific_days';

alter table public.habits
  add column life_area_id uuid references public.life_areas (id) on delete set null,
  add column description  text check (description is null or char_length(description) <= 500),
  -- ISO weekdays, 1 = Monday ... 7 = Sunday.
  add column weekdays     smallint[] check (
    weekdays is null
    or (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]::smallint[])
  ),
  alter column area drop not null,
  add constraint habits_specific_days_need_weekdays check (cadence::text <> 'specific_days' or weekdays is not null);

-- ---------- Goals ----------
alter table public.goals
  add column life_area_id uuid references public.life_areas (id) on delete set null,
  add column progress     smallint not null default 0 check (progress between 0 and 100),
  alter column area drop not null,
  add constraint goals_description_length check (description is null or char_length(description) <= 2000);

-- ---------- Context items (Phase 2) ----------
alter table public.context_items
  add column life_area_id uuid references public.life_areas (id) on delete set null;

-- ---------- Backfill area links from the old enum ----------
update public.commitments   set life_area_id = public.life_area_for_key(user_id, area) where area is not null;
update public.tasks         set life_area_id = public.life_area_for_key(user_id, area) where area is not null;
update public.habits        set life_area_id = public.life_area_for_key(user_id, area) where area is not null;
update public.goals         set life_area_id = public.life_area_for_key(user_id, area) where area is not null;
update public.context_items set life_area_id = public.life_area_for_key(user_id, area) where area is not null;

-- ---------- Keep life_area_id and the legacy enum in sync ----------
-- * Writing life_area_id (new code): checks the area is the user's own and
--   mirrors its legacy enum value (null for custom areas).
-- * Writing only the enum (Phase 2 AI proposals): finds the matching area.
-- * Deleting an area sets life_area_id to null, which clears the enum too.
create or replace function public.sync_life_area()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  area_key public.life_area;
begin
  if tg_op = 'INSERT' then
    if new.life_area_id is not null then
      select legacy_key into area_key from public.life_areas
       where id = new.life_area_id and user_id = new.user_id;
      if not found then
        raise exception 'Life area not found' using errcode = '23503';
      end if;
      new.area := area_key;
    elsif new.area is not null then
      new.life_area_id := public.life_area_for_key(new.user_id, new.area);
    end if;
    return new;
  end if;

  if new.life_area_id is distinct from old.life_area_id or new.user_id is distinct from old.user_id then
    if new.life_area_id is null then
      new.area := null;
    else
      select legacy_key into area_key from public.life_areas
       where id = new.life_area_id and user_id = new.user_id;
      if not found then
        raise exception 'Life area not found' using errcode = '23503';
      end if;
      new.area := area_key;
    end if;
  elsif new.area is distinct from old.area then
    new.life_area_id := public.life_area_for_key(new.user_id, new.area);
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['commitments','tasks','habits','goals','context_items']
  loop
    execute format(
      'create trigger %I_sync_life_area before insert or update on public.%I for each row execute function public.sync_life_area()',
      t, t);
  end loop;
end $$;

-- A task's optional goal and event must belong to the same user.
create or replace function public.assert_task_links_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.goal_id is not null
     and not exists (select 1 from public.goals where id = new.goal_id and user_id = new.user_id) then
    raise exception 'Goal not found' using errcode = '23503';
  end if;
  if new.commitment_id is not null
     and not exists (select 1 from public.commitments where id = new.commitment_id and user_id = new.user_id) then
    raise exception 'Event not found' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger tasks_links_owner before insert or update of goal_id, commitment_id, user_id on public.tasks
  for each row execute function public.assert_task_links_owner();

-- ---------- Delete a life area without losing data ----------
-- Moves every record in the area to `p_reassign_to`, or leaves them
-- uncategorized when it is null, then deletes the area. One transaction.
create or replace function public.delete_life_area(p_area_id uuid, p_reassign_to uuid default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.life_areas where id = p_area_id and user_id = uid) then
    raise exception 'Life area not found' using errcode = 'P0002';
  end if;
  if p_reassign_to is not null then
    if p_reassign_to = p_area_id
       or not exists (select 1 from public.life_areas where id = p_reassign_to and user_id = uid) then
      raise exception 'Choose a different life area' using errcode = '22023';
    end if;
    update public.commitments   set life_area_id = p_reassign_to where user_id = uid and life_area_id = p_area_id;
    update public.tasks         set life_area_id = p_reassign_to where user_id = uid and life_area_id = p_area_id;
    update public.habits        set life_area_id = p_reassign_to where user_id = uid and life_area_id = p_area_id;
    update public.goals         set life_area_id = p_reassign_to where user_id = uid and life_area_id = p_area_id;
    update public.context_items set life_area_id = p_reassign_to where user_id = uid and life_area_id = p_area_id;
  end if;
  delete from public.life_areas where id = p_area_id and user_id = uid;
end;
$$;

revoke execute on function public.delete_life_area(uuid, uuid) from public, anon;
grant execute on function public.delete_life_area(uuid, uuid) to authenticated;

-- Internal helpers are not part of the API.
revoke execute on function public.sync_life_area() from public, anon, authenticated;
revoke execute on function public.assert_task_links_owner() from public, anon, authenticated;
revoke execute on function public.life_areas_keep_legacy_key() from public, anon, authenticated;

-- ---------- Indexes ----------
-- Foreign keys used by "on delete set null" and area filters.
create index commitments_life_area_idx   on public.commitments (life_area_id) where life_area_id is not null;
create index tasks_life_area_idx         on public.tasks (life_area_id) where life_area_id is not null;
create index habits_life_area_idx        on public.habits (life_area_id) where life_area_id is not null;
create index goals_life_area_idx         on public.goals (life_area_id) where life_area_id is not null;
create index context_items_life_area_idx on public.context_items (life_area_id) where life_area_id is not null;
create index tasks_goal_idx              on public.tasks (goal_id) where goal_id is not null;
create index tasks_commitment_idx        on public.tasks (commitment_id) where commitment_id is not null;
-- Calendar reads: every recurring event, plus one-off events in a window.
create index commitments_user_recurring_idx on public.commitments (user_id) where recurrence_rule is not null;
create index commitments_user_ends_idx      on public.commitments (user_id, ends_at);
