/**
 * Automations: a weekly email, or an email when an event is booked.
 * Email templates: saved drafts the assistant fills from a calendar event when
 * asked in chat. Those always land on a card and wait for Send.
 * Pure checks only. Nothing here sends mail or writes to the database.
 * An automation is sent through Gmail when it comes due. One-off chat emails are separate and still wait.
 */

import { addDaysToKey, dateKeyInZone, isoWeekdayOfKey, timeKeyInZone } from "@/lib/scheduling/zoned";
import { validateOutgoingEmail, type OutgoingEmail } from "./email";
import type { Weekday } from "./types";
import { WEEKDAYS } from "./types";

export const TEMPLATE_TYPES = ["recurring_automation", "conditional_trigger", "email_template"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export type WeeklySchedule = { kind: "weekly"; weekday: Weekday; time: string };
/** manual = an email template, used only when asked for in chat. */
export type ScheduleRule = WeeklySchedule | { kind: "event" } | { kind: "manual" };

export type TemplatePayload = {
  to: string;
  subject: string;
  body: string;
  /** Conditional templates: the event title must contain this. Email templates: which events it is for (optional). */
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

/** Placeholder name → value. Any `{snake_case}` name may be used; a missing or blank value stays as `{name}`. */
export type TemplateVars = Record<string, string | null | undefined>;

/** `{student_name}`, `{grade}`, `{materials}`, or any custom lower-case name. */
const VAR_RE = /\{([a-z][a-z0-9_]{0,39})\}/g;

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
  return text.replace(VAR_RE, (token, key: string) => {
    const value = Object.hasOwn(vars, key) ? vars[key]?.trim() : undefined;
    return value ? value : token;
  });
}

/** Every placeholder name used across these texts, first use first. */
export function templateVariables(...texts: string[]): string[] {
  const names: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(VAR_RE)) if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Placeholders still unfilled in a draft. An email with any of these is not sent from a card. */
export function unfilledVariables(email: { to?: string; subject: string; body: string }): string[] {
  return templateVariables(email.to ?? "", email.subject, email.body);
}

/** Note labels that mean the same thing as a common placeholder. */
const LABEL_ALIASES: Record<string, string[]> = {
  student_name: ["student", "student name", "students", "name", "tutee", "kid", "child"],
  grade: ["grade", "grade level", "year", "class"],
  materials: ["materials", "material", "print", "prints", "printing", "print materials", "printouts", "handouts", "worksheets", "worksheet", "bring", "copies"],
  subject: ["subject", "topic", "course"],
  room: ["room", "classroom"],
  teacher: ["teacher", "tutor", "instructor"],
};

function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function labelFits(name: string, label: string): boolean {
  const key = labelKey(label);
  if (!key) return false;
  const plain = name.replace(/_/g, " ");
  if (key === plain) return true;
  if (plain.endsWith(" name") && key === plain.slice(0, -5)) return true;
  return (LABEL_ALIASES[name] ?? []).includes(key);
}

/**
 * Values written as `Label: value` in an event's notes, for the placeholders asked for.
 * Reads only what is written. Nothing is guessed, so a name that isn't there stays unfilled.
 * Handles one per line or several on a line: "Student: Maya, Grade: 7, Print: worksheet 4".
 */
export function extractNoteValues(notes: string | null | undefined, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!notes || !names.length) return out;
  const text = notes.replace(/\r\n/g, "\n").slice(0, 4000);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s*•·-]+/, "");
    const labels = [...line.matchAll(/(?:^|[,;|•·]\s*|\s[-–]\s)([A-Za-z][A-Za-z ]{0,30}?)\s*[:=]\s*/g)];
    labels.forEach((m, i) => {
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < labels.length ? (labels[i + 1].index ?? line.length) : line.length;
      const value = line.slice(start, end).trim().replace(/[\s,;.]+$/, "").slice(0, 200);
      if (!value) return;
      const name = names.find((n) => !(n in out) && labelFits(n, m[1]));
      if (name) out[name] = value;
    });
  }
  return out;
}

export function readSchedule(value: unknown): ScheduleRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "event") return { kind: "event" };
  if (raw.kind === "manual") return { kind: "manual" };
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
  if (!TEMPLATE_TYPES.includes(input.templateType)) return { ok: false, error: "Choose a weekly email, an event email, or a template." };
  const email = validateOutgoingEmail(input.payload);
  if (!email.ok) return email;
  if (input.templateType === "email_template") {
    const match = oneLine(input.payload.match, 200);
    return { ok: true, value: { title, templateType: input.templateType, schedule: { kind: "manual" }, payload: { ...email.value, match: match || null } } };
  }
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
  if (template.templateType === "email_template") {
    const forEvents = template.payload.match ? ` for “${template.payload.match}” events` : "";
    return `Template${forEvents}, used from chat · To ${template.payload.to}`;
  }
  if (template.templateType === "conditional_trigger") {
    return `When an event contains “${template.payload.match}” · To ${template.payload.to}`;
  }
  if (template.schedule.kind === "weekly") {
    return `Every ${WEEKDAY_LABEL[template.schedule.weekday]} at ${template.schedule.time} · To ${template.payload.to}`;
  }
  return `To ${template.payload.to}`;
}

/**
 * What a calendar event says for itself: its title, day, time and place, plus
 * any `Label: value` notes that match a placeholder. Only stated facts.
 */
export function eventTemplateVars(
  event: { title: string; location?: string | null; notes?: string | null },
  startsAt: string | null,
  timeZone: string,
  names: string[],
): TemplateVars {
  const vars: TemplateVars = { event_title: event.title, location: event.location?.trim() || null };
  if (startsAt) {
    const at = new Date(startsAt);
    if (!Number.isNaN(at.getTime())) {
      vars.date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone }).format(at);
      vars.time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
    }
  }
  // Notes fill only placeholders the event's own fields didn't.
  const fromNotes = extractNoteValues(event.notes, names.filter((n) => !vars[n]));
  return { ...vars, ...fromNotes };
}
