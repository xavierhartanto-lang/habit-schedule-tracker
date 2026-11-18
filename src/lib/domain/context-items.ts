import { LIFE_AREA_ORDER } from "./life-areas";
import {
  CONTEXT_CATEGORIES,
  WEEKDAYS,
  type ContextAttributes,
  type ContextCategory,
  type DataSource,
  type LifeArea,
  type Weekday,
} from "./types";

/**
 * Pure validation for context items. This is the last check before a fact
 * reaches the database, whether it came from a form or from the AI.
 * It never invents values: anything missing or malformed is dropped or rejected.
 */

export const CONTEXT_TITLE_MAX = 200;
export const CONTEXT_DETAILS_MAX = 1000;

export type ContextItemInput = {
  category: ContextCategory;
  title: string;
  details?: string | null;
  area?: LifeArea | null;
  attributes?: ContextAttributes;
  source?: DataSource;
  sourceMessageId?: string | null;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isContextCategory(value: unknown): value is ContextCategory {
  return typeof value === "string" && (CONTEXT_CATEGORIES as readonly string[]).includes(value);
}

export function isLifeArea(value: unknown): value is LifeArea {
  return typeof value === "string" && (LIFE_AREA_ORDER as readonly string[]).includes(value);
}

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === "string" && (WEEKDAYS as readonly string[]).includes(value);
}

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function wholeNumberIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Keeps only well-formed attribute fields. Unknown keys are discarded,
 * days are de-duplicated and ordered Monday first.
 */
export function normalizeContextAttributes(raw: unknown): ContextAttributes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: ContextAttributes = {};

  if (Array.isArray(input.days)) {
    // Accept "mo" or "mon" / "monday", any case.
    const given = new Set(
      (input.days as unknown[])
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim().toLowerCase().slice(0, 2)),
    );
    const days = WEEKDAYS.filter((d) => given.has(d));
    if (days.length) out.days = days;
  }
  if (isTimeOfDay(input.startTime)) out.startTime = input.startTime;
  if (isTimeOfDay(input.endTime)) out.endTime = input.endTime;

  const timesPerWeek = wholeNumberIn(input.timesPerWeek, 1, 21);
  if (timesPerWeek !== undefined) out.timesPerWeek = timesPerWeek;
  const durationMinutes = wholeNumberIn(input.durationMinutes, 1, 24 * 60);
  if (durationMinutes !== undefined) out.durationMinutes = durationMinutes;

  return out;
}

/** Validates and cleans a new or replacement context item. */
export function validateContextItemInput(raw: unknown): ValidationResult<ContextItemInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing item." };
  const input = raw as Record<string, unknown>;

  if (!isContextCategory(input.category)) return { ok: false, error: "Unknown category." };
  const title = cleanText(input.title, CONTEXT_TITLE_MAX);
  if (!title) return { ok: false, error: "A title is required." };
  if (input.area != null && !isLifeArea(input.area)) return { ok: false, error: "Unknown life area." };
  if (input.source != null && input.source !== "conversation" && input.source !== "manual") {
    return { ok: false, error: "Unknown source." };
  }
  if (input.sourceMessageId != null && !isUuid(input.sourceMessageId)) {
    return { ok: false, error: "Invalid source message." };
  }

  return {
    ok: true,
    value: {
      category: input.category,
      title,
      details: cleanText(input.details, CONTEXT_DETAILS_MAX),
      area: (input.area as LifeArea | null | undefined) ?? null,
      attributes: normalizeContextAttributes(input.attributes),
      source: (input.source as DataSource | undefined) ?? "manual",
      sourceMessageId: (input.sourceMessageId as string | null | undefined) ?? null,
    },
  };
}

/** Same rules for a partial update. Only provided fields are checked and returned. */
export function validateContextItemPatch(
  raw: unknown,
): ValidationResult<Partial<Omit<ContextItemInput, "source" | "sourceMessageId">>> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing changes." };
  const input = raw as Record<string, unknown>;
  const out: Partial<Omit<ContextItemInput, "source" | "sourceMessageId">> = {};

  if ("category" in input) {
    if (!isContextCategory(input.category)) return { ok: false, error: "Unknown category." };
    out.category = input.category;
  }
  if ("title" in input) {
    const title = cleanText(input.title, CONTEXT_TITLE_MAX);
    if (!title) return { ok: false, error: "A title is required." };
    out.title = title;
  }
  if ("details" in input) out.details = cleanText(input.details, CONTEXT_DETAILS_MAX);
  if ("area" in input) {
    if (input.area != null && !isLifeArea(input.area)) return { ok: false, error: "Unknown life area." };
    out.area = (input.area as LifeArea | null) ?? null;
  }
  if ("attributes" in input) out.attributes = normalizeContextAttributes(input.attributes);

  return { ok: true, value: out };
}
