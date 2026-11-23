/**
 * Automations: a weekly email, or an email when an event is booked.
 * Pure checks only. Nothing here sends mail or writes to the database.
 * A match is sent through Gmail when it comes due. One-off chat emails are separate and still wait.
 */

import { addDaysToKey, dateKeyInZone, isoWeekdayOfKey, timeKeyInZone } from "@/lib/scheduling/zoned";
import { validateOutgoingEmail, type OutgoingEmail } from "./email";
import type { Weekday } from "./types";
import { WEEKDAYS } from "./types";

export const TEMPLATE_TYPES = ["recurring_automation", "conditional_trigger"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export type WeeklySchedule = { kind: "weekly"; weekday: Weekday; time: string };
export type ScheduleRule = WeeklySchedule | { kind: "event" };

export type TemplatePayload = {
  to: string;
  subject: string;
  body: string;
  /** Conditional templates: the event title must contain this. */
  match: string | null;
};

export type TemplateInput = {
  title: string;
  templateType: TemplateType;
  schedule: ScheduleRule;
  payload: TemplatePayload;
};

export type AutomationTemplate = TemplateInput & { id: string; active: boolean };

/** What an automatic send just did. Shown on Home and Automations. Never includes the message body. */
export type AutomationReport = { sent: string[]; errors: string[] };

export const EMPTY_AUTOMATION_REPORT: AutomationReport = { sent: [], errors: [] };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_ISO: Record<Weekday, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

export type TemplateVars = Partial<Record<"student_name" | "grade" | "event_title" | "date" | "time", string | null>>;

function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === "string" && (WEEKDAYS as readonly string[]).includes(value);
}

/** The local date of the latest weekly slot at or before `now`, or null if that slot has not arrived. */
export function dueOccurrenceKey(rule: WeeklySchedule, now: Date, timeZone: string): string | null {
  const today = dateKeyInZone(now, timeZone);
  const nowTime = timeKeyInZone(now, timeZone);
  const want = WEEKDAY_ISO[rule.weekday];
  for (let back = 0; back < 7; back++) {
    const key = addDaysToKey(today, -back);
    if (isoWeekdayOfKey(key) !== want) continue;
    if (back === 0 && nowTime < rule.time) return null;
    return key;
  }
  return null;
}

/** True when the event title contains the watched words. An empty watch matches nothing. */
export function eventMatches(match: string | null | undefined, eventTitle: string): boolean {
  const needle = (match ?? "").trim().toLowerCase();
  if (!needle) return false;
  return eventTitle.toLowerCase().includes(needle);
}

/** Fills known placeholders. Anything unknown is left as `{name}` so the user can edit it. */
export function fillTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{(student_name|grade|event_title|date|time)\}/g, (token, key: keyof TemplateVars) => {
    const value = vars[key]?.trim();
    return value ? value : token;
  });
}

export function readSchedule(value: unknown): ScheduleRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "event") return { kind: "event" };
  if (raw.kind === "weekly" && isWeekday(raw.weekday) && typeof raw.time === "string" && TIME_RE.test(raw.time)) {
    return { kind: "weekly", weekday: raw.weekday, time: raw.time };
  }
  return null;
}

export function readPayload(value: unknown): TemplatePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const to = oneLine(raw.to, 254);
  const subject = oneLine(raw.subject, 200);
  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n/g, "\n").trim().slice(0, 4000) : "";
  if (!to || !subject || !body) return null;
  const match = oneLine(raw.match, 200);
  return { to, subject, body, match: match || null };
}

export function validateTemplate(input: TemplateInput): { ok: true; value: TemplateInput } | { ok: false; error: string } {
  const title = oneLine(input.title, 200);
  if (!title) return { ok: false, error: "The automation needs a name." };
  if (!TEMPLATE_TYPES.includes(input.templateType)) return { ok: false, error: "Choose a weekly email or an event email." };
  const email = validateOutgoingEmail(input.payload);
  if (!email.ok) return email;
  if (input.templateType === "recurring_automation") {
    if (input.schedule.kind !== "weekly") return { ok: false, error: "A weekly email needs a day and a time." };
    return { ok: true, value: { title, templateType: input.templateType, schedule: input.schedule, payload: { ...email.value, match: null } } };
  }
  const match = oneLine(input.payload.match, 200);
  if (!match) return { ok: false, error: "Say which event this watches, such as tutoring." };
  if (input.schedule.kind !== "event") return { ok: false, error: "This automation runs when an event is booked." };
  return { ok: true, value: { title, templateType: input.templateType, schedule: { kind: "event" }, payload: { ...email.value, match } } };
}

/** The draft for one firing. Null when the saved template is no longer a valid email. */
export function draftForTemplate(template: TemplateInput, vars: TemplateVars): OutgoingEmail | null {
  const filled = validateOutgoingEmail({
    to: fillTemplate(template.payload.to, vars),
    subject: fillTemplate(template.payload.subject, vars),
    body: fillTemplate(template.payload.body, vars),
  });
  return filled.ok ? filled.value : null;
}

export function templateSummary(template: Pick<AutomationTemplate, "templateType" | "schedule" | "payload">): string {
  if (template.templateType === "conditional_trigger") {
    return `When an event contains “${template.payload.match}” · To ${template.payload.to}`;
  }
  if (template.schedule.kind === "weekly") {
    return `Every ${WEEKDAY_LABEL[template.schedule.weekday]} at ${template.schedule.time} · To ${template.payload.to}`;
  }
  return `To ${template.payload.to}`;
}
