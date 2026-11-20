import type { BriefEvent, BriefFocus, DailyBrief, RecommendationAction } from "@/features/proactive/types";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, daysBetweenKeys, startOfDayInZone } from "@/lib/scheduling/zoned";
import { capacityBefore, dayCapacity, isSession, type Analysis, type TaskLoad } from "./analyze";
import { catchUpPlan } from "./catch-up";
import { about, clockAt, dayName, dayPhrase, duePhrase, periodPhrase, plural, quote, shortDate } from "./text";

/**
 * The daily planning view: what's left today, the few tasks worth
 * attention, and one sentence the assistant can open with. Deterministic
 * and short on purpose (at most three focus tasks). Pure.
 */

const MAX_FOCUS = 3;
const MIN_PLAN_MINUTES = 30;

export type Ranked = { t: TaskLoad; rank: number; why: string };

function rankTask(t: TaskLoad, a: Analysis): Ranked | null {
  const p = t.task.priority;
  if (t.dueMs !== null && t.dueDate) {
    const days = daysBetweenKeys(a.todayKey, t.dueDate);
    if (t.dueMs <= a.nowMs) {
      if (p === "low" || days < -21) return null;
      return { t, rank: 0, why: `Overdue since ${shortDate(t.dueDate)}` };
    }
    const nothingPlanned = t.unscheduled === null ? t.futureBlocks.length === 0 : t.unscheduled > 0;
    if (days === 0) return { t, rank: 1, why: "Due today" };
    if (days === 1) return { t, rank: 2, why: "Due tomorrow" };
    if (t.unscheduled && t.unscheduled > capacityBefore(a, t.dueMs)) return { t, rank: 3, why: `Short on time before ${shortDate(t.dueDate)}` };
    if (days <= 7 && p === "high") return { t, rank: 4, why: `High priority, due ${dayPhrase(t.dueDate, a.todayKey)}` };
    if (days <= 7 && nothingPlanned && p !== "low") return { t, rank: 5 + days / 10, why: `Due ${dayPhrase(t.dueDate, a.todayKey)}` };
    return null;
  }
  if (p === "high") return { t, rank: 6, why: "High priority" };
  return null;
}

/** Every task worth attention, ranked by the Phase 5 rules. Focus is the first three. */
export function rankTasks(a: Analysis): Ranked[] {
  return a.tasks
    .map((t) => rankTask(t, a))
    .filter((r): r is Ranked => !!r)
    .sort((x, y) => x.rank - y.rank || (x.t.dueMs ?? Infinity) - (y.t.dueMs ?? Infinity));
}

export function focusTasks(a: Analysis): Ranked[] {
  return rankTasks(a).slice(0, MAX_FOCUS);
}

/**
 * Ranked tasks first, then any other open task with an estimate (high
 * priority first). Used by Now/Next and Plan my day: the same order, so
 * the two never disagree about what matters most.
 */
export function planCandidates(a: Analysis): { t: TaskLoad; why: string | null }[] {
  const ranked = rankTasks(a).map((r) => ({ t: r.t, why: r.why as string | null }));
  const seen = new Set(ranked.map((r) => r.t.task.id));
  const order = { high: 0, medium: 1, low: 2 } as const;
  const rest = a.tasks
    .filter((t) => !seen.has(t.task.id) && t.estimate !== null && (t.dueMs === null || t.dueMs > a.nowMs))
    .sort((x, y) => order[x.task.priority] - order[y.task.priority] || (x.dueMs ?? Infinity) - (y.dueMs ?? Infinity) || x.task.id.localeCompare(y.task.id))
    .map((t) => ({ t, why: null }));
  return [...ranked, ...rest];
}

// ---------------------------------------------------------------------------
// Plan my day (7.3): fill the day's real capacity, explain what's left out
// ---------------------------------------------------------------------------

const MAX_DAY_TASKS = 6;
const MAX_LEFT_OUT = 4;
/** A partial session shorter than this isn't worth booking. */
const MIN_PARTIAL_MINUTES = 30;

export type DayPick = { taskId: string; minutes: number };
export type DayLeftOut = { taskId: string; reason: string };
export type DayPlan = { date: string; picks: DayPick[]; leftOut: DayLeftOut[]; capacity: number };

/**
 * Which tasks get time on `date` (today or tomorrow), in ranking order,
 * until the day's realistic capacity (free time minus the share kept open,
 * capped by the daily limit) is used. Each task gets what's left of its
 * work, at most one long session. Multi-session work may take a shorter
 * session when that's all the room left. Ranked tasks that don't make it
 * get a plain reason. Pure.
 */
export function planDayPicks(a: Analysis, date: string): DayPlan {
  const day = a.days.find((d) => d.date === date);
  const capacity = day ? dayCapacity(a, day) : 0;
  const dayStart = startOfDayInZone(date, a.timeZone).getTime();
  const dayWord = date === a.todayKey ? "today" : "tomorrow";
  const { maxSessionMinutes, minSessionMinutes } = a.preferences;
  const minPartial = Math.max(minSessionMinutes, MIN_PARTIAL_MINUTES);
  const picks: DayPick[] = [];
  const leftOut: DayLeftOut[] = [];
  let room = capacity;

  for (const { t, why } of planCandidates(a)) {
    const worth = why !== null; // only ranked tasks are worth explaining
    const left = t.unscheduled;
    if (left === 0) continue; // its time is already booked
    if (t.dueMs !== null && t.dueMs > a.nowMs && t.dueMs <= dayStart) {
      if (worth) leftOut.push({ taskId: t.task.id, reason: `Due before ${dayWord}.` });
      continue;
    }
    if (left === null) {
      if (worth) leftOut.push({ taskId: t.task.id, reason: "No time estimate yet, so I couldn't size it." });
      continue;
    }
    if (left < 15) continue;
    if (picks.length >= MAX_DAY_TASKS) {
      if (worth) leftOut.push({ taskId: t.task.id, reason: `${dayName(date, a.todayKey)} is already full of work.` });
      continue;
    }
    let minutes = Math.min(left, maxSessionMinutes);
    if (minutes > room) {
      // Multi-session work can take a shorter session; a one-sitting task needs its whole time.
      const partial = Math.floor(room / 5) * 5;
      if (left > maxSessionMinutes && partial >= minPartial) minutes = partial;
      else {
        if (worth) leftOut.push({ taskId: t.task.id, reason: leftOutReason(t, a, dayWord) });
        continue;
      }
    }
    picks.push({ taskId: t.task.id, minutes });
    room -= minutes;
  }
  return { date, picks, leftOut: leftOut.slice(0, MAX_LEFT_OUT), capacity };
}

function leftOutReason(t: TaskLoad, a: Analysis, dayWord: string): string {
  const base = `No room left ${dayWord}.`;
  if (!t.dueDate || t.dueMs === null) return base;
  if (t.dueMs <= a.nowMs) return `${base} It's overdue, so it's first in line next.`;
  const after = capacityBefore(a, t.dueMs);
  return after >= (t.unscheduled ?? 0) ? `${base} Due ${dayPhrase(t.dueDate, a.todayKey)}, and there's time before then.` : `${base} Due ${dayPhrase(t.dueDate, a.todayKey)}, and it's tight.`;
}

export function buildBrief(a: Analysis): DailyBrief {
  const tz = a.timeZone;
  const todayStart = startOfDayInZone(a.todayKey, tz);
  const tomorrowStart = startOfDayInZone(addDaysToKey(a.todayKey, 1), tz);
  const events: BriefEvent[] = expandEvents(a.input.events, todayStart, tomorrowStart, tz)
    .filter((o) => o.end.getTime() > a.nowMs)
    .map((o) => ({
      id: o.event.id,
      title: o.event.title,
      start: o.start.toISOString(),
      end: o.end.toISOString(),
      allDay: o.allDay,
      kind: o.event.kind,
    }));
  const today = a.days[0];
  const freeMinutes = today?.freeMinutes ?? 0;
  const ranked = focusTasks(a);
  const focus: BriefFocus[] = ranked.map(({ t, why }) => ({
    taskId: t.task.id,
    title: t.task.title,
    dueAt: t.task.dueAt,
    estimatedMinutes: t.task.estimatedMinutes,
    why,
  }));

  // Plan today while there is real time left, otherwise tomorrow.
  const planToday = freeMinutes >= MIN_PLAN_MINUTES;
  const planDate = planToday ? a.todayKey : addDaysToKey(a.todayKey, 1);
  const day = planDayPicks(a, planDate);
  const action: RecommendationAction | null = day.picks.length
    ? {
        id: "plan_day",
        kind: "plan_day",
        label: planToday ? "Plan my day" : "Plan tomorrow",
        params: {
          date: planDate,
          taskIds: day.picks.map((p) => p.taskId),
          minutes: day.picks.map((p) => String(p.minutes)),
          leftOut: day.leftOut.map((l) => `${l.taskId}|${l.reason}`),
        },
      }
    : null;

  return {
    date: a.todayKey,
    timeZone: tz,
    events,
    freeMinutes,
    focus,
    message: briefMessage(a, events, ranked, action, planToday),
    action,
    behind: catchUpPlan(a).behind,
  };
}

function briefMessage(a: Analysis, events: BriefEvent[], ranked: Ranked[], action: RecommendationAction | null, planToday: boolean): string {
  const tz = a.timeZone;
  const fixed = events.filter((e) => !e.allDay && e.kind === "fixed" && !isSessionId(a, e.id));
  const next = fixed[0];
  const top = ranked[0]?.t;

  // Lead with the most important thing: an overdue or urgent task beats the next event.
  const taskPart = top
    ? top.dueMs !== null && top.dueMs <= a.nowMs
      ? `${quote(top.task.title)} is overdue.`
      : top.task.dueAt
        ? `${quote(top.task.title)} is ${duePhrase(top.task.dueAt, tz, a.todayKey)}.`
        : `${quote(top.task.title)} is high priority.`
    : null;
  const more = fixed.length > 1 ? `, plus ${plural(fixed.length - 1, "more")}` : "";
  const eventPart = next
    ? Date.parse(next.start) <= a.nowMs
      ? `${next.title} runs until ${clockAt(next.end, tz)}${more}.`
      : `${next.title} at ${clockAt(next.start, tz)}${more}.`
    : null;

  const sentences: string[] = [];
  if (taskPart) sentences.push(taskPart);
  if (eventPart) sentences.push(eventPart);
  if (!sentences.length) return events.length ? "No deadlines pressing right now." : "Nothing else on the calendar today, and no deadlines pressing.";

  if (top && action) {
    const today = a.days[0];
    if (planToday && today?.slots[0]) {
      sentences.push(`You've got ${about(today.freeMinutes)} free. I'd start ${periodPhrase(today.slots[0].start, tz)}.`);
      sentences.push("Want me to plan the day?");
    } else {
      sentences.push("Today's full. Want me to plan tomorrow?");
    }
  }
  return sentences.join(" ");
}

function isSessionId(a: Analysis, id: string): boolean {
  const e = a.input.events.find((x) => x.id === id);
  return !!e && isSession(e);
}
