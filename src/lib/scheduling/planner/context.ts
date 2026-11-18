import type { Weekday } from "@/lib/domain/types";
import { expandEvents } from "../recurrence";
import { weekdayOfKey } from "../recurrence";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, isValidTimeZone, zonedToUtc } from "../zoned";
import {
  MINUTE,
  ceilTo,
  clipIntervals,
  mergeIntervals,
  subtractIntervals,
  totalMinutes,
  type Interval,
} from "./intervals";
import { schedulingPreferencesSchema, timeToMinutes, type SchedulingPreferences } from "./preferences";
import { SchedulingInputError, type ScheduleBase } from "./types";

/**
 * Turns raw input (events, preferences, window) into the time facts the
 * planner works with: busy blocks, protected time and each day's free
 * stretches. Everything is computed as UTC instants from local wall-clock
 * times, so daylight saving days are 23 or 25 hours long automatically.
 */

export const MAX_WINDOW_DAYS = 62;
/** Nothing is placed sooner than this after "now". */
export const LEAD_MINUTES = 15;
/** Start times snap to this grid. */
export const GRID_MINUTES = 5;

export type BusyItem = Interval & { title: string; kind: "event" | "busy" };
export type ProtectedItem = Interval & { label: string };

export type DayFrame = {
  date: string;
  weekday: Weekday;
  index: number;
  /** Working hours for the whole day (not clipped to now). */
  working: Interval[];
  /** Working hours from max(now + lead, window start) to window end. */
  usable: Interval[];
  /** usable minus busy (with buffers) minus protected time. */
  free: Interval[];
  workingMinutes: number;
  freeMinutes: number;
  /** Minutes of existing events inside working hours. */
  busyMinutes: number;
};

export type ScheduleContext = {
  timeZone: string;
  now: number;
  earliest: number;
  window: Interval;
  preferences: SchedulingPreferences;
  buffer: number;
  busy: BusyItem[];
  protectedTimes: ProtectedItem[];
  days: DayFrame[];
};

function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (typeof value !== "string" || Number.isNaN(ms)) throw new SchedulingInputError(`${label} is not a valid date and time.`);
  return ms;
}

function localTime(date: string, time: string, timeZone: string): number {
  if (time === "24:00") return zonedToUtc(addDaysToKey(date, 1), "00:00", timeZone).getTime();
  return zonedToUtc(date, time, timeZone).getTime();
}

export function buildContext(input: ScheduleBase): ScheduleContext {
  if (!isValidTimeZone(input.timeZone)) throw new SchedulingInputError("Unknown time zone.");
  const parsedPrefs = schedulingPreferencesSchema.safeParse(input.preferences);
  if (!parsedPrefs.success) {
    throw new SchedulingInputError(parsedPrefs.error.issues[0]?.message ?? "Invalid scheduling preferences.");
  }
  const preferences = parsedPrefs.data;
  const tz = input.timeZone;
  const now = parseInstant(input.now, "now");
  const window = {
    start: parseInstant(input.window?.start, "Window start"),
    end: parseInstant(input.window?.end, "Window end"),
  };
  if (window.end <= window.start) throw new SchedulingInputError("The window must end after it starts.");
  if (window.end - window.start > MAX_WINDOW_DAYS * 86_400_000) {
    throw new SchedulingInputError(`Plan at most ${MAX_WINDOW_DAYS} days at a time.`);
  }
  const buffer = preferences.bufferMinutes * MINUTE;
  const earliest = ceilTo(Math.max(now + LEAD_MINUTES * MINUTE, window.start), GRID_MINUTES);

  // Busy time: event occurrences (recurring expanded, exceptions skipped)
  // plus caller-provided blocks. All-day events mark a day, not a time.
  const pad = 2 * 86_400_000;
  const occurrences = expandEvents(input.events ?? [], new Date(window.start - pad), new Date(window.end + pad), tz);
  const busy: BusyItem[] = [];
  for (const o of occurrences) {
    if (o.allDay) continue;
    busy.push({ start: o.start.getTime(), end: o.end.getTime(), title: o.event.title, kind: "event" });
  }
  for (const b of input.busy ?? []) {
    const start = Date.parse(b.start);
    const end = Date.parse(b.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    busy.push({ start, end, title: b.title?.trim() || "Busy", kind: "busy" });
  }
  busy.sort((a, b) => a.start - b.start || a.end - b.end);

  const firstDay = dateKeyInZone(new Date(window.start), tz);
  const lastDay = dateKeyInZone(new Date(window.end - 1), tz);
  const dayCount = daysBetweenKeys(firstDay, lastDay) + 1;

  // Protected time, including stretches that start the evening before
  // the window and cross midnight.
  const protectedTimes: ProtectedItem[] = [];
  for (let i = -1; i < dayCount; i++) {
    const date = addDaysToKey(firstDay, i);
    const wd = weekdayOfKey(date);
    for (const p of preferences.protectedTimes) {
      if (!p.days.includes(wd)) continue;
      const crosses = timeToMinutes(p.end) <= timeToMinutes(p.start);
      const start = localTime(date, p.start, tz);
      const end = localTime(crosses ? addDaysToKey(date, 1) : date, p.end, tz);
      if (end > start) protectedTimes.push({ start, end, label: p.label });
    }
  }
  protectedTimes.sort((a, b) => a.start - b.start);

  const blocked = [
    ...busy.map((b) => ({ start: b.start - buffer, end: b.end + buffer })),
    ...protectedTimes,
  ];
  const usableClip = { start: earliest, end: window.end };

  const days: DayFrame[] = [];
  for (let i = 0; i < dayCount; i++) {
    const date = addDaysToKey(firstDay, i);
    const weekday = weekdayOfKey(date);
    const working = mergeIntervals(
      preferences.workingHours[weekday].map((r) => ({ start: localTime(date, r.start, tz), end: localTime(date, r.end, tz) })),
    );
    const usable = clipIntervals(working, usableClip);
    const free = subtractIntervals(usable, blocked);
    days.push({
      date,
      weekday,
      index: i,
      working,
      usable,
      free,
      workingMinutes: totalMinutes(working),
      freeMinutes: totalMinutes(free),
      busyMinutes: totalMinutes(working.flatMap((w) => clipIntervals(busy, w))),
    });
  }

  return { timeZone: tz, now, earliest, window, preferences, buffer, busy, protectedTimes, days };
}
