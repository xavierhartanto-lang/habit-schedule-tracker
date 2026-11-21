import type { Recommendation, RecommendationKind } from "@/features/proactive/types";
import { dayCapacity, type Analysis } from "@/lib/proactive/analyze";
import { isExam } from "@/lib/proactive/exam";
import { clockAt, dayName, duration, plural, roughly, shortDate, weekdayLong } from "@/lib/proactive/text";
import { addDaysToKey, daysBetweenKeys, minutesInZone, startOfWeekKey } from "@/lib/scheduling/zoned";
import { compareWeeks, unionMinutes, type AreaChange, type TimeBucket, type WeekTime } from "./area-time";

/**
 * Phase 7.6 weekly briefing: deterministic facts about the week ahead and
 * the week behind. Everything here comes from the Phase 5 engine (free
 * time, overload, deadlines), the stored recommendations (the same
 * detectors Home uses) and the life-area aggregation. The AI summary, when
 * there is one, may only restate these facts (see briefing-ai.ts). Pure.
 */

/** From this local hour on the last day of the week, the briefing previews the next week. */
export const PREVIEW_HOUR = 17;
/** "First open of a new week": the briefing is offered on Home during its first days. */
export const OFFER_DAYS = 3;
/** Once seen on Home, it stays this long, then only Insights shows it. */
export const SHOWN_FOR_MS = 24 * 3_600_000;
const MAX_COMMITMENTS = 8;
const MAX_DEADLINES = 8;
const MAX_PROBLEMS = 4;
const MAX_ACTIONS = 3;

export type BriefingWindow = {
  /** First day of the week the briefing is about (local key). */
  weekStart: string;
  /** First day of the week it looks back on. */
  reviewStart: string;
  /** Sunday evening (last evening of the user's week): a preview of next week. */
  preview: boolean;
  /** Home offers it now (the evening before, or the first days of the week). */
  offerOnHome: boolean;
};

export function briefingWindow(now: Date, timeZone: string, todayKey: string, weekStartsOn: 0 | 1): BriefingWindow {
  const current = startOfWeekKey(todayKey, weekStartsOn);
  const lastDay = addDaysToKey(current, 6);
  const preview = todayKey === lastDay && minutesInZone(now, timeZone) >= PREVIEW_HOUR * 60;
  const weekStart = preview ? addDaysToKey(current, 7) : current;
  return {
    weekStart,
    reviewStart: addDaysToKey(weekStart, -7),
    preview,
    offerOnHome: preview || daysBetweenKeys(current, todayKey) < OFFER_DAYS,
  };
}

/** Whether Home should show the stored briefing now: offered, not dismissed, and not seen more than a day ago. */
export function showOnHome(window: BriefingWindow, row: { shownAt: string | null; dismissedAt: string | null } | null, now: Date): boolean {
  if (!window.offerOnHome) return false;
  if (!row) return true;
  if (row.dismissedAt) return false;
  return !row.shownAt || now.getTime() - Date.parse(row.shownAt) < SHOWN_FOR_MS;
}

export type BriefingDay = {
  date: string;
  /** Timed calendar commitments, not counting Whitespace sessions. */
  commitments: number;
  commitmentMinutes: number;
  sessionMinutes: number;
  /** Realistic free minutes for new work (engine). */
  freeMinutes: number;
  /** Open tasks due that day. */
  due: number;
  /** The overload detector flagged it. */
  heavy: boolean;
};

export type BriefingProblem = { recommendationId: string; kind: RecommendationKind; title: string; message: string; date: string | null };
export type BriefingAction = { recommendationId: string; actionId: string; label: string };

export type WeeklyFacts = {
  weekStart: string;
  weekEnd: string;
  reviewStart: string;
  preview: boolean;
  /** One-off fixed events this week (games, exams, appointments), in order. Repeating ones are the usual week. */
  commitments: { title: string; date: string; time: string | null; exam: boolean }[];
  moreCommitments: number;
  /** Open tasks due this week, soonest first. */
  deadlines: { taskId: string; title: string; date: string; priority: "high" | "medium" | "low" }[];
  moreDeadlines: number;
  /** Days from today (or the week's start) to its end, inside the engine's horizon. */
  days: BriefingDay[];
  /** Realistic free minutes for new work over those days. */
  capacityMinutes: number;
  /** Unscheduled work on tasks due this week. */
  workMinutes: number;
  /** Open recommendations about this week, from the shared detectors. */
  problems: BriefingProblem[];
  actions: BriefingAction[];
  /** Scheduled time per area in the reviewed week against the week before. */
  balance: AreaChange[];
  /** Whitespace sessions in the reviewed week, by what the user recorded. */
  sessions: Pick<TimeBucket, "done" | "partial" | "missed" | "unrecorded">;
  /** Nothing scheduled or due at all: show an honest empty state. */
  empty: boolean;
};

/** Kinds that are problems for the week: overload, deadline clusters, conflicts, work that won't fit, broken plans. */
const PROBLEM_KINDS: ReadonlySet<RecommendationKind> = new Set([
  "plan_broken",
  "commitment_conflict",
  "deadline_at_risk",
  "deadline_cluster",
  "overload_day",
  "overload_week",
  "exam_prep",
  "overdue",
]);

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

export function buildWeeklyFacts(input: {
  analysis: Analysis;
  window: BriefingWindow;
  /** Every open recommendation (status open), ranked. */
  recommendations: readonly Recommendation[];
  /** The reviewed week and the week before it. */
  reviewed: WeekTime;
  before: WeekTime;
}): WeeklyFacts {
  const a = input.analysis;
  const { weekStart, reviewStart, preview } = input.window;
  const weekEnd = addDaysToKey(weekStart, 6);
  const first = weekStart > a.todayKey ? weekStart : a.todayKey;
  const inWeek = (key: string | null) => !!key && key >= first && key <= weekEnd;

  const flagged = new Set(input.recommendations.filter((r) => r.kind === "overload_day" && r.target.date).map((r) => r.target.date!));
  const days: BriefingDay[] = a.days
    .filter((d) => inWeek(d.date))
    .map((d) => ({
      date: d.date,
      commitments: d.commitments.length,
      // Overlaps counted once, like Insights' daily load.
      commitmentMinutes: unionMinutes(d.commitments.map((o) => ({ start: o.start.getTime(), end: o.end.getTime() }))),
      sessionMinutes: d.blockMinutes,
      freeMinutes: dayCapacity(a, d),
      due: d.due.length,
      heavy: flagged.has(d.date),
    }));

  const oneOffs = a.days
    .filter((d) => inWeek(d.date))
    .flatMap((d) => d.commitments.filter((o) => !o.recurring && o.event.kind === "fixed").map((o) => ({ o, date: d.date })));
  const commitments = oneOffs.slice(0, MAX_COMMITMENTS).map(({ o, date }) => ({
    title: o.event.title,
    date,
    time: clockAt(o.start.toISOString(), a.timeZone),
    exam: isExam(o.event.title),
  }));

  const due = a.tasks
    .filter((t) => t.dueMs !== null && t.dueMs > a.nowMs && inWeek(t.dueDate))
    .sort((x, y) => x.dueMs! - y.dueMs! || PRIORITY_RANK[x.task.priority] - PRIORITY_RANK[y.task.priority]);

  const problems = input.recommendations
    .filter((r) => r.status === "open" && PROBLEM_KINDS.has(r.kind) && (!r.target.date || r.target.date <= weekEnd))
    .slice(0, MAX_PROBLEMS);
  const actions = problems
    .filter((r) => r.actions[0] && r.actions[0].kind !== "acknowledge")
    .slice(0, MAX_ACTIONS)
    .map((r) => ({ recommendationId: r.id, actionId: r.actions[0].id, label: r.actions[0].label }));

  const reviewedSessions = input.reviewed.totals;
  const facts: WeeklyFacts = {
    weekStart,
    weekEnd,
    reviewStart,
    preview,
    commitments,
    moreCommitments: Math.max(0, oneOffs.length - MAX_COMMITMENTS),
    deadlines: due.slice(0, MAX_DEADLINES).map((t) => ({ taskId: t.task.id, title: t.task.title, date: t.dueDate!, priority: t.task.priority })),
    moreDeadlines: Math.max(0, due.length - MAX_DEADLINES),
    days,
    capacityMinutes: days.reduce((s, d) => s + d.freeMinutes, 0),
    workMinutes: due.reduce((s, t) => s + (t.unscheduled ?? 0), 0),
    problems: problems.map((r) => ({ recommendationId: r.id, kind: r.kind, title: r.title, message: r.message, date: r.target.date })),
    actions,
    balance: compareWeeks(input.reviewed, input.before),
    sessions: {
      done: reviewedSessions.done,
      partial: reviewedSessions.partial,
      missed: reviewedSessions.missed,
      unrecorded: reviewedSessions.unrecorded,
    },
    empty: false,
  };
  facts.empty =
    !facts.commitments.length &&
    !facts.deadlines.length &&
    !facts.problems.length &&
    !facts.balance.length &&
    days.every((d) => d.commitments === 0 && d.sessionMinutes === 0);
  return facts;
}

/** The busiest day of the week ahead by scheduled time, when there is a clear one. */
export function busiestDay(f: WeeklyFacts): BriefingDay | null {
  const loads = f.days.map((d) => ({ d, load: d.commitmentMinutes + d.sessionMinutes }));
  const top = loads.sort((x, y) => y.load - x.load)[0];
  if (!top || top.load < 60) return null;
  return top.d;
}

/** Plain lines, deterministic. Shown as is when the AI is off or fails, and given to the AI as its only source. */
export function factLines(f: WeeklyFacts, todayKey: string, options: { compact?: boolean } = {}): string[] {
  const lines: string[] = [];
  const compact = options.compact ?? false;
  // Compact (Home's rail): problems first, then what's due and the load. History lives on Insights.
  if (compact) for (const p of f.problems.slice(0, 2)) lines.push(`Problem: ${p.message}`);
  const ahead = f.preview ? "next week" : "this week";
  const behind = f.preview ? "This week" : "Last week";
  const when = (k: string) => (daysBetweenKeys(todayKey, k) < 7 && daysBetweenKeys(todayKey, k) >= 0 ? dayName(k, todayKey) : shortDate(k));
  if (f.deadlines.length) {
    const list = f.deadlines.map((d) => `${d.title} (${when(d.date)}${d.priority === "high" ? ", high priority" : ""})`).join("; ");
    lines.push(`Due ${ahead}: ${list}${f.moreDeadlines ? `, and ${f.moreDeadlines} more` : ""}.`);
  } else lines.push(`Nothing is due ${ahead}.`);
  if (f.commitments.length && !compact) {
    const shown = f.commitments.slice(0, 5);
    const more = f.commitments.length - shown.length + f.moreCommitments;
    const list = shown.map((c) => `${c.title} (${when(c.date)}${c.time ? ` ${c.time}` : ""})`).join("; ");
    lines.push(`One-off events: ${list}${more ? `, and ${more} more` : ""}.`);
  }
  const heavy = f.days.filter((d) => d.heavy);
  if (heavy.length) lines.push(`Heavy ${heavy.length === 1 ? "day" : "days"}: ${heavy.map((d) => weekdayLong(d.date)).join(", ")}.`);
  else {
    const top = busiestDay(f);
    if (top) lines.push(`Busiest day: ${weekdayLong(top.date)}, about ${duration(roughly(top.commitmentMinutes + top.sessionMinutes))} scheduled.`);
  }
  if (f.days.length) {
    const work = f.workMinutes ? `About ${duration(roughly(f.workMinutes))} of work due ${ahead} still needs time` : `No unscheduled work is due ${ahead}`;
    lines.push(`${work}; about ${duration(roughly(f.capacityMinutes))} of realistic free time.`);
  }
  if (compact) return lines.slice(0, 4);
  for (const p of f.problems) lines.push(`Problem: ${p.message}`);
  const moved = f.balance.filter((b) => Math.abs(b.delta) >= 60);
  if (moved.length) {
    lines.push(
      `${behind} compared with the week before: ${moved
        .slice(0, 4)
        .map((b) => `${b.name} ${b.delta > 0 ? "up" : "down"} ${duration(roughly(Math.abs(b.delta)))}`)
        .join(", ")}.`,
    );
  }
  const s = f.sessions;
  const recorded = s.done + s.partial + s.missed;
  if (recorded + s.unrecorded > 0) {
    const parts = [s.done && `${duration(roughly(s.done))} done`, s.partial && `${duration(roughly(s.partial))} partly done`, s.missed && `${duration(roughly(s.missed))} missed`, s.unrecorded && `${duration(roughly(s.unrecorded))} not recorded`].filter(Boolean);
    lines.push(`${behind}'s work sessions: ${parts.join(", ")}.`);
  }
  return lines;
}

/** One line for a heading: "Week of Nov 23". */
export function weekLabel(f: Pick<WeeklyFacts, "weekStart">): string {
  return `Week of ${shortDate(f.weekStart)}`;
}

/** Counts used by the UI's summary row. */
export function headline(f: WeeklyFacts): string {
  const parts = [
    f.deadlines.length + f.moreDeadlines ? plural(f.deadlines.length + f.moreDeadlines, "deadline") : null,
    f.commitments.length + f.moreCommitments ? plural(f.commitments.length + f.moreCommitments, "one-off event") : null,
    f.problems.length ? plural(f.problems.length, "thing", "things") + " to sort out" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "A quiet week so far";
}

/**
 * Hash of what matters, so the cached AI summary is refreshed when the week
 * really changes (a new deadline, a new problem, a big shift), not every
 * time a minute of free time passes. FNV-1a, stable across runtimes.
 */
export function factsHash(f: WeeklyFacts): string {
  const hours = (m: number) => Math.round(m / 60);
  const key = JSON.stringify({
    w: f.weekStart,
    p: f.preview,
    c: f.commitments.map((c) => [c.title, c.date, c.time]),
    d: f.deadlines.map((d) => [d.title, d.date, d.priority]),
    h: f.days.filter((d) => d.heavy).map((d) => d.date),
    cap: hours(f.capacityMinutes),
    work: hours(f.workMinutes),
    pr: f.problems.map((p) => [p.kind, p.title]),
    b: f.balance.map((b) => [b.name, hours(b.thisWeek), hours(b.lastWeek)]),
    s: [hours(f.sessions.done), hours(f.sessions.missed)],
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** What the briefing card draws instead of sentences: chips, a work-vs-free bar, area changes and a sessions bar. */
export type BriefingVisual = {
  problems: { title: string; message: string }[];
  due: { title: string; when: string; high: boolean }[];
  moreDue: number;
  events: { title: string; when: string; exam: boolean }[];
  moreEvents: number;
  capacity: { work: number; free: number } | null;
  balance: { name: string; color: string | null; delta: number }[];
  sessions: { done: number; partial: number; missed: number; unrecorded: number } | null;
  /** "Last week" or "This week" (preview), for the history rows. */
  behind: string;
};

export function briefingVisual(f: WeeklyFacts, todayKey: string, options: { compact?: boolean } = {}): BriefingVisual {
  const compact = options.compact ?? false;
  const when = (k: string) => (daysBetweenKeys(todayKey, k) < 7 && daysBetweenKeys(todayKey, k) >= 0 ? dayName(k, todayKey) : shortDate(k));
  const s = f.sessions;
  const anySessions = s.done + s.partial + s.missed + s.unrecorded > 0;
  const dueLimit = compact ? 3 : 6;
  const eventLimit = 5;
  return {
    problems: f.problems.slice(0, compact ? 2 : 4).map((p) => ({ title: p.title, message: p.message })),
    due: f.deadlines.slice(0, dueLimit).map((d) => ({ title: d.title, when: when(d.date), high: d.priority === "high" })),
    moreDue: Math.max(0, f.deadlines.length - dueLimit) + f.moreDeadlines,
    events: compact ? [] : f.commitments.slice(0, eventLimit).map((c) => ({ title: c.title, when: `${when(c.date)}${c.time ? ` ${c.time}` : ""}`, exam: c.exam })),
    moreEvents: compact ? 0 : Math.max(0, f.commitments.length - eventLimit) + f.moreCommitments,
    capacity: f.days.length ? { work: roughly(f.workMinutes), free: roughly(f.capacityMinutes) } : null,
    balance: compact ? [] : f.balance.filter((b) => Math.abs(b.delta) >= 60).slice(0, 4).map((b) => ({ name: b.name, color: b.color, delta: b.delta })),
    sessions: compact || !anySessions ? null : { done: roughly(s.done), partial: roughly(s.partial), missed: roughly(s.missed), unrecorded: roughly(s.unrecorded) },
    behind: f.preview ? "This week" : "Last week",
  };
}
