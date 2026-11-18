import { z } from "zod";

import type { LifeArea } from "@/lib/domain/types";

/**
 * Structured extraction: the contract between the AI layer (Chunk B),
 * the data layer (Chunk A) and the conversation UI (Chunk C).
 *
 * Flow
 *   1. The model returns `ExtractionWireSchema` through structured outputs.
 *   2. `validateExtraction` turns that into `ExtractionResult`: typed items,
 *      clarifying questions, and a list of what was dropped and why.
 *   3. The UI shows items as proposals. Nothing is written until the user saves.
 *
 * Nothing here talks to the network or the database, so it is unit tested.
 */

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const LIFE_AREA_VALUES = [
  "academics",
  "extracurricular",
  "athletics",
  "creative",
  "personal",
  "rest",
] as const satisfies readonly LifeArea[];

/**
 * commitment -> `commitments` table (fixed or flexible, weekly schedule).
 * goal       -> `goals` table.
 * activity / interest / routine / working_time / preference -> `context_items` table.
 *   working_time = when they like to work ("I focus best after 8pm").
 *   preference   = how they like their schedule ("keep Sundays free").
 */
export const CONTEXT_CATEGORY_VALUES = [
  "commitment",
  "goal",
  "activity",
  "interest",
  "routine",
  "working_time",
  "preference",
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORY_VALUES)[number];

/** Categories stored in the generic `context_items` table. */
export type ContextItemCategory = Exclude<ContextCategory, "commitment" | "goal">;

export const WEEKDAY_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAY_VALUES)[number];

export const GOAL_HORIZON_VALUES = ["short_term", "long_term"] as const;
export type GoalHorizon = (typeof GOAL_HORIZON_VALUES)[number];

// ---------------------------------------------------------------------------
// Wire schema: what the model is asked to produce.
// Kept flat and loose (plain strings) so it compiles to a structured-output
// JSON schema. Strict checks happen in validateExtraction.
// ---------------------------------------------------------------------------

const WireSchedule = z.object({
  days: z.array(z.enum(WEEKDAY_VALUES)).describe("Days it happens. Empty if the user did not say."),
  start_time: z.string().nullable().describe('24h "HH:MM", or null if not stated.'),
  end_time: z.string().nullable().describe('24h "HH:MM", or null if not stated.'),
});

const WireItem = z.object({
  category: z.enum(CONTEXT_CATEGORY_VALUES),
  title: z.string().describe("Short name in the user's terms, e.g. 'Debate practice'."),
  area: z.enum(LIFE_AREA_VALUES),
  evidence: z
    .string()
    .describe("The exact words from the user's message that state this. Copied verbatim."),
  details: z.string().nullable().describe("One short sentence of extra specifics the user gave, or null."),
  schedule: WireSchedule.nullable().describe(
    "For commitments, routines and working times. Null if no timing was given.",
  ),
  commitment_kind: z
    .enum(["fixed", "flexible"])
    .nullable()
    .describe("Commitments only. fixed = set time; flexible = needs time but can move."),
  location: z.string().nullable(),
  goal_horizon: z.enum(GOAL_HORIZON_VALUES).nullable().describe("Goals only."),
  target_date: z.string().nullable().describe('Goals only. "YYYY-MM-DD" if the user gave a date.'),
  supersedes: z
    .string()
    .nullable()
    .describe("Exact title of an already-known fact this replaces or corrects, else null."),
});

const WireClarification = z.object({
  question: z.string().describe("One short question to resolve something ambiguous."),
  about: z.string().describe("What it is about, e.g. 'Robotics club meeting time'."),
});

export const ExtractionWireSchema = z.object({
  items: z.array(WireItem),
  clarifications: z.array(WireClarification),
});
export type ExtractionWire = z.infer<typeof ExtractionWireSchema>;
export type WireItem = z.infer<typeof WireItem>;

// ---------------------------------------------------------------------------
// Validated domain types (what Chunks A and C consume)
// ---------------------------------------------------------------------------

export type ExtractedSchedule = {
  days: Weekday[];
  /** "HH:MM" 24h or null when the user did not say. Never guessed. */
  startTime: string | null;
  endTime: string | null;
};

type ExtractedBase = {
  title: string;
  area: LifeArea;
  /** Verbatim quote from the user that supports this item. */
  evidence: string;
  details: string | null;
  /** Title of a known fact this updates, if any. */
  supersedes: string | null;
};

export type ExtractedCommitment = ExtractedBase & {
  category: "commitment";
  kind: "fixed" | "flexible";
  schedule: ExtractedSchedule | null;
  location: string | null;
};

export type ExtractedGoal = ExtractedBase & {
  category: "goal";
  horizon: GoalHorizon | null;
  /** "YYYY-MM-DD" or null. */
  targetDate: string | null;
};

export type ExtractedContextItem = ExtractedBase & {
  category: ContextItemCategory;
  schedule: ExtractedSchedule | null;
};

export type ExtractedItem = ExtractedCommitment | ExtractedGoal | ExtractedContextItem;

export type Clarification = { question: string; about: string };

export type DropReason =
  | "ungrounded" // evidence is not in the user's words
  | "invalid" // malformed field (time, date, empty title)
  | "duplicate" // already known, or repeated in this batch
  | "limit"; // over MAX_ITEMS

export type ExtractionResult = {
  items: ExtractedItem[];
  clarifications: Clarification[];
  dropped: { title: string; reason: DropReason; detail?: string }[];
};

/** A fact Whitespace already has, used to skip duplicates. */
export type KnownFactRef = { category: ContextCategory; title: string };

export const MAX_ITEMS = 20;
export const MAX_CLARIFICATIONS = 3;
const MAX_TITLE = 120;
const MAX_TEXT = 500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize text for grounding and duplicate checks. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}:'\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `evidence` appears in the user's own words. */
export function isGrounded(evidence: string, userText: string): boolean {
  const e = normalizeText(evidence);
  if (e.length < 3) return false;
  return normalizeText(userText).includes(e);
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function clean(value: string | null | undefined, max = MAX_TEXT): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

type ScheduleCheck = { ok: true; value: ExtractedSchedule | null } | { ok: false; detail: string };

function validateSchedule(raw: WireItem["schedule"]): ScheduleCheck {
  if (!raw) return { ok: true, value: null };
  const days = WEEKDAY_VALUES.filter((d) => raw.days.includes(d)); // dedupe + canonical order
  const start = clean(raw.start_time);
  const end = clean(raw.end_time);
  if (start && !isValidTime(start)) return { ok: false, detail: `bad start_time "${start}"` };
  if (end && !isValidTime(end)) return { ok: false, detail: `bad end_time "${end}"` };
  if (start && end && end <= start) return { ok: false, detail: "end_time is not after start_time" };
  if (days.length === 0 && !start && !end) return { ok: true, value: null };
  return { ok: true, value: { days, startTime: start, endTime: end } };
}

function toItem(raw: WireItem): { ok: true; item: ExtractedItem } | { ok: false; detail: string } {
  const title = clean(raw.title, MAX_TITLE);
  if (!title) return { ok: false, detail: "empty title" };
  const evidence = clean(raw.evidence) ?? "";
  const base: ExtractedBase = {
    title,
    area: raw.area,
    evidence,
    details: clean(raw.details),
    supersedes: clean(raw.supersedes, MAX_TITLE),
  };

  if (raw.category === "goal") {
    const target = clean(raw.target_date);
    if (target && !isValidIsoDate(target)) return { ok: false, detail: `bad target_date "${target}"` };
    return {
      ok: true,
      item: { ...base, category: "goal", horizon: raw.goal_horizon ?? null, targetDate: target },
    };
  }

  const schedule = validateSchedule(raw.schedule);
  if (!schedule.ok) return schedule;

  if (raw.category === "commitment") {
    // Keep the model's label. Without one, a stated start time means fixed.
    // A fixed commitment may still have unknown times: those stay null and the
    // model is told to ask a clarifying question rather than guess.
    const kind = raw.commitment_kind ?? (schedule.value?.startTime ? "fixed" : "flexible");
    return {
      ok: true,
      item: {
        ...base,
        category: "commitment",
        kind,
        schedule: schedule.value,
        location: clean(raw.location, MAX_TITLE),
      },
    };
  }

  return { ok: true, item: { ...base, category: raw.category, schedule: schedule.value } };
}

/**
 * Validate model output before anything can be saved.
 *
 * - Re-parses the wire shape (never trust the provider blindly).
 * - Drops any item whose evidence is not in the user's own words.
 * - Drops malformed times/dates instead of guessing.
 * - Drops items already known (unless they update one) and in-batch repeats.
 * - `supersedes` must name a known fact, otherwise it is cleared.
 *
 * Throws only if the payload is not the expected shape at all; the caller
 * maps that to AiError("invalid_output").
 */
export function validateExtraction(
  payload: unknown,
  input: { userText: string; known: KnownFactRef[] },
): ExtractionResult {
  const wire = ExtractionWireSchema.parse(payload);

  const knownByTitle = new Map<string, KnownFactRef>();
  for (const fact of input.known) knownByTitle.set(normalizeText(fact.title), fact);

  const result: ExtractionResult = { items: [], clarifications: [], dropped: [] };
  const seen = new Set<string>();

  for (const raw of wire.items) {
    const label = clean(raw.title, MAX_TITLE) ?? "(untitled)";

    if (!isGrounded(raw.evidence, input.userText)) {
      result.dropped.push({ title: label, reason: "ungrounded" });
      continue;
    }

    const parsed = toItem(raw);
    if (!parsed.ok) {
      result.dropped.push({ title: label, reason: "invalid", detail: parsed.detail });
      continue;
    }
    const item = parsed.item;

    if (item.supersedes && !knownByTitle.has(normalizeText(item.supersedes))) {
      item.supersedes = null;
    }

    const key = `${item.category}:${normalizeText(item.title)}`;
    const known = knownByTitle.get(normalizeText(item.title));
    if (seen.has(key) || (known && known.category === item.category && !item.supersedes)) {
      result.dropped.push({ title: label, reason: "duplicate" });
      continue;
    }

    if (result.items.length >= MAX_ITEMS) {
      result.dropped.push({ title: label, reason: "limit" });
      continue;
    }

    seen.add(key);
    result.items.push(item);
  }

  for (const raw of wire.clarifications) {
    const question = clean(raw.question, 300);
    if (!question || result.clarifications.length >= MAX_CLARIFICATIONS) continue;
    result.clarifications.push({ question, about: clean(raw.about, MAX_TITLE) ?? "" });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers for the data layer
// ---------------------------------------------------------------------------

const RRULE_DAY: Record<Weekday, string> = {
  mon: "MO",
  tue: "TU",
  wed: "WE",
  thu: "TH",
  fri: "FR",
  sat: "SA",
  sun: "SU",
};

/** Weekly schedule -> RRULE for `commitments.recurrence`. Null when no days. */
export function scheduleToRRule(schedule: ExtractedSchedule | null): string | null {
  if (!schedule || schedule.days.length === 0) return null;
  return `FREQ=WEEKLY;BYDAY=${schedule.days.map((d) => RRULE_DAY[d]).join(",")}`;
}
