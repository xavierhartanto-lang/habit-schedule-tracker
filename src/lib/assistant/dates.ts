import type { Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";
import { addDaysToKey, isDateKey, isoWeekdayOfKey, startOfWeekKey } from "@/lib/scheduling/zoned";

/**
 * Deterministic resolution of the date references the planner model
 * returns. The model never does date arithmetic: it says *which* day the
 * user meant ("weekday fr, next week"), and this module turns that into a
 * local YYYY-MM-DD in the user's time zone. Pure, unit tested.
 *
 * Conventions (documented for the user in the report):
 *   "Friday" / "this Friday" = the next Friday from today (today counts).
 *   "next Friday"            = Friday of next week (week starts Monday).
 *   "tomorrow"               = day_offset 1.
 */

export type DateRef = {
  /** Explicit calendar date the user gave ("Nov 21", "12/3"), as YYYY-MM-DD. */
  isoDate: string | null;
  weekday: Weekday | null;
  /** "this" or "next" week qualifier for a weekday. */
  week: "this" | "next" | null;
  /** Days from today: 0 today, 1 tomorrow. */
  dayOffset: number | null;
};

export const EMPTY_DATE_REF: DateRef = { isoDate: null, weekday: null, week: null, dayOffset: null };

export function hasDateRef(ref: DateRef | null | undefined): ref is DateRef {
  return !!ref && (ref.isoDate !== null || ref.weekday !== null || ref.dayOffset !== null);
}

/**
 * Resolves a reference relative to `todayKey` (the user's local today).
 * Returns null when there is nothing to resolve or it is malformed.
 */
export function resolveDateRef(ref: DateRef | null | undefined, todayKey: string, weekStartsOn: 0 | 1 = 1): string | null {
  if (!ref) return null;
  if (ref.isoDate) return isDateKey(ref.isoDate) ? ref.isoDate : null;
  if (ref.dayOffset !== null) {
    if (!Number.isInteger(ref.dayOffset) || ref.dayOffset < -7 || ref.dayOffset > 366) return null;
    return addDaysToKey(todayKey, ref.dayOffset);
  }
  if (!ref.weekday) return null;
  const target = WEEKDAYS.indexOf(ref.weekday) + 1; // ISO 1..7
  if (ref.week === "next") {
    const nextWeekStart = addDaysToKey(startOfWeekKey(todayKey, weekStartsOn), 7);
    for (let i = 0; i < 7; i++) {
      const key = addDaysToKey(nextWeekStart, i);
      if (isoWeekdayOfKey(key) === target) return key;
    }
    return null;
  }
  // Plain or "this": the next occurrence, today included.
  for (let i = 0; i < 7; i++) {
    const key = addDaysToKey(todayKey, i);
    if (isoWeekdayOfKey(key) === target) return key;
  }
  return null;
}

/** First date on or after `fromKey` that falls on one of `days`. */
export function firstMatchingDay(fromKey: string, days: readonly Weekday[]): string | null {
  if (!days.length) return null;
  for (let i = 0; i < 7; i++) {
    const key = addDaysToKey(fromKey, i);
    if (days.includes(WEEKDAYS[isoWeekdayOfKey(key) - 1])) return key;
  }
  return null;
}

export function weekdayOf(key: string): Weekday {
  return WEEKDAYS[isoWeekdayOfKey(key) - 1];
}

const LONG_DAY: Record<Weekday, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

export function weekdayName(day: Weekday): string {
  return LONG_DAY[day];
}

/** "Thu, Nov 20" for a date key, without time zone shifts. */
export function shortDate(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "6 PM", "6:30 PM" for "HH:MM". */
export function clockLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "AM" : "PM";
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Adds minutes to "HH:MM". Returns null when it crosses midnight. */
export function addMinutesToTime(time: string, minutes: number): string | null {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  if (total >= 24 * 60 || total < 0) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function minutesBetweenTimes(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

/** Fourteen days starting today, "Thu 2026-11-19", for the planner prompt. */
export function calendarTable(todayKey: string, days = 14): string {
  return Array.from({ length: days }, (_, i) => {
    const key = addDaysToKey(todayKey, i);
    return `${LONG_DAY[weekdayOf(key)].slice(0, 3)} ${key}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`;
  }).join("\n");
}
