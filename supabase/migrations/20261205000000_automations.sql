-- Automations: a weekly email, or an email when a matching event is booked.
--
-- templates: the rule the user saved. It never sends by itself.
-- template_runs: one row per firing, so the same Friday (or the same event)
--   stages one review card and does not stage it again.
-- The card is an ordinary send_email plan item. Sending still waits for Send.
--
-- Also lets a plan item save or turn off a template. Those wait for approval too.
--
-- Additive. Depends on 20261204000000_gmail_send.sql.

create table if not exists public.templates (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 200),
  template_type  text not null check (template_type in ('recurring_automation', 'conditional_trigger')),
  schedule_rule  jsonb not null default '{}'::jsonb check (jsonb_typeof(schedule_rule) = 'object' and pg_column_size(schedule_rule) <= 2000),
  payload        jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8000),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists templates_user_idx on public.templates (user_id, is_active);

drop trigger if exists templates_set_updated_at on public.templates;
create trigger templates_set_updated_at before update on public.templates
  for each row execute function public.set_updated_at();

alter table public.templates enable row level security;

drop policy if exists "templates: read own" on public.templates;
drop policy if exists "templates: insert own" on public.templates;
drop policy if exists "templates: update own" on public.templates;
drop policy if exists "templates: delete own" on public.templates;

create policy "templates: read own" on public.templates for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "templates: insert own" on public.templates for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "templates: update own" on public.templates for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "templates: delete own" on public.templates for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.templates to authenticated;

create table if not exists public.template_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  template_id     uuid not null references public.templates (id) on delete cascade,
  occurrence_key  text not null check (char_length(occurrence_key) between 1 and 80),
  plan_id         uuid references public.plan_proposals (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (template_id, occurrence_key)
);

create index if not exists template_runs_user_idx on public.template_runs (user_id, created_at desc);

alter table public.template_runs enable row level security;

drop policy if exists "template_runs: read own" on public.template_runs;
drop policy if exists "template_runs: insert own" on public.template_runs;
drop policy if exists "template_runs: update own" on public.template_runs;
drop policy if exists "template_runs: delete own" on public.template_runs;

create policy "template_runs: read own" on public.template_runs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "template_runs: insert own" on public.template_runs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "template_runs: update own" on public.template_runs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "template_runs: delete own" on public.template_runs for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.template_runs to authenticated;

alter table public.plan_items drop constraint if exists plan_items_action_check;
alter table public.plan_items add constraint plan_items_action_check check (action in (
  'create_event', 'schedule_block', 'move_block', 'remove_block', 'remove_event', 'skip_occurrence', 'update_event',
  'create_task', 'update_task', 'complete_task', 'remove_task',
  'create_habit', 'update_habit',
  'create_goal', 'update_goal',
  'set_life_area', 'update_preferences', 'save_fact',
  'send_email', 'save_template', 'cancel_template'));
