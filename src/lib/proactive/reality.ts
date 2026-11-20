import { capacityBefore, HORIZON_DAYS, type Analysis } from "./analyze";
import { about, dayPhrase, duration, quote, roughly } from "./text";
import { dateKeyInZone } from "@/lib/scheduling/zoned";

/**
 * Phase 7.3 reality check: when a task is added, does its work actually
 * fit before it's due? Compares the realistic free time before the due
 * date (Phase 5 capacity: working hours, buffers, protected time, the share
 * kept open, the daily limit) with this task's work plus the unscheduled
 * work of every other open task due by then. Deterministic. Pure.
 */

export type RealityStatus = "fits" | "tight" | "over";

export type RealityCheck = {
  status: RealityStatus;
  /** Realistic free minutes before the due time. */
  free: number;
  /** Unscheduled minutes other open tasks due by then still need. */
  competing: number;
  need: number;
  /** For the approval card. Null when it fits comfortably. */
  warning: string | null;
  /** For the reply model: the facts and one concrete recommendation. */
  note: string;
};

/** Less slack than this (or a quarter of the work) counts as tight. */
const TIGHT_SLACK_MINUTES = 60;

export function realityCheck(a: Analysis, task: { title: string; dueMs: number; minutes: number }): RealityCheck | null {
  if (task.dueMs <= a.nowMs || task.minutes <= 0) return null;
  // Capacity is only known inside the analysis horizon.
  if (task.dueMs > a.nowMs + HORIZON_DAYS * 86_400_000) return null;
  const free = capacityBefore(a, task.dueMs);
  const others = a.tasks.filter((t) => t.dueMs !== null && t.dueMs > a.nowMs && t.dueMs <= task.dueMs && (t.unscheduled ?? 0) > 0);
  const competing = others.reduce((s, t) => s + (t.unscheduled ?? 0), 0);
  const need = task.minutes;
  const left = free - competing;
  const due = dayPhrase(dateKeyInZone(new Date(task.dueMs), a.timeZone), a.todayKey);
  const otherWork = competing > 0 ? `, and other tasks due by then already need ${about(competing)}` : "";

  if (left >= need + Math.max(TIGHT_SLACK_MINUTES, need / 4)) {
    return {
      status: "fits",
      free,
      competing,
      need,
      warning: null,
      note: `Reality check for ${quote(task.title)}: it fits. About ${duration(roughly(free))} of realistic free time before it's due ${due}${otherWork}.`,
    };
  }
  if (left >= need) {
    return {
      status: "tight",
      free,
      competing,
      need,
      warning: `Tight: ${about(free)} free before ${due}${otherWork}.`,
      note: `Reality check for ${quote(task.title)}: it fits, but only just (${about(free)} free before ${due}${otherWork}). Recommend starting soon rather than later.`,
    };
  }
  // Doesn't fit. Recommend one concrete fix: make room by lowering a less important task, else book what fits now.
  const order = { high: 0, medium: 1, low: 2 } as const;
  const yielder = others
    .filter((t) => order[t.task.priority] > 0)
    .sort((x, y) => order[y.task.priority] - order[x.task.priority] || (y.dueMs ?? 0) - (x.dueMs ?? 0))[0];
  const fix = yielder
    ? `Recommend booking what fits now and moving ${quote(yielder.task.title)} (${yielder.task.priority} priority) later to make room.`
    : `Recommend booking what fits now and asking for a later due date if possible.`;
  return {
    status: "over",
    free,
    competing,
    need,
    warning: `Doesn't fit: it needs ${about(need)}, and only ${about(Math.max(0, left))} is free before ${due} after other work due by then.`,
    note: `Reality check for ${quote(task.title)}: it doesn't fit. Needs ${about(need)}; ${about(free)} free before ${due}${otherWork}. ${fix}`,
  };
}
