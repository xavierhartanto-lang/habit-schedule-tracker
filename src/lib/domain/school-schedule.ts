import { z } from "zod";
import { weeklyScheduleToCommitmentTimes } from "./commitments";
import { WEEKDAYS, type Weekday } from "./types";

/**
 * A school bell schedule: one or more day types (Regular, Late start,
 * Block day), each with its own periods. Pure: no database, no LLM.
 *
 * Saving turns each day type into one repeating fixed "School" event
 * (first bell to last bell), which the scheduler treats as busy time.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const PERIOD_KINDS = ["class", "lunch", "break"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const MAX_PERIODS = 14;
export const MAX_DAY_TYPES = 5;

const periodSchema = z.object({
  label: z.string().trim().min(1, "Every period needs a name.").max(40),
  start: z.string().regex(HHMM, "Use times like 08:00."),
  end: z.string().regex(HHMM, "Use times like 08:50."),
  kind: z.enum(PERIOD_KINDS),
});

const dayTypeSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1, "Give each schedule a name.").max(40),
  days: z.array(z.enum(WEEKDAYS as [Weekday, ...Weekday[]])).max(7),
  periods: z.array(periodSchema).min(1, "Add at least one period.").max(MAX_PERIODS, `At most ${MAX_PERIODS} periods a day.`),
});

export const bellScheduleSchema = z
  .object({
    rotation: z.enum(["same", "ab"]),
    dayTypes: z.array(dayTypeSchema).min(1).max(MAX_DAY_TYPES),
    source: z.enum(["lookup", "manual"]),
    sourceUrls: z.array(z.string().url().max(500)).max(5).default([]),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<Weekday>();
    let anyDay = false;
    for (const dt of s.dayTypes) {
      for (const d of dt.days) {
        if (seen.has(d)) {
          ctx.addIssue({ code: "custom", message: `${WEEKDAY_NAMES[d]} is in two schedules. Pick one.` });
          return;
        }
        seen.add(d);
        anyDay = true;
      }
      for (const p of dt.periods) {
        if (toMinutes(p.end) <= toMinutes(p.start)) {
          ctx.addIssue({ code: "custom", message: `${p.label} ends before it starts.` });
          return;
        }
      }
      const sorted = sortPeriods(dt.periods);
      for (let i = 1; i < sorted.length; i++) {
        if (toMinutes(sorted[i].start) < toMinutes(sorted[i - 1].end)) {
          ctx.addIssue({ code: "custom", message: `${sorted[i - 1].label} and ${sorted[i].label} overlap.` });
          return;
        }
      }
    }
    if (!anyDay) ctx.addIssue({ code: "custom", message: "Pick the days you have school." });
  });

export type BellPeriod = z.infer<typeof periodSchema>;
export type BellDayType = z.infer<typeof dayTypeSchema>;
export type BellSchedule = z.infer<typeof bellScheduleSchema>;

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mo: "Mon",
  tu: "Tue",
  we: "Wed",
  th: "Thu",
  fr: "Fri",
  sa: "Sat",
  su: "Sun",
};

// ---------- Time helpers ----------

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "08:05" -> "8:05 AM". */
export function formatClock(hhmm: string): string {
  if (!HHMM.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function sortPeriods(periods: readonly BellPeriod[]): BellPeriod[] {
  return [...periods].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

// ---------- Quick setup ----------

/** The few numbers most students know; generates exact periods. */
export type QuickSetup = {
  firstBell: string;
  classes: number;
  classMinutes: number;
  passingMinutes: number;
  /** Lunch comes after this class. 0 = no lunch. */
  lunchAfter: number;
  lunchMinutes: number;
};

export const DEFAULT_QUICK: QuickSetup = {
  firstBell: "08:00",
  classes: 6,
  classMinutes: 55,
  passingMinutes: 5,
  lunchAfter: 3,
  lunchMinutes: 35,
};

export const LATE_START_QUICK: QuickSetup = { ...DEFAULT_QUICK, firstBell: "09:30", classMinutes: 40 };

export function generatePeriods(q: QuickSetup): BellPeriod[] {
  const classes = clamp(Math.round(q.classes), 1, MAX_PERIODS - 1);
  const classMinutes = clamp(Math.round(q.classMinutes), 10, 240);
  const passing = clamp(Math.round(q.passingMinutes), 0, 30);
  const lunchMinutes = clamp(Math.round(q.lunchMinutes), 10, 120);
  const lunchAfter = clamp(Math.round(q.lunchAfter), 0, classes);

  const out: BellPeriod[] = [];
  let t = HHMM.test(q.firstBell) ? toMinutes(q.firstBell) : toMinutes(DEFAULT_QUICK.firstBell);
  const dayEnd = 23 * 60 + 59;
  for (let i = 1; i <= classes; i++) {
    if (t + classMinutes > dayEnd) break;
    out.push({ label: `Period ${i}`, start: fromMinutes(t), end: fromMinutes(t + classMinutes), kind: "class" });
    t += classMinutes + passing;
    if (i === lunchAfter && t + lunchMinutes <= dayEnd) {
      out.push({ label: "Lunch", start: fromMinutes(t), end: fromMinutes(t + lunchMinutes), kind: "lunch" });
      t += lunchMinutes + passing;
    }
  }
  return out;
}

/** Best guess at the quick numbers behind a list of periods (e.g. a looked-up schedule). */
export function deriveQuick(periods: readonly BellPeriod[]): QuickSetup {
  const sorted = sortPeriods(periods);
  if (!sorted.length) return DEFAULT_QUICK;
  const classes = sorted.filter((p) => p.kind === "class");
  const lengths = classes.map((p) => toMinutes(p.end) - toMinutes(p.start));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(toMinutes(sorted[i].start) - toMinutes(sorted[i - 1].end));
  const lunchIndex = sorted.findIndex((p) => p.kind === "lunch");
  const lunch = lunchIndex >= 0 ? sorted[lunchIndex] : null;
  return {
    firstBell: sorted[0].start,
    classes: Math.max(1, classes.length),
    classMinutes: mode(lengths) ?? DEFAULT_QUICK.classMinutes,
    passingMinutes: clamp(mode(gaps.filter((g) => g >= 0)) ?? DEFAULT_QUICK.passingMinutes, 0, 30),
    lunchAfter: lunch ? sorted.slice(0, lunchIndex).filter((p) => p.kind === "class").length : 0,
    lunchMinutes: lunch ? toMinutes(lunch.end) - toMinutes(lunch.start) : DEFAULT_QUICK.lunchMinutes,
  };
}

/** True when the periods are exactly what the quick numbers would generate. */
export function matchesQuick(periods: readonly BellPeriod[], q: QuickSetup): boolean {
  const generated = generatePeriods(q);
  const sorted = sortPeriods(periods);
  return (
    generated.length === sorted.length &&
    generated.every((g, i) => g.start === sorted[i].start && g.end === sorted[i].end && g.kind === sorted[i].kind)
  );
}

// ---------- Defaults ----------

export function newDayTypeId(): string {
  return `dt_${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultBellSchedule(): BellSchedule {
  return {
    rotation: "same",
    source: "manual",
    sourceUrls: [],
    dayTypes: [{ id: "regular", label: "Regular day", days: ["mo", "tu", "we", "th", "fr"], periods: generatePeriods(DEFAULT_QUICK) }],
  };
}

// ---------- Summaries ----------

export function schoolHours(dt: Pick<BellDayType, "periods">): { start: string; end: string } | null {
  const sorted = sortPeriods(dt.periods);
  if (!sorted.length) return null;
  return { start: sorted[0].start, end: sorted.reduce((max, p) => (toMinutes(p.end) > toMinutes(max) ? p.end : max), sorted[0].end) };
}

export function formatDays(days: readonly Weekday[]): string {
  const ordered = WEEKDAYS.filter((d) => days.includes(d));
  if (!ordered.length) return "No days";
  if (ordered.join() === "mo,tu,we,th,fr") return "Mon–Fri";
  return ordered.map((d) => WEEKDAY_SHORT[d]).join(", ");
}

/** One line per day type, e.g. "Regular day (Mon, Tue, Thu, Fri): 8:00 AM–3:05 PM, 6 classes". */
export function summarizeBellSchedule(s: BellSchedule): string[] {
  return s.dayTypes
    .filter((dt) => dt.days.length)
    .map((dt) => {
      const hours = schoolHours(dt);
      const classes = dt.periods.filter((p) => p.kind === "class").length;
      const span = hours ? `${formatClock(hours.start)}–${formatClock(hours.end)}` : "no times";
      return `${dt.label} (${formatDays(dt.days)}): ${span}, ${classes} ${classes === 1 ? "class" : "classes"}`;
    });
}

// ---------- Calendar blocks ----------

export type SchoolBlock = {
  title: string;
  starts_at: string;
  ends_at: string;
  recurrence_rule: string;
  timezone: string;
  notes: string;
};

/**
 * One repeating fixed event per day type that has days. Lunch stays inside
 * the block: you're still at school. Returns an error string when a block
 * can't be built (unknown time zone, no days).
 */
export function toSchoolBlocks(
  schedule: BellSchedule,
  timeZone: string,
  now: Date = new Date(),
): { ok: true; blocks: SchoolBlock[] } | { ok: false; error: string } {
  const active = schedule.dayTypes.filter((dt) => dt.days.length);
  if (!active.length) return { ok: false, error: "Pick the days you have school." };
  const blocks: SchoolBlock[] = [];
  for (const dt of active) {
    const hours = schoolHours(dt);
    if (!hours) return { ok: false, error: "Add at least one period." };
    const times = weeklyScheduleToCommitmentTimes({ days: dt.days, startTime: hours.start, endTime: hours.end }, timeZone, now);
    if (!times) return { ok: false, error: "Couldn't place that schedule. Check your time zone in Settings." };
    const lines = sortPeriods(dt.periods).map((p) => `${formatClock(p.start)}–${formatClock(p.end)}  ${p.label}`);
    if (schedule.rotation === "ab") lines.unshift("A/B rotation: same bell times, alternating classes.");
    blocks.push({
      title: active.length > 1 ? `School · ${dt.label}` : "School",
      starts_at: times.startsAt,
      ends_at: times.endsAt,
      recurrence_rule: times.recurrenceRule,
      timezone: timeZone,
      notes: lines.join("\n").slice(0, 2000),
    });
  }
  return { ok: true, blocks };
}

// ---------- Utils ----------

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function mode(values: number[]): number | null {
  if (!values.length) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}
