import type { Commitment, Task } from "@/lib/domain/types";
import { findFreeTime, type FreeSlot, type SchedulingPreferences } from "@/lib/scheduling/planner";
import { expandEvents, type Occurrence } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, startOfDayInZone } from "@/lib/scheduling/zoned";

/**
 * The deterministic facts every Phase 5 detector reads: how much work each
 * open task still needs, what Whitespace already scheduled for it, and how
 * much realistic free time each day has. Free time comes from the Phase 4
 * scheduling engine (working hours, buffers, protected time), never from
 * an LLM. Pure: the caller passes `now` and fresh data.
 */

export const HORIZON_DAYS = 14;
const MINUTE = 60_000;

export type ProactiveInput = {
  /** ISO instant. */
  now: string;
  /** Profile IANA zone. */
  timeZone: string;
  weekStartsOn?: 0 | 1;
  /** Fresh from the database, covering at least [now - 3 days, now + 14 days]. Recurring events are expanded here. */
  events: Commitment[];
  /** Open tasks (status != done). */
  tasks: Task[];
  preferences: SchedulingPreferences;
  /** Time other open plans are already offering, so it isn't counted as free. */
  busy?: { start: string; end: string; title?: string }[];
};

export type TaskLoad = {
  task: Task;
  dueMs: number | null;
  /** Local due date. */
  dueDate: string | null;
  estimate: number | null;
  /** Whitespace sessions for this task that already ended (assumed done unless recorded as missed). */
  pastBlocks: Commitment[];
  /** Whitespace sessions still ahead (or in progress). */
  futureBlocks: Commitment[];
  pastBlockMinutes: number;
  futureBlockMinutes: number;
  /** estimate - past sessions. Null without an estimate. */
  remaining: number | null;
  /** remaining - future sessions. Null without an estimate. */
  unscheduled: number | null;
};

export type DayLoad = {
  date: string;
  /** Raw free minutes in working hours (from now on for today). */
  freeMinutes: number;
  slots: FreeSlot[];
  /** Whitespace work sessions on this day. */
  blocks: Commitment[];
  blockMinutes: number;
  /** Timed calendar commitments on this day, not counting Whitespace sessions. */
  commitments: Occurrence[];
  /** Open tasks due this day. */
  due: TaskLoad[];
};

export type Analysis = {
  nowMs: number;
  timeZone: string;
  todayKey: string;
  weekStartsOn: 0 | 1;
  preferences: SchedulingPreferences;
  tasks: TaskLoad[];
  days: DayLoad[];
  /** Future Whitespace sessions in the horizon. */
  futureBlocks: Commitment[];
  /** Non-session calendar events (for conflict checks). */
  calendar: Commitment[];
  horizonEnd: string;
  input: ProactiveInput;
};

/** A session Whitespace scheduled from an approved plan (flexible, linked to a plan item). */
export function isSession(e: Commitment): boolean {
  return e.kind === "flexible" && !!e.planItemId && !!e.startsAt && !!e.endsAt && !e.recurrenceRule;
}

function minutesOf(e: { startsAt?: string | null; endsAt?: string | null }): number {
  if (!e.startsAt || !e.endsAt) return 0;
  return Math.max(0, Math.round((Date.parse(e.endsAt) - Date.parse(e.startsAt)) / MINUTE));
}

export function analyze(input: ProactiveInput): Analysis {
  const nowMs = Date.parse(input.now);
  const tz = input.timeZone;
  const todayKey = dateKeyInZone(new Date(nowMs), tz);
  const horizonEnd = startOfDayInZone(addDaysToKey(todayKey, HORIZON_DAYS + 1), tz).toISOString();

  const sessions = input.events.filter(isSession);
  const calendar = input.events.filter((e) => !isSession(e));
  const futureBlocks = sessions
    .filter((b) => Date.parse(b.endsAt!) > nowMs && Date.parse(b.startsAt!) < Date.parse(horizonEnd))
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!));

  const tasks: TaskLoad[] = input.tasks
    .filter((t) => t.status !== "done")
    .map((task) => {
      const mine = sessions.filter((b) => b.taskId === task.id);
      const pastBlocks = mine.filter((b) => Date.parse(b.endsAt!) <= nowMs);
      const future = mine.filter((b) => Date.parse(b.endsAt!) > nowMs);
      // A session the user said was missed did no work. Unrecorded ones are assumed done.
      const pastBlockMinutes = pastBlocks.filter((b) => b.outcome !== "missed").reduce((s, b) => s + minutesOf(b), 0);
      const futureBlockMinutes = future.reduce((s, b) => s + minutesOf(b), 0);
      const estimate = task.estimatedMinutes && task.estimatedMinutes > 0 ? task.estimatedMinutes : null;
      const remaining = estimate === null ? null : Math.max(0, estimate - pastBlockMinutes);
      const dueMs = task.dueAt ? Date.parse(task.dueAt) : null;
      return {
        task,
        dueMs: dueMs !== null && Number.isFinite(dueMs) ? dueMs : null,
        dueDate: dueMs !== null && Number.isFinite(dueMs) ? dateKeyInZone(new Date(dueMs), tz) : null,
        estimate,
        pastBlocks,
        futureBlocks: future,
        pastBlockMinutes,
        futureBlockMinutes,
        remaining,
        unscheduled: remaining === null ? null : Math.max(0, remaining - futureBlockMinutes),
      };
    });

  const slots = findFreeTime({
    now: new Date(nowMs).toISOString(),
    timeZone: tz,
    window: { start: new Date(nowMs).toISOString(), end: horizonEnd },
    events: input.events,
    busy: input.busy ?? [],
    preferences: input.preferences,
  });

  const occurrences = expandEvents(calendar, new Date(nowMs), new Date(horizonEnd), tz).filter((o) => !o.allDay);
  const days: DayLoad[] = [];
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDaysToKey(todayKey, i);
    const daySlots = slots.filter((s) => s.date === date);
    const blocks = futureBlocks.filter((b) => dateKeyInZone(new Date(b.startsAt!), tz) === date);
    days.push({
      date,
      freeMinutes: daySlots.reduce((s, f) => s + f.minutes, 0),
      slots: daySlots,
      blocks,
      blockMinutes: blocks.reduce((s, b) => s + minutesOf(b), 0),
      commitments: occurrences.filter((o) => dateKeyInZone(o.start, tz) === date),
      due: tasks.filter((t) => t.dueDate === date && (t.dueMs ?? 0) > nowMs),
    });
  }

  return {
    nowMs,
    timeZone: tz,
    todayKey,
    weekStartsOn: input.weekStartsOn ?? 1,
    preferences: input.preferences,
    tasks,
    days,
    futureBlocks,
    calendar,
    horizonEnd,
    input,
  };
}

/**
 * Realistic minutes of new work a day can take before `beforeMs`:
 * free time minus the share the user keeps open, capped by the daily
 * limit minus sessions already planned that day. Mirrors the engine.
 */
export function dayCapacity(a: Analysis, day: DayLoad, beforeMs = Number.POSITIVE_INFINITY): number {
  const free = day.slots.reduce((s, f) => {
    const start = Date.parse(f.start);
    const end = Math.min(Date.parse(f.end), beforeMs);
    return end > start ? s + (end - start) / MINUTE : s;
  }, 0);
  const keep = a.preferences.keepFreePercent / 100;
  const cap = a.preferences.dailyCapMinutes - day.blockMinutes;
  return Math.max(0, Math.floor(Math.min(free * (1 - keep), cap)));
}

/** Realistic free minutes from now until `beforeMs` (inside the horizon). */
export function capacityBefore(a: Analysis, beforeMs: number): number {
  return a.days.filter((d) => startOfDayInZone(d.date, a.timeZone).getTime() < beforeMs).reduce((s, d) => s + dayCapacity(a, d, beforeMs), 0);
}
