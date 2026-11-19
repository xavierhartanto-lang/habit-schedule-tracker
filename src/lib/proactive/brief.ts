import type { BriefEvent, BriefFocus, DailyBrief, RecommendationAction } from "@/features/proactive/types";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, daysBetweenKeys, startOfDayInZone } from "@/lib/scheduling/zoned";
import { capacityBefore, isSession, type Analysis, type TaskLoad } from "./analyze";
import { about, clockAt, dayPhrase, duePhrase, periodPhrase, plural, quote, shortDate } from "./text";

/**
 * The daily planning view: what's left today, the few tasks worth
 * attention, and one sentence the assistant can open with. Deterministic
 * and short on purpose (at most three focus tasks). Pure.
 */

const MAX_FOCUS = 3;
const MIN_PLAN_MINUTES = 30;

type Ranked = { t: TaskLoad; rank: number; why: string };

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

export function focusTasks(a: Analysis): Ranked[] {
  return a.tasks
    .map((t) => rankTask(t, a))
    .filter((r): r is Ranked => !!r)
    .sort((x, y) => x.rank - y.rank || (x.t.dueMs ?? Infinity) - (y.t.dueMs ?? Infinity))
    .slice(0, MAX_FOCUS);
}

/** Minutes worth planning for a focus task in one day: what's left, at most one long session. */
export function dayMinutesFor(t: TaskLoad, maxSession: number): number | null {
  const left = t.unscheduled ?? null;
  if (left === null || left < 15) return null;
  return Math.min(left, maxSession);
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
  const plannable = ranked.filter(({ t }) => dayMinutesFor(t, a.preferences.maxSessionMinutes) !== null).map(({ t }) => t);
  const action: RecommendationAction | null = plannable.length
    ? {
        id: "plan_day",
        kind: "plan_day",
        label: planToday ? "Plan my day" : "Plan tomorrow",
        params: { date: planDate, taskIds: plannable.map((t) => t.task.id) },
      }
    : null;

  return { date: a.todayKey, timeZone: tz, events, freeMinutes, focus, message: briefMessage(a, events, ranked, action, planToday), action };
}

function briefMessage(a: Analysis, events: BriefEvent[], ranked: Ranked[], action: RecommendationAction | null, planToday: boolean): string {
  const tz = a.timeZone;
  const fixed = events.filter((e) => !e.allDay && e.kind === "fixed" && !isSessionId(a, e.id));
  const next = fixed[0];
  const top = ranked[0]?.t;

  const eventPart = next
    ? `You have ${next.title} ${Date.parse(next.start) <= a.nowMs ? `until ${clockAt(next.end, tz)}` : `at ${clockAt(next.start, tz)}`} today${fixed.length > 1 ? `, plus ${plural(fixed.length - 1, "more commitment")}` : ""}`
    : null;
  const taskPart = top
    ? top.dueMs !== null && top.dueMs <= a.nowMs
      ? `${quote(top.task.title)} is overdue`
      : top.task.dueAt
        ? `${quote(top.task.title)} is ${duePhrase(top.task.dueAt, tz, a.todayKey)}`
        : `${quote(top.task.title)} is high priority`
    : null;

  const sentences: string[] = [];
  if (eventPart && taskPart) sentences.push(`${eventPart}, and ${taskPart}.`);
  else if (eventPart) sentences.push(`${eventPart}.`);
  else if (taskPart) sentences.push(`${taskPart.charAt(0).toUpperCase()}${taskPart.slice(1)}.`);
  else if (!events.length) return "Nothing else is on your calendar today, and no deadlines need attention.";
  else return "No deadlines need attention right now.";

  if (top && action) {
    const today = a.days[0];
    if (planToday && today?.slots[0]) {
      sentences.push(`I'd get started on ${quote(top.task.title)} ${periodPhrase(today.slots[0].start, tz)}. You have ${about(today.freeMinutes)} free.`);
    } else {
      sentences.push(`Today is full, so I'd start on ${quote(top.task.title)} tomorrow.`);
    }
    sentences.push(planToday ? "Want me to organize your schedule?" : "Want me to plan tomorrow?");
  }
  return sentences.join(" ");
}

function isSessionId(a: Analysis, id: string): boolean {
  const e = a.input.events.find((x) => x.id === id);
  return !!e && isSession(e);
}
