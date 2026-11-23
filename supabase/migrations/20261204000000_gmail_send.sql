-- Let Whitespace send one email after the user presses Send on a card.
--
-- 1. google_connections.can_send: the Gmail send permission was granted.
--    Existing connections stay false until the user reconnects.
-- 2. plan_items accepts the action 'send_email'. The app sends the message
--    and then marks the item applied. There is no undo: a sent email stays sent.
--
-- Additive. Depends on 20261202000000_google_calendar_write.sql and
-- 20261127000000_assistant_update_event.sql.

alter table public.google_connections
  add column if not exists can_send boolean not null default false;

alter table public.plan_items drop constraint if exists plan_items_action_check;
alter table public.plan_items add constraint plan_items_action_check check (action in (
  'create_event', 'schedule_block', 'move_block', 'remove_block', 'remove_event', 'skip_occurrence', 'update_event',
  'create_task', 'update_task', 'complete_task', 'remove_task',
  'create_habit', 'update_habit',
  'create_goal', 'update_goal',
  'set_life_area', 'update_preferences', 'save_fact',
  'send_email'));
