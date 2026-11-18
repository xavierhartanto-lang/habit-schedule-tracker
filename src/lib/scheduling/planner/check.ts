import { dateKeyInZone } from "../zoned";
import { buildContext } from "./context";
import { durationLabel, timeLabel } from "./format";
import { MINUTE, clipIntervals, overlaps, totalMinutes } from "./intervals";
import type { FreeSlot, PlacementCheck, PlacementConflict, PlacementWarning, ScheduleBase } from "./types";

/**
 * Re-checks proposed (or user-edited) sessions against the calendar as
 * it is now. Call it at approval time with freshly loaded events, so a
 * change made after the plan was generated can't cause a double booking.
 *
 * Hard conflicts (ok: false): overlaps an event, a busy block, or another
 * placement in the same list. Soft warnings: in the past, outside working
 * hours, inside protected time, or closer than the buffer to an event.
 */
export function checkPlacements(
  input: ScheduleBase,
  placements: readonly { id: string; start: string; end: string; title?: string }[],
): PlacementCheck {
  const ctx = buildContext(input);
  const tz = ctx.timeZone;
  const parsed = placements.map((p) => ({ ...p, s: Date.parse(p.start), e: Date.parse(p.end) }));

  const results = parsed.map((p, i) => {
    const conflicts: PlacementConflict[] = [];
    const warnings: PlacementWarning[] = [];
    if (Number.isNaN(p.s) || Number.isNaN(p.e) || p.e <= p.s) {
      conflicts.push({ kind: "invalid", title: p.title ?? "Session", start: p.start, end: p.end });
      return { id: p.id, ok: false, conflicts, warnings };
    }
    const span = { start: p.s, end: p.e };

    for (const b of ctx.busy) {
      if (overlaps(b, span)) {
        conflicts.push({ kind: b.kind, title: b.title, start: iso(b.start), end: iso(b.end) });
      }
    }
    parsed.forEach((o, j) => {
      if (j === i || Number.isNaN(o.s) || Number.isNaN(o.e) || o.e <= o.s) return;
      if (overlaps({ start: o.s, end: o.e }, span)) {
        conflicts.push({ kind: "placement", title: o.title ?? "Another session", start: o.start, end: o.end });
      }
    });

    if (p.s < ctx.now) warnings.push({ kind: "in_past", text: "This time has already started or passed." });
    const date = dateKeyInZone(new Date(p.s), tz);
    const day = ctx.days.find((d) => d.date === date);
    const inside = day ? totalMinutes(day.working.flatMap((w) => clipIntervals([span], w))) : 0;
    if (day && inside * MINUTE < p.e - p.s) {
      warnings.push({ kind: "outside_working_hours", text: "Outside the hours you usually work." });
    }
    for (const pr of ctx.protectedTimes) {
      if (overlaps(pr, span)) {
        warnings.push({ kind: "protected_time", text: `Overlaps your protected time (${pr.label}).` });
        break;
      }
    }
    if (ctx.buffer > 0 && !conflicts.length) {
      const tight = ctx.busy.find((b) => overlaps({ start: b.start - ctx.buffer, end: b.end + ctx.buffer }, span));
      if (tight) {
        warnings.push({
          kind: "buffer",
          text: `Less than ${durationLabel(ctx.preferences.bufferMinutes)} from ${tight.title} at ${timeLabel(tight.start, tz)}.`,
        });
      }
    }
    return { id: p.id, ok: conflicts.length === 0, conflicts, warnings };
  });

  return { ok: results.every((r) => r.ok), results };
}

/**
 * Genuinely free stretches in working hours: after buffers around events
 * and protected time, never before now. Does not apply the daily cap.
 */
export function findFreeTime(input: ScheduleBase, options: { minMinutes?: number } = {}): FreeSlot[] {
  const ctx = buildContext(input);
  const min = Math.max(options.minMinutes ?? 15, 1);
  return ctx.days.flatMap((d) =>
    d.free
      .map((f) => ({ date: d.date, start: iso(f.start), end: iso(f.end), minutes: Math.round((f.end - f.start) / MINUTE) }))
      .filter((f) => f.minutes >= min),
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
