import { capacityBefore, type Analysis, type TaskLoad } from "./analyze";
import { dayPhrase, quote } from "./text";
import { addDaysToKey, startOfDayInZone } from "@/lib/scheduling/zoned";

/**
 * Phase 7.5 "I'm behind": one recovery plan instead of a list of problems.
 * Overdue work and work due within the window, in the order it matters
 * (overdue first, then soonest due, higher priority first). Each task is kept
 * while its work still fits the realistic free time before its deadline,
 * counting what was kept before it. What doesn't fit is left out with a plain
 * reason, lowest priority first, so the plan always works. Deterministic. Pure.
 */

export const CATCH_UP_DAYS = 7;
/** Overdue work is planned within this many days (its due date isn't changed). */
export const OVERDUE_GRACE_DAYS = 3;

export type CatchUpKeep = { t: TaskLoad; minutes: number; deadlineMs: number };
export type CatchUpLeftOut = { taskId: string; title: string; reason: string };
export type CatchUp = {
  keep: CatchUpKeep[];
  leftOut: CatchUpLeftOut[];
  /** Work that needs time in the window, in minutes. */
  need: number;
  /** Realistic free minutes in the window. */
  capacity: number;
  /** Overdue work, or work that doesn't fit before it's due. */
  behind: boolean;
  /** One sentence for the reply model: the plan and the recommendation. */
  summary: string;
};

const ORDER = { high: 0, medium: 1, low: 2 } as const;

export function catchUpPlan(a: Analysis, days = CATCH_UP_DAYS): CatchUp {
  const end = startOfDayInZone(addDaysToKey(a.todayKey, days + 1), a.timeZone).getTime();
  const grace = startOfDayInZone(addDaysToKey(a.todayKey, OVERDUE_GRACE_DAYS + 1), a.timeZone).getTime();
  const work = a.tasks
    .filter((t) => (t.unscheduled ?? 0) >= 15 && t.dueMs !== null && t.dueMs < end)
    .filter((t) => t.dueMs! > a.nowMs || t.task.priority !== "low")
    .map((t) => ({ t, overdue: t.dueMs! <= a.nowMs, deadlineMs: t.dueMs! <= a.nowMs ? grace : t.dueMs! }))
    .sort(
      (x, y) =>
        Number(y.overdue) - Number(x.overdue) ||
        x.deadlineMs - y.deadlineMs ||
        ORDER[x.t.task.priority] - ORDER[y.t.task.priority] ||
        x.t.task.id.localeCompare(y.t.task.id),
    );

  const need = work.reduce((s, w) => s + (w.t.unscheduled ?? 0), 0);
  const capacity = capacityBefore(a, end);
  const overdue = work.some((w) => w.overdue);

  // Keep in order while each deadline still has room for everything kept up to it.
  // When something doesn't fit, the lowest-priority kept work with a later
  // deadline is let go first, never a more important task.
  let keep: (typeof work)[number][] = [];
  const dropped: (typeof work)[number][] = [];
  const fits = (list: typeof work) => {
    let used = 0;
    for (const w of [...list].sort((x, y) => x.deadlineMs - y.deadlineMs)) {
      used += w.t.unscheduled ?? 0;
      if (used > capacityBefore(a, w.deadlineMs) + 15) return false;
    }
    return true;
  };
  for (const w of work) {
    const next = [...keep, w];
    if (fits(next)) {
      keep = next;
      continue;
    }
    // Make room by letting go of less important work, lowest priority first.
    const yielders = keep
      .filter((k) => ORDER[k.t.task.priority] > ORDER[w.t.task.priority])
      .sort((x, y) => ORDER[y.t.task.priority] - ORDER[x.t.task.priority] || y.deadlineMs - x.deadlineMs);
    let trial = next;
    const letGo: typeof work = [];
    for (const y of yielders) {
      if (fits(trial)) break;
      trial = trial.filter((k) => k !== y);
      letGo.push(y);
    }
    if (fits(trial)) {
      keep = trial;
      dropped.push(...letGo);
    } else dropped.push(w);
  }

  const leftOut: CatchUpLeftOut[] = dropped.map(({ t, overdue: late }) => ({
    taskId: t.task.id,
    title: t.task.title,
    reason: late
      ? `${capitalize(t.task.priority)} priority and already late. I'd talk to whoever set it, or do it after the rest.`
      : `${capitalize(t.task.priority)} priority, due ${dayPhrase(t.dueDate!, a.todayKey)}. There isn't room for it before then without dropping something more important.`,
  }));
  const behind = overdue || dropped.length > 0 || work.some((w) => (w.t.unscheduled ?? 0) > capacityBefore(a, w.deadlineMs));

  const summary = !work.length
    ? "Nothing overdue or due in the next week still needs time. The user is not behind on tasks."
    : dropped.length
      ? `Catch-up plan: sessions for ${keep.length} task${keep.length === 1 ? "" : "s"} are on the card, most urgent first. ${dropped.map((d) => quote(d.t.task.title)).join(", ")} ${dropped.length === 1 ? "doesn't" : "don't"} fit this week; recommend letting ${dropped.length === 1 ? "it" : "them"} wait (or asking for more time), not squeezing it in.`
      : `Catch-up plan: everything overdue or due this week fits. Sessions for ${keep.length} task${keep.length === 1 ? "" : "s"} are on the card, most urgent first.`;

  return {
    keep: keep.map((w) => ({ t: w.t, minutes: w.t.unscheduled ?? 0, deadlineMs: w.deadlineMs })),
    leftOut,
    need,
    capacity,
    behind,
    summary,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
