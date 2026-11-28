-- Email templates: a saved email with {placeholders} that the assistant fills
-- from a calendar event when asked in chat.
--
-- Stored in public.templates beside automations, with template_type
-- 'email_template' and schedule_rule {"kind":"manual"}. To, subject and body stay
-- in the validated payload jsonb, so the text is only stored in one place.
-- An email template never fires by itself. Each use stages an ordinary
-- send_email card that waits for Send.
--
-- RLS is unchanged: the policies from 20261205000000 already limit every
-- row to its owner.
--
-- Additive. Depends on 20261205000000_automations.sql.

alter table public.templates drop constraint if exists templates_template_type_check;
alter table public.templates add constraint templates_template_type_check
  check (template_type in ('recurring_automation', 'conditional_trigger', 'email_template'));
