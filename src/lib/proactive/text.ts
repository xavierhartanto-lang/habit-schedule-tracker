import { clockLabel, shortDate } from "@/lib/assistant/dates";
import { addDaysToKey, daysBetweenKeys, formatDateKey, minutesInZone, timeKeyInZone, dateKeyInZone } from "@/lib/scheduling/zoned";

/** User-facing wording for proactive recommendations. Always in the user's time zone. Pure. */

export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} min`;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** Rounded so it doesn't sound falsely precise: 5 min steps under an hour, 15 under three hours, then 30. */
export function roughly(minutes: number): number {
  const step = minutes < 60 ? 5 : minutes < 180 ? 15 : 30;
  return Math.max(step === 5 ? 5 : 0, Math.round(minutes / step) * step);
}

/** "about 2 h". */
export function about(minutes: number): string {
  return `about ${duration(roughly(minutes))}`;
}

export function weekdayLong(key: string): string {
  return formatDateKey(key, { weekday: "long" }, "en-US");
}

/** "today", "tomorrow", "Friday", "Fri, Nov 27" (a week or more away), "yesterday", "on Mon, Nov 16". */
export function dayPhrase(key: string, todayKey: string): string {
  const d = daysBetweenKeys(todayKey, key);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 1 && d < 7) return weekdayLong(key);
  return shortDate(key);
}

/** "Today", "Tomorrow", "Friday" for a day heading. */
export function dayName(key: string, todayKey: string): string {
  const p = dayPhrase(key, todayKey);
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** "due tomorrow", "due Friday at 9 AM". A due time of 23:59 means "end of day" and is left out. */
export function duePhrase(dueAt: string, timeZone: string, todayKey: string): string {
  const at = new Date(dueAt);
  const key = dateKeyInZone(at, timeZone);
  const time = timeKeyInZone(at, timeZone);
  return `due ${dayPhrase(key, todayKey)}${time === "23:59" ? "" : ` at ${clockLabel(time)}`}`;
}

export function clockAt(iso: string, timeZone: string): string {
  return clockLabel(timeKeyInZone(new Date(iso), timeZone));
}

/** "this morning" / "this afternoon" / "this evening" for an instant today. */
export function periodPhrase(iso: string, timeZone: string): string {
  const hour = Math.floor(minutesInZone(new Date(iso), timeZone) / 60);
  if (hour < 12) return "this morning";
  if (hour < 17) return "this afternoon";
  return "this evening";
}

export function quote(title: string): string {
  return `“${title}”`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function dayBefore(key: string): string {
  return addDaysToKey(key, -1);
}

export { shortDate };
