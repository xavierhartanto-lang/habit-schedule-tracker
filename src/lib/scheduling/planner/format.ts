import { formatDuration } from "../time";
import { dateKeyInZone, formatDateKey, minutesInZone } from "../zoned";
import { formatMinutes } from "../zoned";

/** User-facing labels for explanations. Always in the user's time zone. */

export function timeLabel(ms: number, timeZone: string): string {
  return formatMinutes(minutesInZone(new Date(ms), timeZone));
}

export function weekdayLabel(date: string): string {
  return formatDateKey(date, { weekday: "long" }, "en-US");
}

export function dateLabel(ms: number, timeZone: string): string {
  return formatDateKey(dateKeyInZone(new Date(ms), timeZone), { weekday: "short", month: "short", day: "numeric" }, "en-US");
}

export function durationLabel(minutes: number): string {
  return formatDuration(minutes).replace(/^(\d+)m$/, "$1 min");
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
