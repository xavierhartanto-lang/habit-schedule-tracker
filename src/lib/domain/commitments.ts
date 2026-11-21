import { isLifeArea, isTimeOfDay, isUuid, normalizeContextAttributes, type ValidationResult } from "./context-items";
import { isValidTimeZone, zonedToUtc } from "@/lib/scheduling/zoned";
import { WEEKDAYS, type CommitmentKind, type DataSource, type LifeArea } from "./types";

/**
 * Pure validation for commitments created from a form or a confirmed
 * AI proposal. Mirrors the database constraints so errors are friendly.
 */

export type CommitmentInput = {
  title: string;
  area: LifeArea | null;
  /** Present only when the caller chose a life area explicitly (null = uncategorized). */
  lifeAreaId?: string | null;
  kind: CommitmentKind;
  startsAt?: string | null;
  endsAt?: string | null;
  recurrenceRule?: string | null;
  estimatedMinutes?: number | null;
  dueAt?: string | null;
  location?: string | null;
  notes?: string | null;
  source?: DataSource;
  sourceMessageId?: string | null;
};

const RRULE_RE = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+\-:]+)*$/;

/**
 * True when a row in `commitments` is a structural pillar of the user's life
 * (a class, practice, shift or standing weekly time budget) and belongs in
 * "What Whitespace knows". The same table also holds one-off calendar events,
 * Whitespace work sessions for tasks (essay steps and the like) and items the
 * AI scheduled. Those stay on the calendar and in Tasks, never in the dossier.
 */
export function isPillarCommitment(c: {
  kind: CommitmentKind;
  startsAt?: string | null;
  dueAt?: string | null;
  recurrenceRule?: string | null;
  taskId?: string | null;
  planItemId?: string | null;
}): boolean {
  if (c.taskId) return false; // a work session for a task
  if (c.recurrenceRule) return true; // repeats: class, practice, routine
  if (c.planItemId) return false; // a one-off the assistant scheduled
  if (c.kind === "flexible") return !c.dueAt && !c.startsAt; // standing time budget ("5 h of SAT prep a week")
  return false; // a one-off calendar event
}

export function isRecurrenceRule(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && RRULE_RE.test(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

export function validateCommitmentInput(raw: unknown): ValidationResult<CommitmentInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing commitment." };
  const input = raw as Record<string, unknown>;

  const title = optionalText(input.title, 200);
  if (!title) return { ok: false, error: "A title is required." };
  const hasAreaId = "lifeAreaId" in input;
  if (hasAreaId && input.lifeAreaId != null && input.lifeAreaId !== "" && !isUuid(input.lifeAreaId)) {
    return { ok: false, error: "Unknown life area." };
  }
  if (!hasAreaId && !isLifeArea(input.area)) return { ok: false, error: "Unknown life area." };
  if (hasAreaId && input.area != null && !isLifeArea(input.area)) return { ok: false, error: "Unknown life area." };
  if (input.kind !== "fixed" && input.kind !== "flexible") return { ok: false, error: "Unknown kind." };

  for (const key of ["startsAt", "endsAt", "dueAt"] as const) {
    if (input[key] != null && !isIsoDateTime(input[key])) {
      return { ok: false, error: `Invalid ${key}.` };
    }
  }
  const startsAt = (input.startsAt as string | null | undefined) ?? null;
  const endsAt = (input.endsAt as string | null | undefined) ?? null;
  if (input.kind === "fixed" && (!startsAt || !endsAt)) {
    return { ok: false, error: "Fixed commitments need a start and end time." };
  }
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return { ok: false, error: "End time must be after start time." };
  }
  if (input.recurrenceRule != null && !isRecurrenceRule(input.recurrenceRule)) {
    return { ok: false, error: "Invalid repeat rule." };
  }
  const minutes = input.estimatedMinutes;
  if (minutes != null && !(typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0)) {
    return { ok: false, error: "Estimated minutes must be a positive whole number." };
  }
  if (input.source != null && input.source !== "conversation" && input.source !== "manual") {
    return { ok: false, error: "Unknown source." };
  }
  if (input.sourceMessageId != null && !isUuid(input.sourceMessageId)) {
    return { ok: false, error: "Invalid source message." };
  }

  const value: CommitmentInput = {
      title,
      area: isLifeArea(input.area) ? input.area : null,
      kind: input.kind,
      startsAt,
      endsAt,
      recurrenceRule: (input.recurrenceRule as string | null | undefined) ?? null,
      estimatedMinutes: (minutes as number | null | undefined) ?? null,
      dueAt: (input.dueAt as string | null | undefined) ?? null,
      location: optionalText(input.location, 200),
      notes: optionalText(input.notes, 2000),
      source: (input.source as DataSource | undefined) ?? "manual",
      sourceMessageId: (input.sourceMessageId as string | null | undefined) ?? null,
  };
  if (hasAreaId) value.lifeAreaId = (input.lifeAreaId as string | null) || null;
  return { ok: true, value };
}

// ---------- Weekly schedules ----------

/**
 * Turns "Mon/Wed 4:00 to 6:00 PM" into the fields a repeating fixed
 * commitment needs: the next occurrence (from `now`, in the user's
 * timezone) and a weekly RRULE.
 *
 * Returns null when the schedule is incomplete or ambiguous (no days, no
 * times, end not after start, unknown timezone), so the caller asks the
 * user instead of guessing.
 */
export function weeklyScheduleToCommitmentTimes(
  schedule: { days: readonly string[]; startTime: string | null; endTime: string | null },
  timeZone: string,
  now: Date = new Date(),
): { startsAt: string; endsAt: string; recurrenceRule: string } | null {
  const { days } = normalizeContextAttributes({ days: schedule.days });
  const { startTime, endTime } = schedule;
  if (!days?.length || !isTimeOfDay(startTime) || !isTimeOfDay(endTime)) return null;
  if (endTime <= startTime) return null;
  if (!isValidTimeZone(timeZone)) return null;

  const todayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const todayIndex = (new Date(`${todayKey}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0

  for (let offset = 0; offset < 8; offset++) {
    const weekday = WEEKDAYS[(todayIndex + offset) % 7];
    if (!days.includes(weekday)) continue;
    const dateKey = new Date(Date.parse(`${todayKey}T00:00:00Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const start = zonedToUtc(dateKey, startTime, timeZone);
    if (start.getTime() <= now.getTime() && offset === 0) continue;
    const end = zonedToUtc(dateKey, endTime, timeZone);
    return {
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      recurrenceRule: `FREQ=WEEKLY;BYDAY=${days.map((d) => d.toUpperCase()).join(",")}`,
    };
  }
  return null;
}
