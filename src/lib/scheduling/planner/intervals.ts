/**
 * Half-open time intervals [start, end) in epoch milliseconds.
 * Pure helpers used by the planner. Inputs need not be sorted.
 */

export type Interval = { start: number; end: number };

export const MINUTE = 60_000;

export function minutesOf(i: Interval): number {
  return Math.round((i.end - i.start) / MINUTE);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorted, non-overlapping union. Touching intervals are joined. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** `base` minus every interval in `cut`. */
export function subtractIntervals(base: readonly Interval[], cut: readonly Interval[]): Interval[] {
  const cuts = mergeIntervals(cut);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const c of cuts) {
      if (c.end <= cursor) continue;
      if (c.start >= b.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

/** Parts of `list` inside `clip`. */
export function clipIntervals(list: readonly Interval[], clip: Interval): Interval[] {
  return list
    .map((i) => ({ start: Math.max(i.start, clip.start), end: Math.min(i.end, clip.end) }))
    .filter((i) => i.end > i.start);
}

export function totalMinutes(list: readonly Interval[]): number {
  return mergeIntervals(list).reduce((sum, i) => sum + minutesOf(i), 0);
}

/** Rounds up to the next multiple of `stepMinutes` (UTC based; all real zones are 15-minute aligned). */
export function ceilTo(ms: number, stepMinutes: number): number {
  const step = stepMinutes * MINUTE;
  return Math.ceil(ms / step) * step;
}
