import type { Commitment } from "@/lib/domain/types";
import { rankTasks } from "./brief";
import { type Analysis, type TaskLoad } from "./analyze";
import { about, clockAt, duration, quote, roughly } from "./text";

/**
 * Phase 7.2 "Now / Next": what to do with the time right in front of the
 * user. Deterministic, no AI:
 *
 *   - the current free window comes from the Phase 4 free-time engine
 *     (working hours, buffers, protected time) via the Phase 5 analysis;
 *   - the task comes from the Phase 5 focus ranking, in order;
 *   - a task is only suggested when its remaining work fits the window, or
 *     when it is multi-session work anyway (longer than one session).
 *
 * It never invents a smaller task or a duration. When nothing fits, it says
 * how long the window is and suggests nothing. Pure.
 */

/** The window must start within this long to count as "now". */
const NOW_TOLERANCE_MINUTES = 30;
/** Shorter windows aren't worth a suggestion. */
const MIN_WINDOW_MINUTES = 20;
/** A window this long is worth starting multi-session work in (and never less than the user's minimum session). */
const PROGRESS_MIN_WINDOW = 45;
/** A task without an estimate is only suggested for a window at least this long. */
const UNKNOWN_LENGTH_MIN_WINDOW = 45;

export type NowTask = {
  taskId: string;
  title: string;
  /** Work left that isn't booked elsewhere. Null without an estimate. */
  minutes: number | null;
  /** whole: fits in the window. progress: multi-session work, this window is one session. */
  fit: "whole" | "progress";
  /** Why it was picked: the ranking's reason ("Due tomorrow"), or null for an undated task. */
  why: string | null;
};

export type NowNext = {
  state: "free" | "session";
  /** ISO: when the window (or session) ends. */
  until: string;
  /** Minutes left in the window (or session). */
  minutes: number;
  /** The next commitment right after the window, if it ends the window. */
  next: { title: string; start: string } | null;
  task: NowTask | null;
  message: string;
};

function minutesBetween(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) / 60_000));
}

function need(t: TaskLoad): number | null {
  return t.unscheduled;
}

/** Ranked tasks first, then any other open task with an estimate, high priority first. */
function candidates(a: Analysis): { t: TaskLoad; why: string | null }[] {
  const ranked = rankTasks(a).map((r) => ({ t: r.t, why: r.why }));
  const seen = new Set(ranked.map((r) => r.t.task.id));
  const order = { high: 0, medium: 1, low: 2 } as const;
  const rest = a.tasks
    .filter((t) => !seen.has(t.task.id) && t.estimate !== null && (t.dueMs === null || t.dueMs > a.nowMs))
    .sort((x, y) => order[x.task.priority] - order[y.task.priority] || (x.dueMs ?? Infinity) - (y.dueMs ?? Infinity) || x.task.id.localeCompare(y.task.id))
    .map((t) => ({ t, why: null }));
  return [...ranked, ...rest];
}

export function pickTask(a: Analysis, windowMinutes: number): NowTask | null {
  for (const { t, why } of candidates(a)) {
    const left = need(t);
    if (left === 0) continue; // its time is already booked
    if (left === null) {
      if (windowMinutes >= UNKNOWN_LENGTH_MIN_WINDOW) return { taskId: t.task.id, title: t.task.title, minutes: null, fit: "progress", why };
      continue;
    }
    if (left <= windowMinutes) return { taskId: t.task.id, title: t.task.title, minutes: left, fit: "whole", why };
    // Bigger than one sitting anyway: this window is a real session of it.
    if (left > a.preferences.maxSessionMinutes && windowMinutes >= Math.max(a.preferences.minSessionMinutes, PROGRESS_MIN_WINDOW)) {
      return { taskId: t.task.id, title: t.task.title, minutes: left, fit: "progress", why };
    }
  }
  return null;
}

function nextAfter(a: Analysis, endMs: number): { title: string; start: string } | null {
  const today = a.days[0];
  if (!today) return null;
  const starts: { title: string; start: number }[] = [
    ...today.commitments.map((o) => ({ title: o.event.title, start: o.start.getTime() })),
    ...today.blocks.map((b) => ({ title: b.title, start: Date.parse(b.startsAt!) })),
  ].filter((x) => x.start >= endMs - 60_000);
  starts.sort((x, y) => x.start - y.start);
  const first = starts[0];
  // Only when it is what ends the window (buffers sit between them).
  if (!first || first.start - endMs > (a.preferences.bufferMinutes + 5) * 60_000) return null;
  return { title: first.title, start: new Date(first.start).toISOString() };
}

export function nowNext(a: Analysis): NowNext | null {
  const tz = a.timeZone;
  const today = a.days[0];
  if (!today) return null;

  // In a Whitespace session right now: the plan already says what to do.
  const live: Commitment | undefined = today.blocks.find((b) => Date.parse(b.startsAt!) <= a.nowMs && Date.parse(b.endsAt!) > a.nowMs);
  if (live) {
    const minutes = minutesBetween(a.nowMs, Date.parse(live.endsAt!));
    return {
      state: "session",
      until: live.endsAt!,
      minutes,
      next: null,
      task: null,
      message: `Now: ${live.title}, until ${clockAt(live.endsAt!, tz)}.`,
    };
  }

  const slot = today.slots[0];
  if (!slot) return null;
  const startMs = Date.parse(slot.start);
  const endMs = Date.parse(slot.end);
  if (startMs - a.nowMs > NOW_TOLERANCE_MINUTES * 60_000) return null;
  const minutes = minutesBetween(Math.max(a.nowMs, startMs), endMs);
  if (minutes < MIN_WINDOW_MINUTES) return null;

  const next = nextAfter(a, endMs);
  const task = pickTask(a, minutes);
  const free = next ? `Free until ${next.title} at ${clockAt(next.start, tz)}` : `Free until ${clockAt(slot.end, tz)}`;
  let message: string;
  if (!task) message = `${free} (${duration(roughly(minutes))}).`;
  else if (task.fit === "whole") message = `${free}. Enough time for ${quote(task.title)}${task.minutes ? ` (${about(task.minutes)})` : ""}.`;
  else message = `${free} (${duration(roughly(minutes))}). A good window to make progress on ${quote(task.title)}${task.minutes ? `, ${about(task.minutes)} left` : ""}.`;

  return { state: "free", until: slot.end, minutes, next, task, message };
}
