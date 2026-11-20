import type { AreaColor, Commitment, Goal, LifeAreaRecord, Task } from "@/lib/domain/types";
import { areaOf, findArea } from "@/lib/domain/life-areas";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, startOfDayInZone, startOfWeekKey } from "@/lib/scheduling/zoned";
import { isSession } from "@/lib/proactive/analyze";
import { NEGLECT_QUIET_DAYS, type AreaHistory } from "@/lib/proactive/detect";

/**
 * Phase 7.6: where the time went, per life area. Pure and deterministic.
 *
 * Honest by construction:
 *  - Calendar events count as time on the calendar, never as attended.
 *  - Whitespace sessions split by what the user recorded: done, partly
 *    done, missed, not recorded (past, no answer) and still ahead.
 *    Scheduled is never reported as completed.
 *  - An event's area is its own life area, or for a session, the area of
 *    the task it was booked for. Anything else is Unassigned, never guessed.
 *  - Overlapping events in the same bucket are counted once (union of time).
 *  - All-day events have no hours and are left out.
 *  - Goals are a lens over tasks (goalTime), never an extra area, so no
 *    minute is counted twice.
 */

export type TimeBucket = {
  /** Calendar events, not Whitespace sessions. Time on the calendar, not proof of attending. */
  calendar: number;
  /** Whitespace sessions the user marked done. */
  done: number;
  /** Sessions marked partly done. */
  partial: number;
  missed: number;
  /** Past sessions with no answer yet. */
  unrecorded: number;
  /** Sessions still ahead (or in progress). */
  upcoming: number;
  /** All of the above, overlaps counted once. */
  scheduled: number;
};

export type AreaTime = TimeBucket & {
  /** Null = Unassigned. */
  areaId: string | null;
  name: string;
  color: AreaColor | null;
  position: number;
};

export type DayTime = { date: string; calendar: number; sessions: number; scheduled: number };

export type WeekTime = {
  /** Local YYYY-MM-DD, first day of the week. */
  weekStart: string;
  days: string[];
  /** Areas with any time, in the user's area order; Unassigned last. */
  areas: AreaTime[];
  totals: TimeBucket;
  perDay: DayTime[];
};

export type AreaTimeInput = {
  /** ISO instant. */
  now: string;
  timeZone: string;
  weekStartsOn: 0 | 1;
  /** Rows from the database covering the range (recurring events are expanded here). */
  events: readonly Commitment[];
  /** Tasks (open and recently done), for sessions without their own area. */
  tasks: readonly Task[];
  areas: readonly LifeAreaRecord[];
};

const MINUTE = 60_000;
type Cat = "calendar" | "done" | "partial" | "missed" | "unrecorded" | "upcoming";
const CATS: readonly Cat[] = ["calendar", "done", "partial", "missed", "unrecorded", "upcoming"];
type Seg = { bucket: string; cat: Cat; start: number; end: number; date: string };

export const UNASSIGNED = "Unassigned";
const NONE = "__none__";

export function emptyBucket(): TimeBucket {
  return { calendar: 0, done: 0, partial: 0, missed: 0, unrecorded: 0, upcoming: 0, scheduled: 0 };
}

/** Minutes covered by a set of intervals, overlaps counted once. */
export function unionMinutes(list: readonly { start: number; end: number }[]): number {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const i of sorted) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else curEnd = Math.max(curEnd, i.end);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return Math.round(total / MINUTE);
}

/** The life area an event counts toward. Null = Unassigned. Never guessed from the title. */
export function eventArea(e: Commitment, areas: readonly LifeAreaRecord[], tasks: ReadonlyMap<string, Task>): LifeAreaRecord | null {
  const own = areaOf(areas, e);
  if (own) return own;
  if (e.lifeAreaId) return null; // Points at a deleted area: unassigned, not borrowed from the task.
  if (isSession(e) && e.taskId) {
    const t = tasks.get(e.taskId);
    if (t) return areaOf(areas, t);
  }
  return null;
}

function category(e: Commitment, endMs: number, nowMs: number): Cat {
  if (!isSession(e)) return "calendar";
  if (e.outcome === "done" || e.outcome === "partial" || e.outcome === "missed") return e.outcome;
  return endMs <= nowMs ? "unrecorded" : "upcoming";
}

/** Time segments in [fromMs, toMs), split at local midnights. */
function segments(input: AreaTimeInput, fromMs: number, toMs: number): Seg[] {
  const tz = input.timeZone;
  const nowMs = Date.parse(input.now);
  const taskMap = new Map(input.tasks.map((t) => [t.id, t]));
  const out: Seg[] = [];
  for (const o of expandEvents(input.events, new Date(fromMs), new Date(toMs), tz)) {
    if (o.allDay) continue;
    const area = eventArea(o.event, input.areas, taskMap);
    const cat = category(o.event, o.end.getTime(), nowMs);
    let start = Math.max(o.start.getTime(), fromMs);
    const end = Math.min(o.end.getTime(), toMs);
    // Split across local days so per-day totals are exact.
    while (start < end) {
      const date = dateKeyInZone(new Date(start), tz);
      const dayEnd = Math.min(end, startOfDayInZone(addDaysToKey(date, 1), tz).getTime());
      out.push({ bucket: area?.id ?? NONE, cat, start, end: dayEnd, date });
      start = dayEnd;
    }
  }
  return out;
}

function bucketOf(list: Seg[]): TimeBucket {
  const b = emptyBucket();
  for (const c of CATS) b[c] = unionMinutes(list.filter((s) => s.cat === c));
  b.scheduled = unionMinutes(list);
  return b;
}

/** Per-area time in [fromMs, toMs). Areas without any time are left out. */
export function areaTimeBetween(input: AreaTimeInput, fromMs: number, toMs: number): { areas: AreaTime[]; totals: TimeBucket; segs: Seg[] } {
  const segs = segments(input, fromMs, toMs);
  const byBucket = new Map<string, Seg[]>();
  for (const s of segs) byBucket.set(s.bucket, [...(byBucket.get(s.bucket) ?? []), s]);
  const areas: AreaTime[] = [...byBucket.entries()].map(([id, list]) => {
    const area = id === NONE ? null : findArea(input.areas, id);
    return {
      areaId: area?.id ?? null,
      name: area?.name ?? UNASSIGNED,
      color: area?.color ?? null,
      position: area ? area.position : Number.MAX_SAFE_INTEGER,
      ...bucketOf(list),
    };
  });
  areas.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return { areas, totals: bucketOf(segs), segs };
}

/** Local keys of the week containing `dateKey`. */
export function weekOf(dateKey: string, weekStartsOn: 0 | 1): string[] {
  const start = startOfWeekKey(dateKey, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
}

/** The week starting at `weekStart` (local key). */
export function weekTime(input: AreaTimeInput, weekStart: string): WeekTime {
  const tz = input.timeZone;
  const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(weekStart, i));
  const fromMs = startOfDayInZone(weekStart, tz).getTime();
  const toMs = startOfDayInZone(addDaysToKey(weekStart, 7), tz).getTime();
  const { areas, totals, segs } = areaTimeBetween(input, fromMs, toMs);
  const perDay = days.map((date) => {
    const mine = segs.filter((s) => s.date === date);
    return {
      date,
      calendar: unionMinutes(mine.filter((s) => s.cat === "calendar")),
      sessions: unionMinutes(mine.filter((s) => s.cat !== "calendar")),
      scheduled: unionMinutes(mine),
    };
  });
  return { weekStart, days, areas, totals, perDay };
}

export type AreaChange = {
  areaId: string | null;
  name: string;
  color: AreaColor | null;
  thisWeek: number;
  lastWeek: number;
  /** thisWeek - lastWeek, scheduled minutes. */
  delta: number;
};

/** Scheduled time per area, this week against last week. Every area with time in either week. */
export function compareWeeks(current: WeekTime, previous: WeekTime): AreaChange[] {
  const key = (a: AreaTime) => a.areaId ?? NONE;
  const all = new Map<string, AreaTime>();
  for (const a of [...previous.areas, ...current.areas]) all.set(key(a), a);
  return [...all.values()]
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((a) => {
      const now = current.areas.find((x) => key(x) === key(a))?.scheduled ?? 0;
      const before = previous.areas.find((x) => key(x) === key(a))?.scheduled ?? 0;
      return { areaId: a.areaId, name: a.name, color: a.color, thisWeek: now, lastWeek: before, delta: now - before };
    });
}

export type GoalTime = {
  goalId: string;
  title: string;
  areaId: string | null;
  scheduled: number;
  /** Sessions marked done or partly done. */
  worked: number;
  upcoming: number;
};

/**
 * Goals as a lens: Whitespace session time on tasks linked to each active
 * goal in [fromMs, toMs). The same minutes also sit in their area: this is
 * a different view of them, not extra time.
 */
export function goalTime(input: AreaTimeInput, goals: readonly Goal[], fromMs: number, toMs: number): GoalTime[] {
  const goalOfTask = new Map(input.tasks.filter((t) => t.goalId).map((t) => [t.id, t.goalId!]));
  const nowMs = Date.parse(input.now);
  const sessions = expandEvents(
    input.events.filter((e) => isSession(e) && e.taskId && goalOfTask.has(e.taskId)),
    new Date(fromMs),
    new Date(toMs),
    input.timeZone,
  );
  return goals
    .filter((g) => g.status === "active")
    .map((g) => {
      const mine = sessions
        .filter((o) => goalOfTask.get(o.event.taskId!) === g.id)
        .map((o) => ({ start: Math.max(o.start.getTime(), fromMs), end: Math.min(o.end.getTime(), toMs), cat: category(o.event, o.end.getTime(), nowMs) }));
      return {
        goalId: g.id,
        title: g.title,
        areaId: g.lifeAreaId ?? null,
        scheduled: unionMinutes(mine),
        worked: unionMinutes(mine.filter((s) => s.cat === "done" || s.cat === "partial")),
        upcoming: unionMinutes(mine.filter((s) => s.cat === "upcoming")),
      };
    })
    .filter((g) => g.scheduled > 0);
}

export const HISTORY_EARLIER_DAYS = 35;

/**
 * What the neglected-area detector reads: per area, time in the earlier
 * weeks (35 to 14 days ago) and whether it has any time from 14 days ago
 * through the next week (past or planned). Unassigned time never counts.
 */
export function areaHistory(input: AreaTimeInput, todayKey: string, quietDays = NEGLECT_QUIET_DAYS): AreaHistory {
  const at = (k: string) => startOfDayInZone(k, input.timeZone).getTime();
  const earlierFrom = at(addDaysToKey(todayKey, -HISTORY_EARLIER_DAYS));
  const recentFrom = at(addDaysToKey(todayKey, -quietDays));
  const recentTo = at(addDaysToKey(todayKey, 8));
  const earlier = areaTimeBetween(input, earlierFrom, recentFrom);
  const recent = areaTimeBetween(input, recentFrom, recentTo);
  return {
    earlier: earlier.areas
      .filter((x): x is AreaTime & { areaId: string } => x.areaId !== null && x.scheduled > 0)
      .map((x) => ({
        areaId: x.areaId,
        name: x.name,
        minutes: x.scheduled,
        lastDate: earlier.segs.filter((s) => s.bucket === x.areaId).reduce((m, s) => (s.date > m ? s.date : m), ""),
      })),
    active: new Set(recent.areas.filter((x) => x.areaId !== null && x.scheduled > 0).map((x) => x.areaId!)),
  };
}
