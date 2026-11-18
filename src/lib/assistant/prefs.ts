import type { SchedulingPreferences } from "@/lib/scheduling/planner";
import type { Payload } from "./ops";

/**
 * Applies an "update scheduling preferences" change to the saved
 * preferences. Pure: the caller validates the result with the engine's
 * schema when saving.
 */
export function applyPreferenceChanges(
  prefs: SchedulingPreferences,
  change: Payload<"update_preferences">,
): SchedulingPreferences {
  const next: SchedulingPreferences = structuredClone(prefs);
  if (change.dayStart || change.dayEnd) {
    for (const day of Object.keys(next.workingHours) as (keyof SchedulingPreferences["workingHours"])[]) {
      let ranges = next.workingHours[day];
      if (!ranges.length) continue;
      // "Nothing before 4pm" only narrows: it never opens up school hours.
      if (change.dayStart) {
        ranges = ranges
          .map((r) => ({ start: r.start < change.dayStart! ? change.dayStart! : r.start, end: r.end }))
          .filter((r) => r.start < r.end);
      }
      // "Nothing after 9pm" / "I can work until 11": sets the end of the day either way.
      if (change.dayEnd && ranges.length) {
        ranges = ranges.filter((r) => r.start < change.dayEnd!);
        if (ranges.length) ranges[ranges.length - 1] = { ...ranges[ranges.length - 1], end: change.dayEnd };
      }
      next.workingHours[day] = ranges;
    }
  }
  if (change.maxSessionMinutes) {
    next.maxSessionMinutes = change.maxSessionMinutes;
    if (next.minSessionMinutes > next.maxSessionMinutes) next.minSessionMinutes = next.maxSessionMinutes;
  }
  if (change.bufferMinutes !== null) next.bufferMinutes = change.bufferMinutes;
  if (change.protectedTime) {
    const label = change.protectedTime.label.toLowerCase();
    next.protectedTimes = [
      ...next.protectedTimes.filter((p) => p.label.toLowerCase() !== label),
      change.protectedTime,
    ];
  }
  return next;
}
