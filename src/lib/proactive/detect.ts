import type {
  RecommendationAction,
  RecommendationKind,
  RecommendationPriority,
} from "@/features/proactive/types";
import { checkPlacements } from "@/lib/scheduling/planner";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, startOfDayInZone, startOfWeekKey } from "@/lib/scheduling/zoned";
import type { Occurrence } from "@/lib/scheduling/recurrence";
import { pickKeeper } from "./conflict-pick";
import { EXAM_LOOKAHEAD_DAYS, examPrepPlan, hasPrep, isExam } from "./exam";
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
  roughly,
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
    t.remaining !== null ? `About ${duration(roughly(t.remaining))} of work left` : null,
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
    message: `${quote(t.task.title)} is overdue. It was due ${when}. I'd find time to finish it, unless it's already done.`,
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
        ? `${quote(t.task.title)} is ${when}. It needs ${about(t.unscheduled)}, you've got ${about(free)}. I'd lock in what fits now.`
        : `${quote(t.task.title)} is ${when} and needs ${about(t.unscheduled)}. There's no free time left before then. I'd move the due date.`,
    facts: factsFor(t, [`About ${duration(roughly(free))} free before then`]),
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
    message: `You've pushed ${quote(t.task.title)} back ${plural(n, "time")}. ${t.remaining && t.remaining >= minSplit ? "I'd break it into short sessions." : t.remaining ? "I'd give it a fixed slot." : "I'd break it into smaller steps."} Or it's less urgent than it looks.`,
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
  const lead = start && free >= 15 ? ` You've got ${about(free)} free. I'd start ${start}.` : "";
  return {
    dedupeKey: `deadline_soon:${t.task.id}:${t.dueDate}`,
    kind: "deadline_soon",
    priority: taskPriority(t, days === 0 ? "high" : "medium"),
    title: `${t.task.title} is ${when}`,
    reason,
    message: `${quote(t.task.title)} is ${when}.${lead} Want me to block it out?`,
    facts: factsFor(t, [free > 0 ? `About ${duration(roughly(free))} free before then` : null]),
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
  // The user already said it happened: nothing to ask.
  if (recent.outcome === "done" || recent.outcome === "partial") return null;
  const missed = recent.outcome === "missed";
  const minutes = Math.round((Date.parse(recent.endsAt!) - Date.parse(recent.startsAt!)) / 60_000);
  const key = dateKeyInZone(new Date(recent.startsAt!), a.timeZone);
  const when = `${dayPhrase(key, a.todayKey)} at ${clockAt(recent.startsAt!, a.timeZone)}`;
  const dueSoon = t.dueDate !== null && daysBetweenKeys(a.todayKey, t.dueDate) <= 2;
  return {
    dedupeKey: `missed_session:${recent.id}`,
    kind: "missed_session",
    priority: taskPriority(t, dueSoon ? "high" : "medium"),
    title: missed ? `${t.task.title} needs a new slot` : `Did the ${t.task.title} session happen?`,
    reason: missed ? `The session ${when} was missed and nothing else is planned.` : `A session was planned ${when} and the task is still open.`,
    message: missed
      ? `The ${quote(t.task.title)} session ${when} didn't happen. Want me to find another slot?`
      : `Did ${quote(t.task.title)} happen ${when}? If not, I'll find another slot.`,
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
    message: `${quote(t.task.title)} is ${when} and needs ${about(t.unscheduled)}. Better as ${sessions} sessions than one long ${lastMinute}. Want me to schedule them?`,
    facts: factsFor(t, [`About ${duration(roughly(capacityBefore(a, t.dueMs)))} free before then`]),
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
      message: `${block.title} ${when} now overlaps ${hit.title}. Want me to find another slot${due}?`,
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
  return groupBroken(out, a);
}

/**
 * One calendar change often breaks several sessions at once (7.5). Those
 * become one card with one fix: move them all, on one approval card, so the
 * user never fixes them one by one.
 */
function groupBroken(list: Candidate[], a: Analysis): Candidate[] {
  if (list.length < 2) return list;
  const ids = list.flatMap((c) => c.commitmentIds);
  const blocks = ids.map((id) => a.futureBlocks.find((b) => b.id === id)!).filter(Boolean);
  const named = blocks
    .slice(0, 3)
    .map((b) => `${b.title} (${dayPhrase(dateKeyInZone(new Date(b.startsAt!), a.timeZone), a.todayKey)} ${clockAt(b.startsAt!, a.timeZone)})`);
  const more = blocks.length > 3 ? `, and ${plural(blocks.length - 3, "more")}` : "";
  const first = list.map((c) => c.date!).sort()[0];
  return [
    {
      dedupeKey: `plan_broken:group:${[...ids].sort().join(",")}`,
      kind: "plan_broken",
      priority: list.some((c) => c.priority === "high") ? "high" : "medium",
      title: `${plural(list.length, "session")} no longer fit`,
      reason: "Your calendar changed, and these sessions now overlap events.",
      message: `Your calendar changed, so ${plural(list.length, "session")} no longer fit: ${named.join(", ")}${more}. I'd move them all to free times before they're due. Want me to?`,
      facts: list.flatMap((c) => c.facts.filter((f) => f.startsWith("Overlaps"))).filter((f, i, all) => all.indexOf(f) === i).slice(0, 3),
      actions: [{ id: "reschedule", kind: "reschedule", label: `Move all ${list.length}`, params: { commitmentIds: ids.slice(0, 20) } }],
      taskId: null,
      commitmentIds: ids,
      date: first,
    },
  ];
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
      offer = target ? `Move ${block.title} to ${dayPhrase(target.date, a.todayKey)}?` : `Move ${block.title} to a lighter day?`;
    } else if (firstDue && day.date > a.todayKey) {
      action = scheduleWork(firstDue, firstDue.unscheduled!, `Start ${firstDue.task.title} earlier`, day.date);
      offer = `Want me to start ${quote(firstDue.task.title)} before then?`;
    } else {
      action = ask("rebalance", "Help me rebalance", `${name} looks overloaded. Help me rebalance it.`);
      offer = "Want help picking what can wait?";
    }

    out.push({
      dedupeKey: `overload_day:${day.date}`,
      kind: "overload_day",
      priority: daysBetweenKeys(a.todayKey, day.date) <= 1 ? "high" : "medium",
      title: `${name} looks overloaded`,
      reason: tooMuch
        ? `About ${duration(roughly(load))} of work is planned or due, but only ${about(holds)} realistically fits.`
        : `${plural(day.due.length, "deadline")} and ${plural(day.commitments.length, "commitment")} fall on the same day.`,
      message: `${name}'s packed: ${list}. ${offer}`,
      facts: [
        ...parts,
        tooMuch ? `About ${duration(roughly(load))} of work, ${duration(roughly(holds))} fits` : null,
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
    reason: `About ${duration(roughly(worst.need))} of unscheduled work is due by ${shortDate(worst.date)}, but only ${about(worst.free)} of free time fits before then.`,
    message: `This week's over capacity: ${plural(due.length, "deadline")}, ${about(worst.short)} more work than free time. Want me to schedule what fits and flag the rest?`,
    facts: [
      `${plural(due.length, "deadline")} by ${shortDate(due[due.length - 1].dueDate!)}`,
      `About ${duration(roughly(worst.need))} of work to schedule`,
      `About ${duration(roughly(worst.free))} free`,
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
// Phase 7: fixed commitments that overlap each other
// ---------------------------------------------------------------------------

/** Overlaps shorter than this are back-to-back events with sloppy times, not conflicts. */
const MIN_CONFLICT_MINUTES = 10;
const MAX_CONFLICTS = 5;
/** An event added this recently makes a repeating overlap news. */
const NEW_EVENT_DAYS = 7;

function short(title: string, max = 24): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

function keepAction(keep: Occurrence, drop: Occurrence, date: string, label = `Keep ${short(keep.event.title)}`): RecommendationAction {
  return {
    id: `keep:${keep.event.id}`,
    kind: "resolve_conflict",
    label,
    params: { keepId: keep.event.id, dropId: drop.event.id, date },
  };
}

/** What happens to the event that gives way: one day of a repeating event, or the whole one-off. */
function dropLabel(drop: Occurrence, date: string, todayKey: string): string {
  return drop.recurring ? `Skip ${short(drop.event.title)} ${dayPhrase(date, todayKey) === "today" ? "today" : "that day"}` : `Remove ${short(drop.event.title)}`;
}

export function commitmentConflicts(a: Analysis): Candidate[] {
  const out: Candidate[] = [];
  const seenPairs = new Set<string>();
  for (const day of a.days) {
    // Timed, fixed calendar events only. Whitespace sessions are handled by plan_broken.
    const fixed = day.commitments
      .filter((o) => o.event.kind === "fixed" && !o.allDay && o.end.getTime() > a.nowMs)
      .sort((x, y) => x.start.getTime() - y.start.getTime() || x.event.id.localeCompare(y.event.id));
    for (let i = 0; i < fixed.length; i++) {
      for (let j = i + 1; j < fixed.length; j++) {
        const x = fixed[i];
        const y = fixed[j];
        if (y.start >= x.end) break;
        if (x.event.id === y.event.id) continue;
        const overlap = Math.round((Math.min(x.end.getTime(), y.end.getTime()) - y.start.getTime()) / 60_000);
        if (overlap < MIN_CONFLICT_MINUTES) continue;
        const [first, second] = x.event.id < y.event.id ? [x, y] : [y, x];
        const pair = `${first.event.id}:${second.event.id}`;
        // Two repeating events that always overlap are one situation, not one per week.
        const bothRepeat = x.recurring && y.recurring;
        const dedupeKey = bothRepeat ? `commitment_conflict:${pair}` : `commitment_conflict:${pair}:${day.date}`;
        if (seenPairs.has(dedupeKey)) continue;
        seenPairs.add(dedupeKey);
        const at = clockAt(y.start.toISOString(), a.timeZone);
        const name = dayName(day.date, a.todayKey);
        const span = (o: Occurrence) => `${o.event.title}: ${clockAt(o.start.toISOString(), a.timeZone)}–${clockAt(o.end.toISOString(), a.timeZone)}`;
        const same = x.event.title.trim().toLowerCase() === y.event.title.trim().toLowerCase();
        // Whitespace proposes which one gives way; the user approves or picks the other.
        const pick = same ? null : pickKeeper(
          { id: x.event.id, title: x.event.title, recurring: x.recurring },
          { id: y.event.id, title: y.event.title, recurring: y.recurring },
        );
        const keepOcc = pick ? (pick.keep.id === x.event.id ? x : y) : null;
        const dropOcc = pick ? (pick.drop.id === x.event.id ? x : y) : null;
        const soon = daysBetweenKeys(a.todayKey, day.date) <= 1;
        // Two long-standing repeating events that overlap are usually on purpose (lunch inside school).
        // If one of them is new, the overlap is news: raise it normally.
        const isNew = (o: Occurrence) => !!o.event.createdAt && a.nowMs - Date.parse(o.event.createdAt) < NEW_EVENT_DAYS * 86_400_000;
        const settled = bothRepeat && !isNew(x) && !isNew(y);
        out.push({
          dedupeKey,
          kind: "commitment_conflict",
          priority: soon ? "high" : settled ? "low" : "medium",
          title: same ? `${x.event.title} is on the calendar twice` : `${x.event.title} overlaps ${y.event.title}`,
          reason: pick
            ? `They overlap by ${duration(overlap)}. ${pick.why}`
            : `Both are fixed and overlap by ${duration(overlap)}${bothRepeat ? " every time they repeat" : ""}.`,
          message: same
            ? `${name} at ${at}: ${quote(x.event.title)} is on your calendar twice. Remove one?`
            : pick && keepOcc && dropOcc
              ? `${name} at ${at}: ${quote(keepOcc.event.title)} overlaps ${quote(dropOcc.event.title)}. ${pick.why} I'd ${dropOcc.recurring ? `skip ${dropOcc.event.title} ${dayPhrase(day.date, a.todayKey) === "today" ? "today" : "that day"}` : `drop ${dropOcc.event.title}`}. Want me to?`
              : `${name} at ${at}: ${quote(x.event.title)} overlaps ${quote(y.event.title)}. Which one is happening?`,
          facts: [span(x), span(y), bothRepeat ? "Both repeat" : shortDate(day.date)],
          actions: same
            ? [keepAction(x, y, day.date), { id: "acknowledge", kind: "acknowledge", label: "Both are right", params: {} }]
            : pick && keepOcc && dropOcc
              ? [
                  keepAction(keepOcc, dropOcc, day.date, dropLabel(dropOcc, day.date, a.todayKey)),
                  keepAction(dropOcc, keepOcc, day.date, `Keep ${short(dropOcc.event.title)} instead`),
                  { id: "acknowledge", kind: "acknowledge", label: "Both are right", params: {} },
                ]
              : [keepAction(x, y, day.date), keepAction(y, x, day.date), { id: "acknowledge", kind: "acknowledge", label: "Both are right", params: {} }],
          taskId: null,
          commitmentIds: [x.event.id, y.event.id],
          date: day.date,
        });
        if (out.length >= MAX_CONFLICTS) return out;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 7: deadline clusters that only fit if work starts earlier
// ---------------------------------------------------------------------------

/** Deadlines within this many days of the first one form a cluster. */
const CLUSTER_SPAN_DAYS = 2;
const CLUSTER_LOOKAHEAD_DAYS = 10;

/**
 * Several deadlines bunched together. overload_week already covers "not
 * enough time at all"; this catches the softer case: there is enough time
 * overall, but not if the work waits until those days.
 */
export function deadlineClusters(a: Analysis): Candidate[] {
  const due = a.tasks
    .filter(
      (t) =>
        t.dueMs !== null &&
        t.dueMs > a.nowMs &&
        t.dueDate !== null &&
        (t.unscheduled ?? 0) > 0 &&
        daysBetweenKeys(a.todayKey, t.dueDate) <= CLUSTER_LOOKAHEAD_DAYS,
    )
    .sort((x, y) => x.dueMs! - y.dueMs!);
  const out: Candidate[] = [];
  let i = 0;
  while (i < due.length) {
    const last = addDaysToKey(due[i].dueDate!, CLUSTER_SPAN_DAYS);
    let j = i;
    while (j + 1 < due.length && due[j + 1].dueDate! <= last) j++;
    const group = due.slice(i, j + 1);
    i = j + 1;
    if (group.length < 2) continue;
    const firstDay = group[0].dueDate!;
    if (firstDay <= a.todayKey) continue; // nothing earlier to move work into
    const lastDue = group[group.length - 1];
    const need = group.reduce((s, t) => s + t.unscheduled!, 0);
    const startMs = startOfDayInZone(firstDay, a.timeZone).getTime();
    const before = capacityBefore(a, startMs);
    const total = capacityBefore(a, lastDue.dueMs!);
    const during = Math.max(0, total - before);
    if (need <= during + SLACK_MINUTES) continue; // fits even if it waits
    if (need > total + SLACK_MINUTES) continue; // doesn't fit at all: overload_week / deadline_at_risk say so
    if (before < 30) continue;
    const from = weekdayLong(firstDay);
    const to = weekdayLong(lastDue.dueDate!);
    const range = firstDay === lastDue.dueDate ? `on ${from}` : `between ${from} and ${to}`;
    const days = daysBetweenKeys(a.todayKey, firstDay);
    out.push({
      dedupeKey: `deadline_cluster:${firstDay}:${lastDue.dueDate}`,
      kind: "deadline_cluster",
      priority: days <= 2 ? "high" : "medium",
      title: `${plural(group.length, "deadline")} ${range}`,
      reason: `They need ${about(need)} of work, and those days only have ${about(during)} free.`,
      message: `${plural(group.length, "deadline")} land ${range}: about ${duration(roughly(need))} of work, ${about(during)} free then. I'd start before ${from}.`,
      facts: [
        group.map((t) => t.task.title).slice(0, 4).join(", "),
        `About ${duration(roughly(need))} of work left`,
        `About ${duration(roughly(before))} free before ${from}`,
      ],
      actions: [
        {
          id: "schedule_tasks",
          kind: "schedule_tasks",
          label: "Start earlier",
          params: { taskIds: group.map((t) => t.task.id).slice(0, 6) },
        },
      ],
      taskId: null,
      commitmentIds: [],
      date: firstDay,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exam prep (7.3)
// ---------------------------------------------------------------------------

/**
 * An exam, test or quiz in the next days with nothing planned to study for
 * it: propose study sessions before it, sized by how close it is and the
 * realistic free time before it.
 */
export function examPreps(a: Analysis): Candidate[] {
  const prepTitles = [...a.tasks.map((t) => t.task.title), ...a.futureBlocks.map((b) => b.title)];
  const out: Candidate[] = [];
  for (const day of a.days.slice(0, EXAM_LOOKAHEAD_DAYS + 1)) {
    for (const o of day.commitments) {
      const e = o.event;
      if (e.kind !== "fixed" || o.recurring || !isExam(e.title) || hasPrep(e.title, prepTitles)) continue;
      const startMs = o.start.getTime();
      const plan = examPrepPlan(
        { title: e.title, startMs },
        { nowMs: a.nowMs, minSessionMinutes: a.preferences.minSessionMinutes, maxSessionMinutes: a.preferences.maxSessionMinutes, capacity: capacityBefore(a, startMs) },
      );
      if (!plan) continue;
      const when = `${dayPhrase(day.date, a.todayKey)} at ${clockAt(o.start.toISOString(), a.timeZone)}`;
      const sessions = plan.sessions === 1 ? `a ${duration(plan.minutesEach)} study session` : `${plan.sessions} study sessions of ${duration(plan.minutesEach)}`;
      const days = daysBetweenKeys(a.todayKey, day.date);
      out.push({
        dedupeKey: `exam_prep:${e.id}:${day.date}`,
        kind: "exam_prep",
        priority: days <= 2 ? "high" : "medium",
        title: `${e.title} ${dayPhrase(day.date, a.todayKey)}`,
        reason: "Nothing is planned to study for it yet.",
        message: `${quote(e.title)} is ${when}, and nothing's planned to study for it. I'd book ${sessions} before then. Want me to?`,
        facts: [`${e.title}: ${shortDate(day.date)}, ${clockAt(o.start.toISOString(), a.timeZone)}`, `About ${duration(roughly(capacityBefore(a, startMs)))} free before then`],
        actions: [
          {
            id: "prep_exam",
            kind: "prep_exam",
            label: plan.sessions === 1 ? "Book a study session" : `Book ${plan.sessions} study sessions`,
            params: { eventId: e.id, sessions: plan.sessions, minutesEach: plan.minutesEach },
          },
          { id: "acknowledge", kind: "acknowledge", label: "I'm prepared", params: {} },
        ],
        taskId: null,
        commitmentIds: [e.id],
        date: day.date,
      });
    }
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Phase 7.6: a life area that dropped off
// ---------------------------------------------------------------------------

/** Per-area time the neglected-area detector reads (lib/insights/area-time). */
export type AreaHistory = {
  /** Areas with time in the earlier weeks: total minutes and the last local day with any. */
  earlier: { areaId: string; name: string; minutes: number; lastDate: string }[];
  /** Area ids with any time in the recent window, past or planned. */
  active: ReadonlySet<string>;
};

/** The area was a real part of the week: at least this much time in the earlier weeks. */
export const NEGLECT_MIN_EARLIER = 120;
/** No time at all in this many days, and none planned in the next week. */
export const NEGLECT_QUIET_DAYS = 14;
const NEGLECT_WINDOW_MINUTES = 60;

/**
 * A life area that used to have regular time and has had none for two
 * weeks, with nothing planned and a real free window this week. Low
 * priority (only the "proactive" level raises it on its own). It never
 * assumes areas need equal time: an area the user never gave time to is
 * never raised. One at a time. Keyed on the last day the area had time,
 * so "That's fine" holds until the area is used and dropped again.
 */
export function neglectedAreas(a: Analysis, h: AreaHistory): Candidate[] {
  const area = h.earlier
    .filter((e) => e.minutes >= NEGLECT_MIN_EARLIER && !h.active.has(e.areaId))
    .sort((x, y) => y.minutes - x.minutes)[0];
  if (!area) return [];
  const window = a.days
    .slice(1, 8)
    .map((d) => ({ d, cap: dayCapacity(a, d) }))
    .filter((x) => x.cap >= NEGLECT_WINDOW_MINUTES)
    .sort((x, y) => y.cap - x.cap || x.d.date.localeCompare(y.d.date))[0];
  if (!window) return [];
  const day = dayPhrase(window.d.date, a.todayKey);
  const weeks = Math.round(NEGLECT_QUIET_DAYS / 7);
  return [
    {
      dedupeKey: `neglected_area:${area.areaId}:${area.lastDate}`,
      kind: "neglected_area",
      priority: "low",
      title: `No time for ${area.name} lately`,
      reason: `${area.name} had ${about(area.minutes)} in the weeks before, and nothing in the last ${weeks} weeks or planned this week.`,
      message: `${area.name} hasn't had any time in ${weeks} weeks, and nothing's planned. If you want it back, ${day} has room. Want me to find an hour?`,
      facts: [`Last time: ${shortDate(area.lastDate)}`, `About ${duration(roughly(window.cap))} free ${day}`],
      actions: [
        ask("find_time", "Find an hour", `Find me an hour for ${area.name} this week.`),
        { id: "acknowledge", kind: "acknowledge", label: "That's fine for now", params: {} },
      ],
      taskId: null,
      commitmentIds: [],
      date: window.d.date,
    },
  ];
}

// ---------------------------------------------------------------------------

export function detectFromAnalysis(a: Analysis, extra: { history?: AreaHistory | null } = {}): Candidate[] {
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
  out.push(...commitmentConflicts(a), ...deadlineClusters(a), ...examPreps(a));
  if (extra.history) out.push(...neglectedAreas(a, extra.history));
  // Unique keys, even if two detectors ever agree.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.dedupeKey) ? false : (seen.add(c.dedupeKey), true)));
}

/** Runs every detector on fresh data. Throws SchedulingInputError for an invalid time zone or preferences. */
export function detect(input: ProactiveInput): Candidate[] {
  return detectFromAnalysis(analyze(input));
}
