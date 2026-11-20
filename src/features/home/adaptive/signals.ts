import type { AssistantSettings, DailyBrief, Recommendation } from "@/features/proactive/types";
import type { Commitment, Goal, Task } from "@/lib/domain/types";
import { dayCapacity, type Analysis } from "@/lib/proactive/analyze";
import { surface } from "@/lib/proactive/surface";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, startOfDayInZone } from "@/lib/scheduling/zoned";
import { toNudge, type Nudge } from "../proactive";
import { WORKLOAD_KINDS, type DayLoad, type DeadlineItem, type FocusData, type GoalsData, type OpenTimeData, type ProgressData } from "./types";

/**
 * Step 2 of the adaptive Home: plain facts from data already loaded.
 * Reuses the Phase 5 engine's analysis (free time, work left, overloads)
 * and brief (ranked focus tasks) instead of recomputing them. Pure and
 * deterministic: the same input always gives the same signals.
 * Every optional input may be null; missing data means "no signal", never a crash.
 */

export type SignalInput = {
  now: Date;
  /** Local YYYY-MM-DD. */
  todayKey: string;
  timeZone: string;
  /** Calendar events loaded for Home (recurring ones are expanded here). */
  events: Commitment[];
  openTasks: Task[];
  /** Phase 5 engine output; null when the engine failed or isn't set up. */
  analysis: Analysis | null;
  brief: DailyBrief | null;
  /** Open recommendations, ranked (engine "all" surface). */
  recommendations: Recommendation[];
  settings: AssistantSettings | null;
  /** Recommendation ids the conversation already shows, so they are never repeated. */
  chatShownIds: readonly string[];
  goals: Goal[] | null;
  /** Tasks completed recently (any extra open tasks are ignored). */
  recentlyDone: Task[] | null;
  aiConfigured: boolean;
};

export type HomeSignals = {
  todayKey: string;
  /** Nothing entered yet: no events, tasks, goals or finished work. */
  isNewUser: boolean;
  focus: FocusData | null;
  /** 3 = overdue or due today, 2 = due tomorrow or short on time, 1 = worth doing, 0 = none. */
  focusUrgency: 0 | 1 | 2 | 3;
  /** Task due dates (overdue up to a week back) and one-off fixed events, next 14 days, in time order. */
  deadlines: DeadlineItem[];
  /** The next 7 days, from the engine. Null without an analysis. */
  week: DayLoad[] | null;
  workloadWarnings: Nudge[];
  coveredWarnings: { id: string; message: string }[];
  suggestions: Nudge[];
  freeMinutesToday: number;
  nextFreeAt: string | null;
  ideas: OpenTimeData["ideas"];
  progress: ProgressData | null;
  goals: GoalsData["goals"];
  aiConfigured: boolean;
  /** Latest update among the recommendations used (ISO). */
  recommendationsUpdatedAt: string | null;
};

export const DEADLINE_LOOKBACK_DAYS = 7;
export const DEADLINE_LOOKAHEAD_DAYS = 14;
const MAX_IDEAS = 3;
const MINUTE = 60_000;

const minutesBetween = (start: Date, end: Date) => Math.max(0, Math.round((end.getTime() - start.getTime()) / MINUTE));

/** Task deadlines and one-off fixed events. Weekly routines aren't deadlines. */
export function collectDeadlines(input: Pick<SignalInput, "now" | "todayKey" | "timeZone" | "events" | "openTasks">): DeadlineItem[] {
  const { now, todayKey, timeZone: tz } = input;
  const items: DeadlineItem[] = [];
  for (const t of input.openTasks) {
    if (t.status === "done" || !t.dueAt) continue;
    const dueMs = Date.parse(t.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    const dateKey = dateKeyInZone(new Date(dueMs), tz);
    const days = daysBetweenKeys(todayKey, dateKey);
    if (days < -DEADLINE_LOOKBACK_DAYS || days > DEADLINE_LOOKAHEAD_DAYS) continue;
    items.push({
      id: t.id,
      kind: "task",
      source: "task",
      title: t.title,
      dateKey,
      days,
      at: new Date(dueMs).toISOString(),
      allDay: false,
      overdue: dueMs <= now.getTime(),
      areaId: t.lifeAreaId ?? null,
      priority: t.priority,
    });
  }
  const from = startOfDayInZone(addDaysToKey(todayKey, 1), tz);
  const to = startOfDayInZone(addDaysToKey(todayKey, DEADLINE_LOOKAHEAD_DAYS + 1), tz);
  for (const o of expandEvents(input.events, from, to, tz)) {
    if (o.event.kind !== "fixed" || o.event.recurrenceRule) continue;
    const dateKey = dateKeyInZone(o.start, tz);
    items.push({
      id: o.key,
      kind: "event",
      source: "calendar",
      title: o.event.title,
      dateKey,
      days: daysBetweenKeys(todayKey, dateKey),
      at: o.start.toISOString(),
      allDay: o.allDay,
      overdue: false,
      areaId: o.event.lifeAreaId ?? null,
      priority: null,
    });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function weekFrom(a: Analysis, overloadedDates: ReadonlySet<string>): DayLoad[] {
  return a.days.slice(0, 7).map((d) => ({
    dateKey: d.date,
    commitmentMinutes: d.commitments.reduce((s, o) => s + minutesBetween(o.start, o.end), 0),
    sessionMinutes: d.blockMinutes,
    freeMinutes: dayCapacity(a, d),
    due: d.due.length,
    overloaded: overloadedDates.has(d.date),
  }));
}

function focusFrom(brief: DailyBrief, tasks: Map<string, Task>, nextFreeAt: string | null): FocusData | null {
  const [first, ...rest] = brief.focus;
  if (!first) return null;
  return {
    taskId: first.taskId,
    title: first.title,
    why: first.why,
    estimatedMinutes: first.estimatedMinutes,
    areaId: tasks.get(first.taskId)?.lifeAreaId ?? null,
    freeMinutesToday: brief.freeMinutes,
    nextFreeAt,
    planLabel: brief.action?.kind === "plan_day" ? brief.action.label : null,
    then: rest.map((f) => ({ taskId: f.taskId, title: f.title, why: f.why })),
  };
}

function urgencyOf(focus: FocusData | null, tasks: Map<string, Task>, input: SignalInput): HomeSignals["focusUrgency"] {
  if (!focus) return 0;
  const task = tasks.get(focus.taskId);
  if (task?.dueAt) {
    const dueMs = Date.parse(task.dueAt);
    if (Number.isFinite(dueMs)) {
      const days = daysBetweenKeys(input.todayKey, dateKeyInZone(new Date(dueMs), input.timeZone));
      if (dueMs <= input.now.getTime() || days <= 0) return 3;
      if (days === 1) return 2;
    }
  }
  return /^Short on time/.test(focus.why) ? 2 : 1;
}

function progressFrom(done: Task[] | null, todayKey: string, tz: string): ProgressData | null {
  if (!done) return null;
  const weekStart = addDaysToKey(todayKey, -6);
  const finished = done
    .filter((t) => t.status === "done" && t.completedAt && Number.isFinite(Date.parse(t.completedAt)))
    .map((t) => ({ t, key: dateKeyInZone(new Date(t.completedAt!), tz) }))
    .filter((x) => x.key >= weekStart && x.key <= todayKey)
    .sort((a, b) => Date.parse(b.t.completedAt!) - Date.parse(a.t.completedAt!) || a.t.id.localeCompare(b.t.id));
  return {
    doneToday: finished.filter((x) => x.key === todayKey).length,
    doneThisWeek: finished.length,
    recent: finished.slice(0, 3).map((x) => ({ id: x.t.id, title: x.t.title })),
  };
}

export function evaluateSignals(input: SignalInput): HomeSignals {
  const tz = input.timeZone;
  const tasks = new Map(input.openTasks.map((t) => [t.id, t]));
  const a = input.analysis;
  const today = a?.days[0] ?? null;
  const nextFreeAt = today?.slots[0]?.start ?? null;

  const open = input.recommendations.filter((r) => r.status === "open");
  const chatShown = new Set(input.chatShownIds);
  const overloadedDates = new Set(open.filter((r) => r.kind === "overload_day" && r.target.date).map((r) => r.target.date!));

  const focus = input.brief ? focusFrom(input.brief, tasks, nextFreeAt) : null;

  // What the assistant may raise on its own: the user's level and quiet hours
  // apply to the rail exactly as they do to the conversation (the engine's rules).
  const raisable = input.settings
    ? surface(open, { settings: input.settings, now: input.now, timeZone: tz, mode: "home" })
    : [];
  const raisableIds = new Set(raisable.map((r) => r.id));

  const warningsAll = open.filter((r) => WORKLOAD_KINDS.has(r.kind));
  const workloadWarnings = warningsAll.filter((r) => raisableIds.has(r.id) && !chatShown.has(r.id)).map((r) => toNudge(r, input.aiConfigured));
  // A warning already in the conversation (or held back by the level) still counts as a fact, without a second offer.
  const coveredWarnings = warningsAll
    .filter((r) => !workloadWarnings.some((w) => w.id === r.id))
    .map((r) => ({ id: r.id, message: (r.title || r.message).replace(/\s+/g, " ").trim() }));

  const suggestions = raisable
    .filter((r) => !WORKLOAD_KINDS.has(r.kind) && !chatShown.has(r.id))
    // The focus section already covers its task.
    .filter((r) => !focus || r.target.taskId !== focus.taskId)
    .map((r) => toNudge(r, input.aiConfigured));

  const goals: GoalsData["goals"] = (input.goals ?? [])
    .filter((g) => g.status === "active")
    .map((g) => ({
      id: g.id,
      title: g.title,
      progress: typeof g.progress === "number" ? Math.max(0, Math.min(100, Math.round(g.progress))) : null,
      targetDate: g.targetDate,
      areaId: g.lifeAreaId ?? null,
    }));

  const ideas: OpenTimeData["ideas"] = [
    ...goals.map((g) => ({ kind: "goal" as const, id: g.id, title: g.title, areaId: g.areaId })),
    ...input.openTasks
      .filter((t) => !t.dueAt && t.status !== "done")
      .sort((x, y) => (x.priority === y.priority ? 0 : x.priority === "high" ? -1 : y.priority === "high" ? 1 : 0) || x.id.localeCompare(y.id))
      .map((t) => ({ kind: "task" as const, id: t.id, title: t.title, areaId: t.lifeAreaId ?? null })),
  ].slice(0, MAX_IDEAS);

  const progress = progressFrom(input.recentlyDone, input.todayKey, tz);
  const usedRecs = [...warningsAll, ...raisable];
  const recommendationsUpdatedAt = usedRecs.length ? usedRecs.map((r) => r.updatedAt).sort().at(-1)! : null;

  return {
    todayKey: input.todayKey,
    isNewUser:
      input.events.length === 0 &&
      input.openTasks.length === 0 &&
      (input.goals?.length ?? 0) === 0 &&
      (progress?.doneThisWeek ?? 0) === 0,
    focus,
    focusUrgency: urgencyOf(focus, tasks, input),
    deadlines: collectDeadlines(input),
    week: a ? weekFrom(a, overloadedDates) : null,
    workloadWarnings,
    coveredWarnings,
    suggestions,
    freeMinutesToday: today ? dayCapacity(a!, today) : 0,
    nextFreeAt,
    ideas,
    progress,
    goals,
    aiConfigured: input.aiConfigured,
    recommendationsUpdatedAt,
  };
}
