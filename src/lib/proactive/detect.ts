import type {
  RecommendationAction,
  RecommendationKind,
  RecommendationPriority,
} from "@/features/proactive/types";
import { checkPlacements } from "@/lib/scheduling/planner";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, startOfWeekKey } from "@/lib/scheduling/zoned";
import type { Commitment } from "@/lib/domain/types";
import { analyze, capacityBefore, dayCapacity, HORIZON_DAYS, type Analysis, type DayLoad, type ProactiveInput, type TaskLoad } from "./analyze";
import {
  about,
  clockAt,
  dayName,
  dayPhrase,
  duePhrase,
  duration,
  periodPhrase,
  plural,
  quote,
  shortDate,
  weekdayLong,
} from "./text";

/**
 * Phase 5 detectors. Each looks at real, structured data and returns
 * candidate recommendations with a deterministic reason, supporting facts
 * and suggested actions. Nothing here writes anything: actions become
 * Phase 4 plans only when the user asks. Pure and unit tested.
 */

export type Candidate = {
  dedupeKey: string;
  kind: RecommendationKind;
  priority: RecommendationPriority;
  title: string;
  reason: string;
  message: string;
  facts: string[];
  actions: RecommendationAction[];
  taskId: string | null;
  commitmentIds: string[];
  date: string | null;
};

/** Ignore differences smaller than this when comparing work to free time. */
const SLACK_MINUTES = 15;
const MISSED_LOOKBACK_MS = 3 * 86_400_000;
const MAX_REQUEST_MINUTES = 3000;

const PRIORITY_WORD = { high: "High priority", medium: "Medium priority", low: "Low priority" } as const;

const clampMinutes = (m: number) => Math.min(MAX_REQUEST_MINUTES, Math.max(15, Math.round(m / 5) * 5));

function roundUp5(m: number): number {
  return Math.ceil(m / 5) * 5;
}

/** n sessions of a sensible length for `minutes` of work, within the user's session limits. */
export function splitIntoSessions(minutes: number, prefs: { minSessionMinutes: number; maxSessionMinutes: number }): { sessions: number; minutesEach: number } {
  const target = Math.min(prefs.maxSessionMinutes, Math.max(prefs.minSessionMinutes, 60));
  const sessions = Math.min(6, Math.max(2, Math.ceil(minutes / target)));
  const minutesEach = Math.min(480, Math.max(prefs.minSessionMinutes, roundUp5(minutes / sessions)));
  return { sessions, minutesEach };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function scheduleWork(t: TaskLoad, minutes: number, label: string, before: string | null = null): RecommendationAction {
  return { id: "schedule_work", kind: "schedule_work", label, params: { taskId: t.task.id, minutes: clampMinutes(minutes), before } };
}

function split(t: TaskLoad, minutes: number, a: Analysis, label?: string): RecommendationAction {
  const { sessions, minutesEach } = splitIntoSessions(minutes, a.preferences);
  return {
    id: "split_sessions",
    kind: "split_sessions",
    label: label ?? `Schedule ${sessions} sessions`,
    params: { taskId: t.task.id, sessions, minutesEach },
  };
}

function markComplete(t: TaskLoad, label = "It's done"): RecommendationAction {
  return { id: "mark_complete", kind: "mark_complete", label, params: { taskId: t.task.id } };
}

function lowerPriority(t: TaskLoad, label = "Lower priority"): RecommendationAction {
  return { id: "change_priority", kind: "change_priority", label, params: { taskId: t.task.id, priority: "low" } };
}

function ask(id: string, label: string, prompt: string): RecommendationAction {
  return { id, kind: "ask", label, params: { prompt } };
}

function newDueDate(t: TaskLoad): RecommendationAction {
  return ask("new_due_date", "Pick a new due date", `I need a new due date for ${quote(t.task.title)}.`);
}

// ---------------------------------------------------------------------------
// Per-task detectors (at most one recommendation per task)
// ---------------------------------------------------------------------------

function factsFor(t: TaskLoad, extra: (string | null)[] = []): string[] {
  const out: (string | null)[] = [
    t.dueDate ? `Due ${shortDate(t.dueDate)}` : null,
    t.remaining !== null ? `About ${duration(t.remaining)} of work left` : null,
    t.futureBlockMinutes > 0 ? `${duration(t.futureBlockMinutes)} already scheduled` : null,
    t.task.priority !== "medium" ? PRIORITY_WORD[t.task.priority] : null,
    ...extra,
  ];
  return out.filter((f): f is string => !!f).slice(0, 5);
}

function taskPriority(t: TaskLoad, base: RecommendationPriority): RecommendationPriority {
  if (t.task.priority === "low") return "low";
  if (t.task.priority === "high" && base === "medium") return "high";
  return base;
}

function overdue(t: TaskLoad, a: Analysis): Candidate | null {
  if (t.dueMs === null || t.dueMs > a.nowMs || !t.dueDate) return null;
  const daysLate = daysBetweenKeys(t.dueDate, a.todayKey);
  // Edited after it went overdue without a new due date: the user has seen it.
  const acknowledged = !!t.task.updatedAt && Date.parse(t.task.updatedAt) > t.dueMs + 3_600_000;
  const priority: RecommendationPriority =
    t.task.priority === "low" || acknowledged || daysLate > 21 ? "low" : t.task.priority === "high" ? "high" : "medium";
  const when = daysLate === 0 ? "earlier today" : daysLate === 1 ? "yesterday" : `on ${shortDate(t.dueDate)}`;
  const actions: RecommendationAction[] = [
    t.remaining && t.remaining > 0
      ? scheduleWork(t, t.remaining, `Find ${duration(clampMinutes(t.remaining))} to finish`)
      : ask("find_time", "Find time to finish", `Help me find time to finish ${quote(t.task.title)}.`),
    markComplete(t),
    newDueDate(t),
  ];
  if (t.task.priority !== "low") actions.push(lowerPriority(t, "Not important now"));
  return {
    dedupeKey: `overdue:${t.task.id}:${t.dueDate}`,
    kind: "overdue",
    priority,
    title: `${t.task.title} is overdue`,
    reason: `It was due ${when} and is still open.`,
    message: `${quote(t.task.title)} was due ${when}. Want me to find time to finish it, or is it already done?`,
    facts: factsFor(t),
    actions,
    taskId: t.task.id,
    commitmentIds: [],
    date: t.dueDate,
  };
}

function atRisk(t: TaskLoad, a: Analysis): Candidate | null {
  if (t.dueMs === null || t.dueMs <= a.nowMs || !t.dueDate || !t.unscheduled) return null;
  if (daysBetweenKeys(a.todayKey, t.dueDate) > HORIZON_DAYS) return null;
  const free = capacityBefore(a, t.dueMs);
  if (t.unscheduled <= free + SLACK_MINUTES) return null;
  const when = duePhrase(t.task.dueAt!, a.timeZone, a.todayKey);
  return {
    dedupeKey: `deadline_at_risk:${t.task.id}:${t.dueDate}`,
    kind: "deadline_at_risk",
    priority: taskPriority(t, "high"),
    title: `Not enough time for ${t.task.title}`,
    reason: `It needs ${about(t.unscheduled)} more, but only ${about(free)} of realistic free time is left before it's ${when}.`,
    message:
      free >= 15
        ? `${quote(t.task.title)} is ${when} and needs ${about(t.unscheduled)} more, but you only have ${about(free)} free before then. Want me to schedule what fits so you can start now?`
        : `${quote(t.task.title)} is ${when} and needs ${about(t.unscheduled)} more, but your schedule has no free time left before then. Want to move the due date or make room?`,
    facts: factsFor(t, [`${duration(free)} free before then`]),
    actions: [
      ...(free >= 15 ? [scheduleWork(t, t.unscheduled, "Schedule what fits")] : []),
      newDueDate(t),
      ask("make_room", "Make room", `Help me make room for ${quote(t.task.title)} before it's ${when}.`),
    ],
    taskId: t.task.id,
    commitmentIds: [],
    date: t.dueDate,
  };
}

function postponed(t: TaskLoad, a: Analysis): Candidate | null {
  const n = t.task.postponeCount ?? 0;
  if (n < 2) return null;
  const actions: RecommendationAction[] = [];
  const minSplit = a.preferences.minSessionMinutes * 2;
  if (t.remaining && t.remaining >= minSplit) {
    const { sessions } = splitIntoSessions(t.remaining, a.preferences);
    actions.push(split(t, t.remaining, a, `Break into ${sessions} short sessions`));
  } else if (t.remaining) {
    actions.push(scheduleWork(t, t.remaining, `Schedule ${duration(clampMinutes(t.remaining))}`));
  } else {
    actions.push(ask("get_started", "Help me get started", `Help me break ${quote(t.task.title)} into smaller steps.`));
  }
  if (t.task.priority !== "low") actions.push(lowerPriority(t));
  actions.push(markComplete(t));
  return {
    dedupeKey: `postponed:${t.task.id}:${n >= 4 ? "4+" : "2"}`,
    kind: "postponed",
    priority: taskPriority(t, "medium"),
    title: `${t.task.title} keeps getting pushed back`,
    reason: `It has been postponed ${plural(n, "time")}.`,
    message: `You've pushed ${quote(t.task.title)} back ${plural(n, "time")}. Want to break it into smaller sessions, or is it less important than it looks?`,
    facts: factsFor(t, [`Postponed ${plural(n, "time")}`]),
    actions,
    taskId: t.task.id,
    commitmentIds: [],
    date: t.dueDate,
  };
}

function deadlineSoon(t: TaskLoad, a: Analysis): Candidate | null {
  if (t.dueMs === null || t.dueMs <= a.nowMs || !t.dueDate) return null;
  const days = daysBetweenKeys(a.todayKey, t.dueDate);
  if (days > 1) return null;
  const needsTime = t.unscheduled === null ? t.futureBlocks.length === 0 : t.unscheduled >= SLACK_MINUTES;
  if (!needsTime) return null;
  const when = duePhrase(t.task.dueAt!, a.timeZone, a.todayKey);
  const firstFree = a.days.flatMap((d) => d.slots).find((s) => Date.parse(s.start) < t.dueMs!);
  const free = capacityBefore(a, t.dueMs);
  const start = firstFree
    ? firstFree.date === a.todayKey
      ? periodPhrase(firstFree.start, a.timeZone)
      : `${dayPhrase(firstFree.date, a.todayKey)} ${periodPhrase(firstFree.start, a.timeZone).replace("this ", "")}`
    : null;
  const reason =
    t.unscheduled === null
      ? "Nothing is scheduled for it yet."
      : t.futureBlockMinutes > 0
        ? `${duration(t.unscheduled)} of it isn't scheduled yet.`
        : `It needs ${about(t.unscheduled)} and nothing is scheduled for it yet.`;
  const lead = start && free >= 15 ? ` You have ${about(free)} free before then, so I'd start ${start}.` : "";
  return {
    dedupeKey: `deadline_soon:${t.task.id}:${t.dueDate}`,
    kind: "deadline_soon",
    priority: taskPriority(t, days === 0 ? "high" : "medium"),
    title: `${t.task.title} is ${when}`,
    reason,
    message: `${quote(t.task.title)} is ${when}.${lead} Want me to block out time for it?`,
    facts: factsFor(t, [free > 0 ? `${duration(free)} free before then` : null]),
    actions: [
      t.unscheduled
        ? scheduleWork(t, t.unscheduled, `Block out ${duration(clampMinutes(t.unscheduled))}`)
        : ask("plan_time", "Plan time for it", `Help me plan time for ${quote(t.task.title)}, ${when}.`),
      markComplete(t, "Already done"),
    ],
    taskId: t.task.id,
    commitmentIds: [],
    date: t.dueDate,
  };
}

function missedSession(t: TaskLoad, a: Analysis): Candidate | null {
  if (t.futureBlocks.length) return null;
  const recent = t.pastBlocks
    .filter((b) => Date.parse(b.endsAt!) > a.nowMs - MISSED_LOOKBACK_MS)
    .sort((x, y) => Date.parse(y.startsAt!) - Date.parse(x.startsAt!))[0];
  if (!recent) return null;
  const minutes = Math.round((Date.parse(recent.endsAt!) - Date.parse(recent.startsAt!)) / 60_000);
  const key = dateKeyInZone(new Date(recent.startsAt!), a.timeZone);
  const when = `${dayPhrase(key, a.todayKey)} at ${clockAt(recent.startsAt!, a.timeZone)}`;
  const dueSoon = t.dueDate !== null && daysBetweenKeys(a.todayKey, t.dueDate) <= 2;
  return {
    dedupeKey: `missed_session:${recent.id}`,
    kind: "missed_session",
    priority: taskPriority(t, dueSoon ? "high" : "medium"),
    title: `Did the ${t.task.title} session happen?`,
    reason: `A session was planned ${when} and the task is still open.`,
    message: `You had time planned for ${quote(t.task.title)} ${when}. If it didn't happen, I can find another slot. If you finished, I'll mark it done.`,
    facts: factsFor(t, [`${duration(minutes)} session ${when}`]),
    actions: [scheduleWork(t, minutes, "Find another time"), markComplete(t, "I finished it")],
    taskId: t.task.id,
    commitmentIds: [recent.id],
    date: key,
  };
}

function startEarly(t: TaskLoad, a: Analysis): Candidate | null {
  if (t.dueMs === null || t.dueMs <= a.nowMs || !t.dueDate || !t.unscheduled || t.futureBlocks.length) return null;
  const days = daysBetweenKeys(a.todayKey, t.dueDate);
  if (days < 2 || days > 7) return null;
  if (t.unscheduled <= a.preferences.maxSessionMinutes) return null;
  const { sessions } = splitIntoSessions(t.unscheduled, a.preferences);
  const when = duePhrase(t.task.dueAt!, a.timeZone, a.todayKey);
  const lastMinute = days >= 2 ? weekdayLong(addDaysToKey(t.dueDate, -1)) : "the last minute";
  return {
    dedupeKey: `start_early:${t.task.id}:${t.dueDate}`,
    kind: "start_early",
    priority: taskPriority(t, days <= 3 && t.task.priority === "high" ? "high" : "medium"),
    title: `Start ${t.task.title} early`,
    reason: `It's ${about(t.unscheduled)} of work, ${when}, and more than one session long.`,
    message: `${quote(t.task.title)} is ${when} and will take ${about(t.unscheduled)}. I'd split it into ${sessions} sessions rather than leaving it all for ${lastMinute}. Want me to schedule them?`,
    facts: factsFor(t, [`${duration(capacityBefore(a, t.dueMs))} free before then`]),
    actions: [split(t, t.unscheduled, a)],
    taskId: t.task.id,
    commitmentIds: [],
    date: t.dueDate,
  };
}

/** Order matters: the first detector that fires is the one recommendation for that task. */
const TASK_DETECTORS = [overdue, atRisk, postponed, deadlineSoon, missedSession, startEarly];

// ---------------------------------------------------------------------------
// Broken plans: sessions that now collide with the calendar
// ---------------------------------------------------------------------------

function brokenPlans(a: Analysis): Candidate[] {
  const blocks = a.futureBlocks.filter((b) => Date.parse(b.startsAt!) > a.nowMs);
  if (!blocks.length) return [];
  const check = checkPlacements(
    {
      now: new Date(a.nowMs).toISOString(),
      timeZone: a.timeZone,
      window: { start: new Date(a.nowMs).toISOString(), end: a.horizonEnd },
      events: a.calendar,
      preferences: a.preferences,
    },
    blocks.map((b) => ({ id: b.id, start: b.startsAt!, end: b.endsAt!, title: b.title })),
  );
  const tasksById = new Map(a.tasks.map((t) => [t.task.id, t]));
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of check.results) {
    // An event in the way. Two sessions overlapping each other is reported once, on the later one.
    const hit = r.conflicts.find((c) => c.kind === "event") ?? r.conflicts.find((c) => c.kind === "placement");
    if (!hit) continue;
    const block = blocks.find((b) => b.id === r.id)!;
    if (hit.kind === "placement") {
      const other = blocks.find((b) => b.startsAt === hit.start && b.endsAt === hit.end && b.id !== block.id);
      if (other && (seen.has(other.id) || Date.parse(other.startsAt!) > Date.parse(block.startsAt!))) continue;
    }
    seen.add(block.id);
    const start = block.startsAt!;
    const key = dateKeyInZone(new Date(start), a.timeZone);
    const when = `${dayPhrase(key, a.todayKey)} at ${clockAt(start, a.timeZone)}`;
    const task = block.taskId ? tasksById.get(block.taskId) : undefined;
    const due = task?.task.dueAt ? ` before it's ${duePhrase(task.task.dueAt, a.timeZone, a.todayKey)}` : "";
    out.push({
      dedupeKey: `plan_broken:${block.id}:${start}`,
      kind: "plan_broken",
      priority: Date.parse(start) - a.nowMs < 86_400_000 ? "high" : "medium",
      title: `${block.title} no longer fits`,
      reason: `It overlaps ${hit.title} (${dayPhrase(key, a.todayKey)}, ${clockAt(hit.start, a.timeZone)}).`,
      message: `Your ${block.title} session ${when} now overlaps ${hit.title}. Want me to find another time${due}?`,
      facts: [
        `Planned ${shortDate(key)}, ${clockAt(start, a.timeZone)}–${clockAt(block.endsAt!, a.timeZone)}`,
        `Overlaps ${hit.title}`,
        ...(task?.dueDate ? [`Due ${shortDate(task.dueDate)}`] : []),
      ],
      actions: [{ id: "reschedule", kind: "reschedule", label: "Find another time", params: { commitmentIds: [block.id] } }],
      taskId: task?.task.id ?? null,
      commitmentIds: [block.id],
      date: key,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overload
// ---------------------------------------------------------------------------

/** The session on `day` that is easiest to move: not due that day, lowest priority, latest deadline. */
function movableBlock(a: Analysis, day: DayLoad): Commitment | null {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const options = day.blocks
    .filter((b) => Date.parse(b.startsAt!) > a.nowMs)
    .map((b) => ({ b, t: a.tasks.find((t) => t.task.id === b.taskId) }))
    .filter(({ t }) => !t || t.dueDate === null || t.dueDate > day.date)
    .sort(
      (x, y) =>
        rank[x.t?.task.priority ?? "medium"] - rank[y.t?.task.priority ?? "medium"] ||
        (y.t?.dueMs ?? Infinity) - (x.t?.dueMs ?? Infinity),
    );
  return options[0]?.b ?? null;
}

/** Day (other than `skip`) in [from, to] with the most room left. */
function lightestDay(a: Analysis, skip: string, to: string | null): DayLoad | null {
  const last = to ?? addDaysToKey(a.todayKey, 6);
  const options = a.days.filter((d) => d.date !== skip && d.date <= last && dayCapacity(a, d) >= 30);
  return options.sort((x, y) => dayCapacity(a, y) - dayCapacity(a, x))[0] ?? null;
}

function overloadedDays(a: Analysis): Candidate[] {
  const out: Candidate[] = [];
  for (const day of a.days.slice(0, 7)) {
    const unscheduledDue = day.due.reduce((s, t) => s + (t.unscheduled ?? 0), 0);
    const load = day.blockMinutes + unscheduledDue;
    // Everything planned or due that day, against what the day can realistically hold.
    const holds = Math.min(a.preferences.dailyCapMinutes, Math.floor(dayCapacity(a, { ...day, blockMinutes: 0 }) + day.blockMinutes));
    const items = day.due.length + day.blocks.length;
    const tooMuch = load > holds + SLACK_MINUTES && items >= 2;
    const crowded = day.due.length >= 3 && day.commitments.length >= 2;
    if (!tooMuch && !crowded) continue;

    const name = dayName(day.date, a.todayKey);
    const parts = [
      day.due.length ? plural(day.due.length, "deadline") : null,
      day.commitments.length ? plural(day.commitments.length, "commitment") : null,
      day.blocks.length ? plural(day.blocks.length, "work session") : null,
    ].filter(Boolean) as string[];
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];

    let action: RecommendationAction;
    let offer: string;
    const block = movableBlock(a, day);
    const firstDue = day.due.filter((t) => (t.unscheduled ?? 0) > 0).sort((x, y) => (y.unscheduled ?? 0) - (x.unscheduled ?? 0))[0];
    if (block) {
      const task = a.tasks.find((t) => t.task.id === block.taskId);
      const target = lightestDay(a, day.date, task?.dueDate ?? null);
      action = { id: "lighten_day", kind: "lighten_day", label: `Move ${block.title}`, params: { date: day.date, commitmentIds: [block.id] } };
      offer = `Want me to move ${block.title} to a lighter day${target ? `, like ${dayPhrase(target.date, a.todayKey)}` : ""}?`;
    } else if (firstDue && day.date > a.todayKey) {
      action = scheduleWork(firstDue, firstDue.unscheduled!, `Start ${firstDue.task.title} earlier`, day.date);
      offer = `Want me to schedule ${quote(firstDue.task.title)} before ${dayPhrase(day.date, a.todayKey)} so it doesn't all land on one day?`;
    } else {
      action = ask("rebalance", "Help me rebalance", `${name} looks overloaded. Help me rebalance it.`);
      offer = "Want help deciding what can wait?";
    }

    out.push({
      dedupeKey: `overload_day:${day.date}`,
      kind: "overload_day",
      priority: daysBetweenKeys(a.todayKey, day.date) <= 1 ? "high" : "medium",
      title: `${name} looks overloaded`,
      reason: tooMuch
        ? `About ${duration(load)} of work is planned or due, but only ${about(holds)} realistically fits.`
        : `${plural(day.due.length, "deadline")} and ${plural(day.commitments.length, "commitment")} fall on the same day.`,
      message: `${name} is looking pretty busy: ${list}. ${offer}`,
      facts: [
        ...parts,
        tooMuch ? `${duration(load)} of work vs ${duration(holds)} that fits` : null,
      ].filter((f): f is string => !!f),
      actions: [action],
      taskId: null,
      commitmentIds: day.blocks.map((b) => b.id).slice(0, 20),
      date: day.date,
    });
  }
  return out;
}

function overloadedWeek(a: Analysis): Candidate | null {
  const end = addDaysToKey(a.todayKey, 6);
  const due = a.tasks
    .filter((t) => t.dueMs !== null && t.dueMs > a.nowMs && t.dueDate! <= end && (t.unscheduled ?? 0) > 0)
    .sort((x, y) => x.dueMs! - y.dueMs!);
  if (due.length < 2) return null;
  let need = 0;
  let worst: { short: number; need: number; free: number; date: string } | null = null;
  for (const t of due) {
    need += t.unscheduled!;
    const free = capacityBefore(a, t.dueMs!);
    const short = need - free;
    if (short > SLACK_MINUTES && (!worst || short > worst.short)) worst = { short, need, free, date: t.dueDate! };
  }
  if (!worst) return null;
  return {
    dedupeKey: `overload_week:${startOfWeekKey(a.todayKey, a.weekStartsOn)}`,
    kind: "overload_week",
    priority: worst.short >= 120 ? "high" : "medium",
    title: "More work than time this week",
    reason: `About ${duration(worst.need)} of unscheduled work is due by ${shortDate(worst.date)}, but only ${about(worst.free)} of free time fits before then.`,
    message: `You have ${plural(due.length, "deadline")} in the next week and ${about(worst.short)} more work than free time. Want me to schedule what fits and show what doesn't?`,
    facts: [
      `${plural(due.length, "deadline")} by ${shortDate(due[due.length - 1].dueDate!)}`,
      `${duration(worst.need)} of work to schedule`,
      `${duration(worst.free)} free`,
    ],
    actions: [
      { id: "plan_week", kind: "plan_week", label: "Plan my week", params: {} },
      ask("prioritize", "Help me prioritize", "I have more work than time this week. Help me decide what to move or drop."),
    ],
    taskId: null,
    commitmentIds: [],
    date: worst.date,
  };
}

// ---------------------------------------------------------------------------

export function detectFromAnalysis(a: Analysis): Candidate[] {
  const out: Candidate[] = [];
  for (const t of a.tasks) {
    for (const detect of TASK_DETECTORS) {
      const c = detect(t, a);
      if (c) {
        out.push(c);
        break;
      }
    }
  }
  out.push(...brokenPlans(a), ...overloadedDays(a));
  const week = overloadedWeek(a);
  if (week) out.push(week);
  // Unique keys, even if two detectors ever agree.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.dedupeKey) ? false : (seen.add(c.dedupeKey), true)));
}

/** Runs every detector on fresh data. Throws SchedulingInputError for an invalid time zone or preferences. */
export function detect(input: ProactiveInput): Candidate[] {
  return detectFromAnalysis(analyze(input));
}
