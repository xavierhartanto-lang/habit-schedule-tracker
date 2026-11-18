import { z } from "zod";
import type { Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";

/**
 * Settings the scheduling engine reads. Stored one row per user in
 * `scheduling_preferences`; a missing row means "use the defaults".
 */

export type TimeRange = { start: string; end: string };

export type ProtectedTime = { label: string; days: Weekday[]; start: string; end: string };

export type SchedulingPreferences = {
  /** When the engine may place new work, per weekday. [] = no new work that day. */
  workingHours: Record<Weekday, TimeRange[]>;
  /** Never place work here. end < start crosses midnight. */
  protectedTimes: ProtectedTime[];
  minSessionMinutes: number;
  maxSessionMinutes: number;
  /** Gap kept around existing events and between new sessions. */
  bufferMinutes: number;
  /** Most new work the engine adds to a single day. */
  dailyCapMinutes: number;
  /** Share of each day's free time the engine leaves open. */
  keepFreePercent: number;
};

export const LIMITS = {
  minSession: [15, 240],
  maxSession: [15, 480],
  buffer: [0, 60],
  dailyCap: [0, 720],
  keepFree: [0, 90],
  rangesPerDay: 4,
  protectedTimes: 30,
} as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" to minutes since midnight. "24:00" is allowed as an end time. */
export function timeToMinutes(time: string): number {
  if (time === "24:00") return 1440;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

const zClock = z.string().regex(HHMM, "Use a time like 15:30.");
const zEndClock = z.union([zClock, z.literal("24:00")]);

const zRange = z
  .object({ start: zClock, end: zEndClock })
  .refine((r) => timeToMinutes(r.end) > timeToMinutes(r.start), "Working hours must end after they start.");

const zDays = z
  .array(z.enum(WEEKDAYS as unknown as [Weekday, ...Weekday[]]))
  .min(1, "Pick at least one day.")
  .max(7)
  .transform((days) => WEEKDAYS.filter((d) => days.includes(d)));

const zProtected = z
  .object({
    label: z
      .string()
      .transform((v) => v.replace(/\s+/g, " ").trim())
      .refine((v) => v.length >= 1 && v.length <= 40, "Name protected time in 1 to 40 characters."),
    days: zDays,
    start: zClock,
    end: zClock,
  })
  .refine((p) => p.start !== p.end, "Protected time must have a length.");

function zInt(label: string, [min, max]: readonly [number, number]) {
  return z
    .number({ error: `${label} must be a number.` })
    .int(`${label} must be whole minutes.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);
}

const zRanges = z.array(zRange).max(LIMITS.rangesPerDay, `At most ${LIMITS.rangesPerDay} ranges per day.`);

export const schedulingPreferencesSchema = z
  .object({
    workingHours: z.object({
      mo: zRanges,
      tu: zRanges,
      we: zRanges,
      th: zRanges,
      fr: zRanges,
      sa: zRanges,
      su: zRanges,
    }),
    protectedTimes: z.array(zProtected).max(LIMITS.protectedTimes, `At most ${LIMITS.protectedTimes} protected times.`),
    minSessionMinutes: zInt("Shortest session", LIMITS.minSession),
    maxSessionMinutes: zInt("Longest session", LIMITS.maxSession),
    bufferMinutes: zInt("Buffer", LIMITS.buffer),
    dailyCapMinutes: zInt("Daily limit", LIMITS.dailyCap),
    keepFreePercent: zInt("Free time to keep", LIMITS.keepFree),
  })
  .refine((p) => p.minSessionMinutes <= p.maxSessionMinutes, "The shortest session can't be longer than the longest.");

/** Fixed defaults, used when nothing else is known. */
export const DEFAULT_SCHEDULING_PREFERENCES: SchedulingPreferences = defaultSchedulingPreferences({
  dayStartTime: "07:00",
  dayEndTime: "22:30",
});

/**
 * Defaults built from the user's day bounds (user_preferences).
 * Weekdays start after a typical school day; weekends use the full day.
 */
export function defaultSchedulingPreferences(day: { dayStartTime: string; dayEndTime: string }): SchedulingPreferences {
  const start = HHMM.test(day.dayStartTime) ? day.dayStartTime : "07:00";
  let end = HHMM.test(day.dayEndTime) ? day.dayEndTime : "22:30";
  if (timeToMinutes(end) <= timeToMinutes(start)) end = "22:30";
  // Leave the last half hour of the day for winding down.
  const workEnd = minutesToTime(Math.max(timeToMinutes(start) + 60, timeToMinutes(end) - 30));
  const afterSchool = timeToMinutes(workEnd) - timeToMinutes("15:30") >= 60 ? "15:30" : start;
  const weekday: TimeRange[] = [{ start: afterSchool, end: workEnd }];
  const weekend: TimeRange[] = [{ start: maxTime(start, "09:00", workEnd), end: workEnd }];
  return {
    workingHours: { mo: weekday, tu: weekday, we: weekday, th: weekday, fr: weekday, sa: weekend, su: weekend },
    protectedTimes: [],
    minSessionMinutes: 30,
    maxSessionMinutes: 90,
    bufferMinutes: 10,
    dailyCapMinutes: 180,
    keepFreePercent: 30,
  };
}

function maxTime(a: string, b: string, cap: string): string {
  const m = Math.max(timeToMinutes(a), timeToMinutes(b));
  return m < timeToMinutes(cap) ? minutesToTime(m) : a;
}

export function minutesToTime(minutes: number): string {
  if (minutes >= 1440) return "24:00";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
