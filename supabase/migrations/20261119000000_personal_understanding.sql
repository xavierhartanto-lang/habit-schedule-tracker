-- =============================================================
-- Phase 2: Personal understanding.
--
-- Adds persistent conversations and messages, plus one generic
-- `context_items` table for things the user tells the assistant that do
-- not fit an existing table (activities without fixed times, interests,
-- routines, working times and scheduling preferences).
--
-- Fixed commitments still live in `commitments` and goals in `goals`.
-- Both gain a `source` so the user can see where each fact came from.
-- Every new table is owned by a user and protected by Row Level Security.
-- =============================================================

-- ---------- Types ----------
create type public.conversation_kind as enum ('onboarding', 'assistant');
create type public.message_role as enum ('user', 'assistant');
create type public.context_category as enum
  ('activity', 'interest', 'routine', 'working_time', 'preference');
-- 'conversation' = the user said it in a chat and confirmed it.
-- 'manual'       = the user typed it into a form.
create type public.data_source as enum ('conversation', 'manual');
create type public.goal_horizon as enum ('short_term', 'long_term');

-- ---------- Conversations ----------
create table public.conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind             public.conversation_kind not null default 'assistant',
  title            text check (char_length(title) between 1 and 120),
  -- Short recap used as context in later conversations (memory).
  summary          text check (char_length(summary) <= 2000),
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- Messages ----------
create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  role             public.message_role not null,
  content          text not null check (char_length(content) between 1 and 20000),
  -- Structured extras, e.g. proposed context items and their saved/dismissed state.
  metadata         jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 32768),
  created_at       timestamptz not null default now()
);

-- ---------- Context items ----------
create table public.context_items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category           public.context_category not null,
  title              text not null check (char_length(title) between 1 and 200),
  details            text check (char_length(details) <= 1000),
  -- Null when the item is not tied to one life area (e.g. a general preference).
  area               public.life_area,
  -- Optional structure: days, start/end time, times per week, duration.
  attributes         jsonb not null default '{}'::jsonb
                     check (jsonb_typeof(attributes) = 'object' and pg_column_size(attributes) <= 4096),
  source             public.data_source not null default 'manual',
  source_message_id  uuid references public.messages (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------- Provenance on existing tables ----------
alter table public.commitments
  add column source            public.data_source not null default 'manual',
  add column source_message_id uuid references public.messages (id) on delete set null;

alter table public.goals
  add column horizon           public.goal_horizon,
  add column source            public.data_source not null default 'manual',
  add column source_message_id uuid references public.messages (id) on delete set null;

-- ---------- Indexes ----------
create index conversations_user_recent_idx   on public.conversations (user_id, last_message_at desc);
create index conversations_user_kind_idx     on public.conversations (user_id, kind);
create index messages_conversation_time_idx  on public.messages (conversation_id, created_at);
create index context_items_user_category_idx on public.context_items (user_id, category);
-- Foreign keys used by "on delete set null".
create index context_items_source_message_idx on public.context_items (source_message_id) where source_message_id is not null;
create index commitments_source_message_idx   on public.commitments (source_message_id) where source_message_id is not null;
create index goals_source_message_idx         on public.goals (source_message_id) where source_message_id is not null;

-- ---------- updated_at triggers ----------
create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();
create trigger context_items_set_updated_at before update on public.context_items
  for each row execute function public.set_updated_at();

-- ---------- Row Level Security ----------
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.context_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array['conversations','messages','context_items']
  loop
    execute format('create policy "%1$s: read own"   on public.%1$I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: insert own" on public.%1$I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: update own" on public.%1$I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "%1$s: delete own" on public.%1$I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;

-- ---------- Ownership checks ----------
-- Extends the Phase 1 helper with the messages -> conversations link.
create or replace function public.assert_same_owner()
returns trigger language plpgsql security invoker as $$
declare parent_owner uuid;
begin
  if tg_table_name = 'goal_milestones' then
    select user_id into parent_owner from public.goals where id = new.goal_id;
  elsif tg_table_name = 'habit_logs' then
    select user_id into parent_owner from public.habits where id = new.habit_id;
  elsif tg_table_name = 'messages' then
    select user_id into parent_owner from public.conversations where id = new.conversation_id;
  end if;
  if parent_owner is distinct from new.user_id then
    raise exception 'Parent record not found';
  end if;
  return new;
end;
$$;

-- A message must belong to a conversation the same user owns.
create trigger messages_same_owner before insert or update on public.messages
  for each row execute function public.assert_same_owner();

-- A fact's optional source message must be one of the same user's messages.
create or replace function public.assert_source_message_owner()
returns trigger language plpgsql security invoker as $$
declare message_owner uuid;
begin
  if new.source_message_id is null then
    return new;
  end if;
  select user_id into message_owner from public.messages where id = new.source_message_id;
  if message_owner is distinct from new.user_id then
    raise exception 'Source message not found';
  end if;
  return new;
end;
$$;

create trigger context_items_source_owner before insert or update of source_message_id, user_id on public.context_items
  for each row execute function public.assert_source_message_owner();
create trigger commitments_source_owner before insert or update of source_message_id, user_id on public.commitments
  for each row execute function public.assert_source_message_owner();
create trigger goals_source_owner before insert or update of source_message_id, user_id on public.goals
  for each row execute function public.assert_source_message_owner();

-- Keep conversations sorted by latest activity.
create or replace function public.touch_conversation()
returns trigger language plpgsql security invoker as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id
     and last_message_at < new.created_at;
  return new;
end;
$$;

create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.touch_conversation();
