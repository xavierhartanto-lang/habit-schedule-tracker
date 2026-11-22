import { z } from "zod";

import { isGrounded, normalizeText } from "@/lib/ai/extraction";
import type { ContextCategory, Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";
import type { DateRef } from "./dates";
import { nameActivity, type NamingContext } from "./naming";

/**
 * Planner output: what the user wants done, as structured intents.
 *
 * Flow
 *   1. The planner model returns `PlannerWireSchema` (structured outputs).
 *   2. `validatePlannerOutput` re-parses it, drops anything not grounded in
 *      the user's words, cleans every field and merges follow-up answers
 *      into the draft they complete.
 *   3. `assessIntent` (assess.ts) decides whether an intent has everything
 *      it needs, or which single question to ask next.
 *
 * The model never writes to the database and never computes dates or
 * availability. Pure module, unit tested.
 */

export const INTENT_TYPES = [
  "create_event", // a commitment with a time: class, practice, exam
  "create_task", // a to-do
  "update_task", // change title, due date, priority or estimate of an existing task
  "complete_task", // mark an existing task done
  "remove_task", // delete an existing task for good ("delete my essay task")
  "create_habit",
  "update_habit", // change how often
  "create_goal",
  "update_goal", // progress or target date
  "set_life_area", // categorize an existing record
  "update_preferences", // working hours, session length, protected time
  "save_fact", // Phase 2 context item: activity, interest, routine, working time, preference
  "plan_time", // find time for work: "3 hours to study this week", "piano twice"
  "remove_event", // "cancel all math tutoring": remove an event (whole series) for good
  "cant_make", // "I can't study Wednesday anymore"
  "finished_early", // "I finished my coding project early"
  "not_enough_time", // "I don't think I'll have enough time this week"
  "remove_duplicates", // "clean up duplicates this week, keep the Google one"
  "cancel_draft", // "never mind" / "don't add it" about an open action (asking or on a card)
  "update_event", // change an existing event: rename, move, new time or length, repeat rule
  "confirm_action", // "yes", "looks good", "add it": approve an action waiting on a card
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

const PRIORITIES = ["high", "medium", "low"] as const;
const RECURRENCES = ["once", "weekly", "weekdays", "daily"] as const;
const WINDOWS = ["today", "tomorrow", "this_week", "next_week", "until_deadline"] as const;
const AMOUNT_KINDS = ["total", "sessions", "single"] as const;
const CADENCES = ["daily", "weekly", "specific_days"] as const;
const FACT_CATEGORIES = ["activity", "interest", "routine", "working_time", "preference"] as const;
const SCOPES = ["one", "all"] as const;
export type Scope = (typeof SCOPES)[number];

export type Recurrence = (typeof RECURRENCES)[number];
export type PlanWindow = (typeof WINDOWS)[number];

// ---------------------------------------------------------------------------
// Wire schema (what the model returns). Flat and nullable so it compiles to
// a structured-output JSON schema. Strict checks happen below.
// ---------------------------------------------------------------------------

const zDay = z.enum(WEEKDAYS as unknown as [Weekday, ...Weekday[]]);

const WireDate = z
  .object({
    iso_date: z.string().nullable().describe('"YYYY-MM-DD" only if the user named a calendar date, else null.'),
    weekday: zDay.nullable().describe("Weekday the user named, e.g. 'fr' for Friday."),
    week: z.enum(["this", "next"]).nullable().describe('"next" only if the user said "next <weekday>" or "next week".'),
    day_offset: z.number().int().nullable().describe("0 = today, 1 = tomorrow. Only for those words."),
  })
  .describe("A day reference. Copy what the user said; never compute dates yourself.");

const WireIntent = z.object({
  type: z.enum(INTENT_TYPES),
  draft_id: z.string().nullable().describe("Id from <active_actions> when this message adds to, corrects, confirms or cancels it, else null."),
  explicit: z
    .boolean()
    .describe("True only if the user directly asked Whitespace to do this now (\"add a task…\", \"mark … done\")."),
  title: z.string().nullable().describe("Clean calendar name in title case, e.g. 'Math Tutoring'. See Naming."),
  evidence: z.string().describe("Exact words from the user's NEW message that state this. Copied verbatim."),
  area: z.string().nullable().describe("One of the user's life area names, or null if unclear."),
  target_ref: z
    .string()
    .nullable()
    .describe("Ref of an existing record from <current_plan> (t1, e2, b3, h1, g2) this is about, else null."),
  target_name: z.string().nullable().describe("The user's own words for the existing record (\"training\", \"the tutoring\"), else null."),
  date: WireDate.nullable().describe("When it happens (events) or the day affected (cant_make)."),
  start_time: z.string().nullable().describe('24h "HH:MM" if stated. "at 6" for a practice usually means 18:00.'),
  start_in_minutes: z.number().int().nullable().describe('"in two hours" = 120. Only for "in N minutes/hours".'),
  end_time: z.string().nullable(),
  duration_minutes: z.number().int().nullable().describe("Only if stated (\"2 hours\" = 120)."),
  recurrence: z.enum(RECURRENCES).nullable().describe("null if the user has not said whether it repeats."),
  days: z.array(zDay).describe("Days it repeats on. Empty if not stated."),
  deadline: WireDate.nullable().describe("Due date / deadline day, if stated."),
  deadline_time: z.string().nullable(),
  amount_kind: z.enum(AMOUNT_KINDS).nullable().describe("plan_time: total = split as needed; sessions = N times; single = one block."),
  amount_minutes: z.number().int().nullable().describe("plan_time: total minutes, or minutes of the single block."),
  session_count: z.number().int().nullable().describe("plan_time with sessions: how many times."),
  session_minutes: z.number().int().nullable().describe("plan_time with sessions: minutes each, only if stated."),
  window: z.enum(WINDOWS).nullable().describe("plan_time / not_enough_time / remove_duplicates: which period."),
  priority: z.enum(PRIORITIES).nullable(),
  cadence: z.enum(CADENCES).nullable().describe("Habits: how often."),
  times_per_week: z.number().int().nullable(),
  progress: z.number().int().nullable().describe("Goals: 0-100 if the user gave it."),
  target_date: WireDate.nullable().describe("Goals: target date."),
  location: z.string().nullable(),
  scope: z.enum(SCOPES).nullable().describe("Repeating events: one = only that day, all = every repeat."),
  fact_category: z.enum(FACT_CATEGORIES).nullable().describe("save_fact only."),
  details: z.string().nullable().describe("One short description sentence: specifics from the user or established context. Not the title."),
  pref_day_start: z.string().nullable().describe('update_preferences: earliest time for work "HH:MM".'),
  pref_day_end: z.string().nullable().describe('update_preferences: latest time for work "HH:MM".'),
  pref_max_session_minutes: z.number().int().nullable(),
  pref_buffer_minutes: z.number().int().nullable(),
  pref_protected_label: z.string().nullable().describe("update_preferences: protected time name, e.g. 'Family dinner'."),
});

export const PlannerWireSchema = z.object({
  intents: z.array(WireIntent),
  question: z
    .string()
    .nullable()
    .describe("One short question only if the message is genuinely ambiguous in a way the fields cannot express."),
});
export type PlannerWire = z.infer<typeof PlannerWireSchema>;

// ---------------------------------------------------------------------------
// API schema (what is actually sent as the structured-output format).
//
// The API compiles output schemas into a grammar and allows at most 16
// union-typed fields (a nullable field is a union) and 24 optional fields
// across a request. PlannerWireSchema above has 30 nullable fields, so the
// model is asked for this union-free twin instead: every field is required
// and "not stated" is written as "" (text), -1 (numbers) or "none" (choices).
// `fromApiWire` turns those back into nulls before validation.
// ---------------------------------------------------------------------------

const NONE = "none" as const;
const apiEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum([...values, NONE] as [T[number] | typeof NONE, ...(T[number] | typeof NONE)[]]);
const apiText = (d?: string) => z.string().describe(`${d ? `${d} ` : ""}Empty string if not stated.`);
const apiInt = (d?: string) => z.number().int().describe(`${d ? `${d} ` : ""}-1 if not stated.`);

const ApiDate = z
  .object({
    iso_date: apiText('"YYYY-MM-DD" only if the user named a calendar date.'),
    weekday: apiEnum(WEEKDAYS as unknown as [Weekday, ...Weekday[]]).describe("Weekday the user named, e.g. 'fr' for Friday. \"none\" if not named."),
    week: apiEnum(["this", "next"] as const).describe('"next" only if the user said "next <weekday>" or "next week". "none" otherwise.'),
    day_offset: apiInt("0 = today, 1 = tomorrow. Only for those words."),
  })
  .describe('A day reference. Copy what the user said; never compute dates yourself. All fields empty / "none" / -1 when no day was given.');

const ApiIntent = z.object({
  type: z.enum(INTENT_TYPES),
  draft_id: apiText("Id from <active_actions> when this message adds to, corrects, confirms or cancels that action."),
  explicit: z.boolean().describe('True only if the user directly asked Whitespace to do this now ("add a task…", "mark … done", "cancel …").'),
  title: apiText("Clean calendar name in title case, e.g. 'Math Tutoring', 'Chemistry Homework'. Follow the Naming rules."),
  evidence: z.string().describe("Exact words from the user's NEW message that state this. Copied verbatim."),
  area: apiText("One of the user's life area names, if clear."),
  target_ref: apiText("Ref of an existing record from <current_plan> (t1, e2, b3, h1, g2) this is about."),
  target_name: apiText('The user\'s own words for that existing record, e.g. "training", "the tutoring".'),
  date: ApiDate.describe("When it happens (events) or the day affected (cant_make)."),
  start_time: apiText('24h "HH:MM" if stated. "at 6" for a practice usually means 18:00.'),
  start_in_minutes: apiInt('Only for "in N minutes/hours" from now: "in two hours" = 120. Never compute the clock time yourself.'),
  end_time: apiText('24h "HH:MM".'),
  duration_minutes: apiInt('Only if stated ("2 hours" = 120).'),
  recurrence: apiEnum(RECURRENCES).describe('"none" if the user has not said whether it repeats.'),
  days: z.array(zDay).describe("Days it repeats on. Empty if not stated."),
  deadline: ApiDate.describe("Due date / deadline day, if stated."),
  deadline_time: apiText('24h "HH:MM".'),
  amount_kind: apiEnum(AMOUNT_KINDS).describe("plan_time: total = split as needed; sessions = N times; single = one block."),
  amount_minutes: apiInt("plan_time: total minutes, or minutes of the single block."),
  session_count: apiInt("plan_time with sessions: how many times."),
  session_minutes: apiInt("plan_time with sessions: minutes each, only if stated."),
  window: apiEnum(WINDOWS).describe("plan_time / not_enough_time / remove_duplicates: which period."),
  priority: apiEnum(PRIORITIES),
  cadence: apiEnum(CADENCES).describe("Habits: how often."),
  times_per_week: apiInt(),
  progress: apiInt("Goals: 0-100 if the user gave it."),
  target_date: ApiDate.describe("Goals: target date."),
  location: apiText(),
  scope: apiEnum(SCOPES).describe('Changes to a repeating event: "one" = only that day, "all" = every repeat. "none" if not said.'),
  fact_category: apiEnum(FACT_CATEGORIES).describe("save_fact only."),
  details: apiText("One short description sentence: specifics from the user's words or established context that do not belong in the title."),
  pref_day_start: apiText('update_preferences: earliest time for work "HH:MM".'),
  pref_day_end: apiText('update_preferences: latest time for work "HH:MM".'),
  pref_max_session_minutes: apiInt(),
  pref_buffer_minutes: apiInt(),
  pref_protected_label: apiText("update_preferences: protected time name, e.g. 'Family dinner'."),
});

export const PlannerApiSchema = z.object({
  intents: z.array(ApiIntent),
  question: apiText("One short question only if the message is genuinely ambiguous in a way the fields cannot express."),
});
export type PlannerApi = z.infer<typeof PlannerApiSchema>;

/** Keys whose values are never "not stated" markers. */
const KEEP_AS_IS = new Set(["type", "evidence", "explicit", "days"]);
const DATE_KEYS = new Set(["date", "deadline", "target_date"]);

function unmark(value: unknown): unknown {
  if (value === "" || value === NONE || value === -1) return null;
  return value;
}

function unmarkDate(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const out = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, unmark(typeof v === "string" ? v.trim() : v)]));
  return Object.values(out).every((v) => v === null) ? null : out;
}

/**
 * Converts the union-free API output back into the nullable wire shape.
 * Anything malformed is passed through for `validatePlannerOutput` to reject.
 */
export function fromApiWire(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as { intents?: unknown; question?: unknown };
  const intents = Array.isArray(p.intents)
    ? p.intents.map((raw) => {
        if (!raw || typeof raw !== "object") return raw;
        return Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).map(([k, v]) => {
            if (KEEP_AS_IS.has(k)) return [k, v];
            if (DATE_KEYS.has(k)) return [k, unmarkDate(v)];
            return [k, unmark(typeof v === "string" ? v.trim() : v)];
          }),
        );
      })
    : p.intents;
  return { intents, question: unmark(typeof p.question === "string" ? p.question.trim() : p.question) };
}
type WireIntentT = z.infer<typeof WireIntent>;

// ---------------------------------------------------------------------------
// Validated intent
// ---------------------------------------------------------------------------

export type Intent = {
  type: IntentType;
  draftId: string | null;
  explicit: boolean;
  title: string | null;
  evidence: string;
  area: string | null;
  targetRef: string | null;
  /** The user's words for the existing record, checked against its name. */
  targetName: string | null;
  /** Set by the server when the user answered our own "which one?" question with this ref. */
  targetConfirmed?: boolean;
  date: DateRef | null;
  startTime: string | null;
  /** "In two hours": minutes from now. The server turns it into a date and time. */
  startInMinutes: number | null;
  endTime: string | null;
  durationMinutes: number | null;
  recurrence: Recurrence | null;
  days: Weekday[];
  deadline: DateRef | null;
  deadlineTime: string | null;
  amountKind: "total" | "sessions" | "single" | null;
  amountMinutes: number | null;
  sessionCount: number | null;
  sessionMinutes: number | null;
  window: PlanWindow | null;
  priority: "high" | "medium" | "low" | null;
  cadence: "daily" | "weekly" | "specific_days" | null;
  timesPerWeek: number | null;
  progress: number | null;
  targetDate: DateRef | null;
  location: string | null;
  scope: Scope | null;
  factCategory: Exclude<ContextCategory, never> | null;
  details: string | null;
  prefs: {
    dayStart: string | null;
    dayEnd: string | null;
    maxSessionMinutes: number | null;
    bufferMinutes: number | null;
    protectedLabel: string | null;
  };
};

/** Unfinished intent the assistant is still asking about. Stored on the conversation. */
export type Draft = {
  id: string;
  intent: Intent;
  /** The field last asked about, so the same question is never repeated blindly. */
  asked: string[];
  createdAt: string;
};

export const MAX_INTENTS = 12;
export const MAX_DRAFTS = 5;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REF_RE = /^[tebhg]\d{1,3}$/;

function clean(value: string | null | undefined, max = 200): string | null {
  if (value == null) return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function time(value: string | null): string | null {
  const t = clean(value, 5);
  if (!t) return null;
  const padded = /^\d:\d\d$/.test(t) ? `0${t}` : t;
  return TIME_RE.test(padded) ? padded : null;
}

function intIn(value: number | null, min: number, max: number): number | null {
  if (value == null || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function dateRef(raw: WireIntentT["date"]): DateRef | null {
  if (!raw) return null;
  const isoDate = raw.iso_date && DATE_RE.test(raw.iso_date) ? raw.iso_date : null;
  const ref: DateRef = {
    isoDate,
    weekday: raw.weekday ?? null,
    week: raw.weekday ? (raw.week ?? null) : null,
    dayOffset: intIn(raw.day_offset, -7, 366),
  };
  return ref.isoDate || ref.weekday || ref.dayOffset !== null ? ref : null;
}

export function toIntent(raw: WireIntentT): Intent {
  const days = WEEKDAYS.filter((d) => raw.days.includes(d));
  return {
    type: raw.type,
    draftId: clean(raw.draft_id, 40),
    explicit: raw.explicit === true,
    title: clean(raw.title, 200),
    evidence: clean(raw.evidence, 500) ?? "",
    area: clean(raw.area, 40),
    targetRef: raw.target_ref && REF_RE.test(raw.target_ref.trim()) ? raw.target_ref.trim() : null,
    targetName: clean(raw.target_name, 120),
    date: dateRef(raw.date),
    startTime: time(raw.start_time),
    startInMinutes: intIn(raw.start_in_minutes, 1, 7 * 24 * 60),
    endTime: time(raw.end_time),
    durationMinutes: intIn(raw.duration_minutes, 5, 24 * 60),
    recurrence: raw.recurrence ?? null,
    days,
    deadline: dateRef(raw.deadline),
    deadlineTime: time(raw.deadline_time),
    amountKind: raw.amount_kind ?? null,
    amountMinutes: intIn(raw.amount_minutes, 5, 40 * 60),
    sessionCount: intIn(raw.session_count, 1, 21),
    sessionMinutes: intIn(raw.session_minutes, 5, 8 * 60),
    window: raw.window ?? null,
    priority: raw.priority ?? null,
    cadence: raw.cadence ?? null,
    timesPerWeek: intIn(raw.times_per_week, 1, 7),
    progress: intIn(raw.progress, 0, 100),
    targetDate: dateRef(raw.target_date),
    location: clean(raw.location, 200),
    scope: raw.scope ?? null,
    factCategory: raw.fact_category ?? null,
    details: clean(raw.details, 500),
    prefs: {
      dayStart: time(raw.pref_day_start),
      dayEnd: time(raw.pref_day_end),
      maxSessionMinutes: intIn(raw.pref_max_session_minutes, 15, 480),
      bufferMinutes: intIn(raw.pref_buffer_minutes, 0, 60),
      protectedLabel: clean(raw.pref_protected_label, 60),
    },
  };
}

/**
 * Field-by-field merge of a follow-up into its draft. Values in `next`
 * win (corrections), nulls keep what the draft already had (no duplicate
 * questions). The type may change, e.g. a draft event becoming a task.
 */
export function mergeIntent(draft: Intent, next: Intent): Intent {
  const pick = <T>(a: T | null, b: T | null): T | null => (b !== null ? b : a);
  // A correction to something new stays a creation: "it's math tutoring" renames
  // the proposed event, it doesn't turn it into an edit of a saved one.
  const keepType =
    draft.type.startsWith("create_") && (next.type === "update_event" || next.type === "update_task" || next.type === "confirm_action");
  // Times move together: a new start keeps the length; a new length drops the old end.
  let endTime = pick(draft.endTime, next.endTime);
  let durationMinutes = pick(draft.durationMinutes, next.durationMinutes);
  if (next.startTime && !next.endTime && !next.durationMinutes && draft.startTime && draft.endTime) {
    const length = minutesBetween(draft.startTime, draft.endTime);
    if (length > 0) {
      durationMinutes = length;
      endTime = null;
    }
  }
  if (next.durationMinutes && !next.endTime) endTime = null;
  if (next.endTime && !next.durationMinutes) durationMinutes = null;
  // A one-time thing moved to another day stays one time: "Actually Saturday" never re-asks "every Saturday?".
  const wasOneOff = !!draft.date && (draft.date.isoDate !== null || draft.date.dayOffset !== null || draft.date.week !== null);
  const recurrence = pick(draft.recurrence, next.recurrence) ?? (next.date && wasOneOff ? "once" : null);
  let days = next.days.length ? next.days : draft.days;
  if (recurrence === "once" || recurrence === "daily" || recurrence === "weekdays") days = next.days;
  else if (!next.days.length && next.date?.weekday && recurrence === "weekly") days = [next.date.weekday];
  return {
    type: keepType ? draft.type : next.type,
    draftId: draft.draftId,
    explicit: draft.explicit || next.explicit,
    title: pick(draft.title, next.title),
    evidence: draft.evidence || next.evidence,
    area: pick(draft.area, next.area),
    targetRef: pick(draft.targetRef, next.targetRef),
    targetName: pick(draft.targetName, next.targetName),
    date: pick(draft.date, next.date),
    startTime: pick(draft.startTime, next.startTime),
    startInMinutes: next.startInMinutes ?? (next.startTime || next.date ? null : draft.startInMinutes),
    endTime,
    durationMinutes,
    recurrence,
    days,
    deadline: pick(draft.deadline, next.deadline),
    deadlineTime: pick(draft.deadlineTime, next.deadlineTime),
    amountKind: pick(draft.amountKind, next.amountKind),
    amountMinutes: pick(draft.amountMinutes, next.amountMinutes),
    sessionCount: pick(draft.sessionCount, next.sessionCount),
    sessionMinutes: pick(draft.sessionMinutes, next.sessionMinutes),
    window: pick(draft.window, next.window),
    priority: pick(draft.priority, next.priority),
    cadence: pick(draft.cadence, next.cadence),
    timesPerWeek: pick(draft.timesPerWeek, next.timesPerWeek),
    progress: pick(draft.progress, next.progress),
    targetDate: pick(draft.targetDate, next.targetDate),
    location: pick(draft.location, next.location),
    scope: pick(draft.scope, next.scope),
    factCategory: pick(draft.factCategory, next.factCategory),
    details: pick(draft.details, next.details),
    prefs: {
      dayStart: pick(draft.prefs.dayStart, next.prefs.dayStart),
      dayEnd: pick(draft.prefs.dayEnd, next.prefs.dayEnd),
      maxSessionMinutes: pick(draft.prefs.maxSessionMinutes, next.prefs.maxSessionMinutes),
      bufferMinutes: pick(draft.prefs.bufferMinutes, next.prefs.bufferMinutes),
      protectedLabel: pick(draft.prefs.protectedLabel, next.prefs.protectedLabel),
    },
  };
}

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

/** Intents that create something new, so their title is a fresh name. */
const NAMED_TYPES: ReadonlySet<IntentType> = new Set(["create_event", "create_task", "create_habit", "create_goal", "plan_time", "save_fact"]);

/**
 * Contextual naming (see naming.ts). Only for new activities: intents that
 * point at existing records keep the title the model used to find them.
 * Goals and preference-like facts keep their dates and times ("Focus after 8pm").
 */
export function applyNaming(intent: Intent, context: NamingContext, removed: string[] = []): Intent {
  if (!NAMED_TYPES.has(intent.type) || !intent.title) return intent;
  if (intent.type === "save_fact" && intent.factCategory !== "activity" && intent.factCategory !== "interest") return intent;
  // Time for an existing task is named after that task (assess.ts).
  if (intent.type === "plan_time" && intent.targetRef) return intent;
  const named = nameActivity(intent.title, context, {
    stripWhen: intent.type !== "create_goal",
    fallback: intent.evidence,
  });
  removed.push(...named.removed);
  return named.title ? { ...intent, title: named.title } : intent;
}

export type PlannerResult = {
  /** New or completed intents, in the order the user gave them. */
  intents: Intent[];
  /** Draft ids the user cancelled or that were merged into an intent above. */
  consumedDrafts: string[];
  /** Action ids the user approved in words ("yes, add it"). "latest" = the newest card. */
  confirmed: string[];
  /** Action ids the user called off ("never mind"). */
  cancelled: string[];
  question: string | null;
  dropped: { title: string; reason: "ungrounded" | "limit" | "unknown_draft" }[];
  /** Titles whose unsupported specifics were removed (for logs). */
  retitled: { from: string; to: string | null; removed: string[] }[];
};

/**
 * Validates planner output against the user's own words and the drafts
 * still open. Short answers ("Thursday", "every week") are grounded when
 * they continue a draft: the draft keeps the original evidence.
 */
export function validatePlannerOutput(
  payload: unknown,
  input: { userText: string; drafts: Draft[]; naming?: NamingContext },
): PlannerResult {
  const wire = PlannerWireSchema.parse(payload);
  // Titles may draw on the user's words, the drafts they continue, and whatever context the caller adds.
  const naming: NamingContext = {
    sources: [input.userText, ...input.drafts.flatMap((d) => [d.intent.evidence, d.intent.title ?? ""]), ...(input.naming?.sources ?? [])],
    knownNames: input.naming?.knownNames ?? [],
  };
  const draftsById = new Map(input.drafts.map((d) => [d.id, d]));
  const result: PlannerResult = { intents: [], consumedDrafts: [], confirmed: [], cancelled: [], question: null, dropped: [], retitled: [] };
  const name = (intent: Intent): Intent => {
    const removed: string[] = [];
    const named = applyNaming(intent, naming, removed);
    if (removed.length) result.retitled.push({ from: intent.title ?? "", to: named.title, removed });
    return named;
  };

  for (const raw of wire.intents) {
    const label = clean(raw.title, 80) ?? raw.type;
    let intent = toIntent(raw);

    if (intent.type === "confirm_action") {
      // Approval in words. Grounded like anything else, so a model can't approve on its own.
      if (!isGrounded(intent.evidence, input.userText)) {
        result.dropped.push({ title: label, reason: "ungrounded" });
        continue;
      }
      const id = intent.draftId && draftsById.has(intent.draftId) ? intent.draftId : "latest";
      if (!result.confirmed.includes(id)) result.confirmed.push(id);
      continue;
    }

    if (intent.draftId) {
      const draft = draftsById.get(intent.draftId);
      if (!draft) {
        // Not a draft we know: treat as a fresh intent if it stands on its own.
        intent = { ...intent, draftId: null };
      } else {
        result.consumedDrafts.push(draft.id);
        if (intent.type === "cancel_draft") {
          result.cancelled.push(draft.id);
          continue;
        }
        // A follow-up only needs to be grounded loosely: "Thursday" is enough.
        intent = name(mergeIntent(draft.intent, intent));
        if (result.intents.length >= MAX_INTENTS) {
          result.dropped.push({ title: label, reason: "limit" });
          continue;
        }
        result.intents.push(intent);
        continue;
      }
    }

    if (intent.type === "cancel_draft") continue;
    if (!isGrounded(intent.evidence, input.userText)) {
      result.dropped.push({ title: label, reason: "ungrounded" });
      continue;
    }
    if (result.intents.length >= MAX_INTENTS) {
      result.dropped.push({ title: label, reason: "limit" });
      continue;
    }
    result.intents.push(name(intent));
  }

  result.question = clean(wire.question, 300);
  return result;
}

/** Same intent repeated in one batch (same type and title). */
export function dedupeIntents(intents: Intent[]): Intent[] {
  const seen = new Set<string>();
  return intents.filter((i) => {
    const key = `${i.type}:${normalizeText(i.title ?? "")}:${i.targetRef ?? ""}:${i.date?.isoDate ?? i.date?.weekday ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
