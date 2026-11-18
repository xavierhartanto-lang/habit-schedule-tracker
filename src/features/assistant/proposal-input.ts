import {
  GOAL_HORIZON_VALUES,
  LIFE_AREA_VALUES,
  WEEKDAY_VALUES,
  isValidIsoDate,
  isValidTime,
  type ExtractedItem,
  type ExtractedSchedule,
  type GoalHorizon,
  type Weekday,
} from "@/lib/ai/extraction";
import { weeklyScheduleToCommitmentTimes } from "@/lib/domain/commitments";
import type { ContextAttributes, LifeArea, Weekday as DayKey } from "@/lib/domain/types";

/**
 * Pure mapping from a confirmed proposal (plus the user's edits) to the
 * record the data layer saves. No I/O, so it is unit tested.
 *
 * Nothing here fills gaps with guesses. A fixed commitment without days and
 * times cannot be saved until the user adds them.
 */

/** What the user can change on a proposal card before saving. All optional. */
export type ProposalEdit = {
  title?: string;
  area?: LifeArea;
  details?: string | null;
  days?: Weekday[];
  startTime?: string | null;
  endTime?: string | null;
  kind?: "fixed" | "flexible";
  horizon?: GoalHorizon | null;
  targetDate?: string | null;
};

export type EditResult = { ok: true; item: ExtractedItem } | { ok: false; error: string };

const TITLE_MAX = 120;
const DETAILS_MAX = 500;

function cleanText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function hasSchedule(item: ExtractedItem): item is Extract<ExtractedItem, { schedule: ExtractedSchedule | null }> {
  return item.category !== "goal";
}

/** Applies and validates the user's edits. The evidence quote never changes. */
export function applyProposalEdit(item: ExtractedItem, edit: ProposalEdit | null | undefined): EditResult {
  if (!edit) return { ok: true, item };

  const title = edit.title !== undefined ? cleanText(edit.title, TITLE_MAX) : item.title;
  if (!title) return { ok: false, error: "Add a name." };
  if (edit.area !== undefined && !(LIFE_AREA_VALUES as readonly string[]).includes(edit.area)) {
    return { ok: false, error: "Pick a life area." };
  }
  const base = {
    ...item,
    title,
    area: edit.area ?? item.area,
    details: edit.details !== undefined ? cleanText(edit.details, DETAILS_MAX) : item.details,
  };

  if (base.category === "goal") {
    const horizon = edit.horizon !== undefined ? edit.horizon : base.horizon;
    if (horizon != null && !(GOAL_HORIZON_VALUES as readonly string[]).includes(horizon)) {
      return { ok: false, error: "Pick short or long term." };
    }
    const targetDate = edit.targetDate !== undefined ? cleanText(edit.targetDate, 10) : base.targetDate;
    if (targetDate && !isValidIsoDate(targetDate)) return { ok: false, error: "Use a real date." };
    return { ok: true, item: { ...base, horizon, targetDate } };
  }

  if (!hasSchedule(base)) return { ok: true, item: base };

  const touched = edit.days !== undefined || edit.startTime !== undefined || edit.endTime !== undefined;
  let schedule = base.schedule;
  if (touched) {
    const days = edit.days ?? schedule?.days ?? [];
    if (!days.every((d) => (WEEKDAY_VALUES as readonly string[]).includes(d))) {
      return { ok: false, error: "Pick valid days." };
    }
    const start = edit.startTime !== undefined ? cleanText(edit.startTime, 5) : (schedule?.startTime ?? null);
    const end = edit.endTime !== undefined ? cleanText(edit.endTime, 5) : (schedule?.endTime ?? null);
    if (start && !isValidTime(start)) return { ok: false, error: "Start time looks wrong." };
    if (end && !isValidTime(end)) return { ok: false, error: "End time looks wrong." };
    if (start && end && end <= start) return { ok: false, error: "End time must be after the start." };
    const ordered = WEEKDAY_VALUES.filter((d) => days.includes(d));
    schedule = ordered.length || start || end ? { days: ordered, startTime: start, endTime: end } : null;
  }

  if (base.category === "commitment") {
    const kind = edit.kind ?? base.kind;
    if (kind !== "fixed" && kind !== "flexible") return { ok: false, error: "Pick fixed or flexible." };
    return { ok: true, item: { ...base, kind, schedule } };
  }
  return { ok: true, item: { ...base, schedule } };
}

/** True when a fixed commitment still needs days and times before it can be saved. */
export function needsSchedule(item: ExtractedItem): boolean {
  if (item.category !== "commitment" || item.kind !== "fixed") return false;
  const s = item.schedule;
  return !s || s.days.length === 0 || !s.startTime || !s.endTime;
}

export type ProposalWrite =
  | { table: "commitments"; input: Record<string, unknown> }
  | { table: "goals"; input: Record<string, unknown> }
  | { table: "context_items"; input: Record<string, unknown> };

/**
 * The record to save for a confirmed proposal, with provenance
 * (source = conversation, the user message it came from).
 */
export function proposalToWrite(
  item: ExtractedItem,
  options: { timezone: string; sourceMessageId: string; now?: Date },
): { ok: true; write: ProposalWrite } | { ok: false; error: string } {
  const provenance = { source: "conversation" as const, sourceMessageId: options.sourceMessageId };

  if (item.category === "goal") {
    return {
      ok: true,
      write: {
        table: "goals",
        input: {
          title: item.title,
          area: item.area,
          description: item.details,
          targetDate: item.targetDate,
          horizon: item.horizon,
          ...provenance,
        },
      },
    };
  }

  if (item.category === "commitment") {
    const notes = item.details;
    if (item.kind === "flexible") {
      return {
        ok: true,
        write: {
          table: "commitments",
          input: { title: item.title, area: item.area, kind: "flexible", location: item.location, notes, ...provenance },
        },
      };
    }
    if (needsSchedule(item)) return { ok: false, error: "Add the days and times first." };
    const times = weeklyScheduleToCommitmentTimes(item.schedule!, options.timezone, options.now);
    if (!times) return { ok: false, error: "Those days and times don't line up. Check them and try again." };
    return {
      ok: true,
      write: {
        table: "commitments",
        input: {
          title: item.title,
          area: item.area,
          kind: "fixed",
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          recurrenceRule: times.recurrenceRule,
          location: item.location,
          notes,
          ...provenance,
        },
      },
    };
  }

  const attributes: ContextAttributes = {};
  if (item.schedule) {
    if (item.schedule.days.length) attributes.days = item.schedule.days.map((d) => d.slice(0, 2) as DayKey);
    if (item.schedule.startTime) attributes.startTime = item.schedule.startTime;
    if (item.schedule.endTime) attributes.endTime = item.schedule.endTime;
  }
  return {
    ok: true,
    write: {
      table: "context_items",
      input: {
        category: item.category,
        title: item.title,
        details: item.details,
        area: item.area,
        attributes,
        ...provenance,
      },
    },
  };
}

const DAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Mon, Wed · 3:30 PM to 5 PM". Empty string when nothing is known. */
export function describeSchedule(schedule: ExtractedSchedule | null): string {
  if (!schedule) return "";
  const days =
    schedule.days.length === 7
      ? "Every day"
      : schedule.days.length === 5 && !schedule.days.includes("sat") && !schedule.days.includes("sun")
        ? "Weekdays"
        : schedule.days.map((d) => DAY_SHORT[d]).join(", ");
  const time =
    schedule.startTime && schedule.endTime
      ? `${formatTime(schedule.startTime)} to ${formatTime(schedule.endTime)}`
      : schedule.startTime
        ? `from ${formatTime(schedule.startTime)}`
        : schedule.endTime
          ? `until ${formatTime(schedule.endTime)}`
          : "";
  return [days, time].filter(Boolean).join(" · ");
}

export { DAY_SHORT };
