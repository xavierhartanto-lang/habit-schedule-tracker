import type { Commitment, Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";
import {
  addDaysToKey,
  dateKeyInZone,
  daysBetweenKeys,
  isDateKey,
  isValidTimeZone,
  isoWeekdayOfKey,
  startOfWeekKey,
  timeKeyInZone,
  zonedToUtc,
} from "./zoned";

/**
 * Repeating events. A practical subset of RFC 5545 RRULE:
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (weekly), COUNT, UNTIL.
 * Occurrences repeat at the same local time in the event's time zone, so a
 * 4 PM practice stays at 4 PM across daylight saving changes.
 * Pure and deterministic: no database, no LLM.
 */

export type RepeatFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Recurrence = {
  freq: RepeatFrequency;
  interval: number;
  /** Weekly only. Defaults to the weekday of the first occurrence. */
  byDay?: Weekday[];
  /** Stop after this many occurrences. */
  count?: number;
  /** Last date (YYYY-MM-DD, inclusive, local to the event). */
  until?: string;
};

const FREQS: readonly RepeatFrequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
export const MAX_INTERVAL = 99;
export const MAX_COUNT = 730;

/** Parses the subset above. Returns null for anything it cannot honor exactly. */
export function parseRRule(rule: string | null | undefined): Recurrence | null {
  if (!rule) return null;
  const parts = new Map<string, string>();
  for (const piece of rule.replace(/^RRULE:/, "").split(";")) {
    const [k, v] = piece.split("=");
    if (!k || v === undefined) return null;
    parts.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = parts.get("FREQ") as RepeatFrequency | undefined;
  if (!freq || !FREQS.includes(freq)) return null;

  const out: Recurrence = { freq, interval: 1 };
  for (const [k, v] of parts) {
    switch (k) {
      case "FREQ":
      case "WKST":
        break;
      case "INTERVAL": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL) return null;
        out.interval = n;
        break;
      }
      case "COUNT": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return null;
        out.count = n;
        break;
      }
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(v);
        if (!m) return null;
        const key = `${m[1]}-${m[2]}-${m[3]}`;
        if (!isDateKey(key)) return null;
        out.until = key;
        break;
      }
      case "BYDAY": {
        if (freq !== "WEEKLY") return null;
        const days = v.split(",").map((d) => d.toLowerCase());
        if (!days.length || days.some((d) => !(WEEKDAYS as readonly string[]).includes(d))) return null;
        out.byDay = WEEKDAYS.filter((d) => days.includes(d));
        break;
      }
      default:
        // BYMONTHDAY, BYSETPOS… are not supported. Refuse rather than guess.
        return null;
    }
  }
  if (out.count && out.until) return null;
  return out;
}

export function buildRRule(r: Recurrence): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "WEEKLY" && r.byDay?.length) {
    parts.push(`BYDAY=${r.byDay.map((d) => d.toUpperCase()).join(",")}`);
  }
  if (r.count) parts.push(`COUNT=${r.count}`);
  else if (r.until) parts.push(`UNTIL=${r.until.replaceAll("-", "")}`);
  return parts.join(";");
}

const DAY_NAMES: Record<Weekday, string> = {
  mo: "Mon",
  tu: "Tue",
  we: "Wed",
  th: "Thu",
  fr: "Fri",
  sa: "Sat",
  su: "Sun",
};

/** "Every week on Mon, Wed", "Every 2 days, 10 times". */
export function describeRecurrence(r: Recurrence): string {
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[r.freq];
  let text = r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
  if (r.freq === "DAILY" && r.interval === 1) text = "Daily";
  if (r.freq === "WEEKLY" && r.byDay?.length) {
    const isWeekdays = r.byDay.length === 5 && !r.byDay.includes("sa") && !r.byDay.includes("su");
    text += isWeekdays && r.interval === 1 ? " on weekdays" : ` on ${r.byDay.map((d) => DAY_NAMES[d]).join(", ")}`;
  }
  if (r.count) text += `, ${r.count} time${r.count === 1 ? "" : "s"}`;
  if (r.until) {
    const until = new Date(`${r.until}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    text += `, until ${until}`;
  }
  return text;
}

export function weekdayOfKey(key: string): Weekday {
  return WEEKDAYS[isoWeekdayOfKey(key) - 1];
}

// ---------- Occurrences ----------

export type Occurrence = {
  /** Unique per occurrence: `${eventId}:${date}`. */
  key: string;
  event: Commitment;
  start: Date;
  end: Date;
  /** Local start date (in the event's time zone) of this occurrence. */
  date: string;
  allDay: boolean;
  recurring: boolean;
};

const MAX_SCAN_DAYS = 366 * 30;

function matches(r: Recurrence, startKey: string, key: string): boolean {
  const diff = daysBetweenKeys(startKey, key);
  if (diff < 0) return false;
  switch (r.freq) {
    case "DAILY":
      return diff % r.interval === 0;
    case "WEEKLY": {
      const days = r.byDay?.length ? r.byDay : [weekdayOfKey(startKey)];
      if (!days.includes(weekdayOfKey(key))) return false;
      const weeks = daysBetweenKeys(startOfWeekKey(startKey, 1), startOfWeekKey(key, 1)) / 7;
      return weeks % r.interval === 0;
    }
    case "MONTHLY": {
      if (key.slice(8) !== startKey.slice(8)) return false;
      const months =
        (Number(key.slice(0, 4)) - Number(startKey.slice(0, 4))) * 12 +
        (Number(key.slice(5, 7)) - Number(startKey.slice(5, 7)));
      return months % r.interval === 0;
    }
    case "YEARLY": {
      if (key.slice(5) !== startKey.slice(5)) return false;
      return (Number(key.slice(0, 4)) - Number(startKey.slice(0, 4))) % r.interval === 0;
    }
  }
}

/**
 * Every occurrence of `event` that overlaps [from, to).
 * Events without a start time (unplaced flexible work) have none.
 */
export function expandEvent(event: Commitment, from: Date, to: Date, defaultTimeZone: string): Occurrence[] {
  if (!event.startsAt || !event.endsAt) return [];
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  if (!(end > start)) return [];
  const allDay = event.allDay ?? false;
  const tz = isValidTimeZone(event.timezone) ? event.timezone : defaultTimeZone;
  const startKey = dateKeyInZone(start, tz);
  const rule = parseRRule(event.recurrenceRule);

  if (!rule) {
    if (end <= from || start >= to) return [];
    return [{ key: `${event.id}:${startKey}`, event, start, end, date: startKey, allDay, recurring: false }];
  }

  const exceptions = new Set(event.recurrenceExceptions ?? []);
  const startTime = timeKeyInZone(start, tz);
  const durationMs = end.getTime() - start.getTime();
  const spanDays = allDay ? Math.max(1, daysBetweenKeys(startKey, dateKeyInZone(end, tz))) : 0;
  const lastKey = addDaysToKey(dateKeyInZone(to, tz), 1);
  const lookBack = Math.ceil(durationMs / 86_400_000) + 1;

  // Without COUNT, matching depends only on the date, so skip ahead.
  let key = startKey;
  if (!rule.count) {
    const windowStart = addDaysToKey(dateKeyInZone(from, tz), -lookBack);
    if (daysBetweenKeys(key, windowStart) > 0) key = windowStart;
  }

  const out: Occurrence[] = [];
  let seen = 0;
  for (let i = 0; i < MAX_SCAN_DAYS && daysBetweenKeys(key, lastKey) >= 0; i++, key = addDaysToKey(key, 1)) {
    if (rule.until && key > rule.until) break;
    if (!matches(rule, startKey, key)) continue;
    seen++;
    if (rule.count && seen > rule.count) break;
    if (exceptions.has(key)) continue;

    const occStart = allDay ? zonedToUtc(key, "00:00", tz) : zonedToUtc(key, startTime, tz);
    const occEnd = allDay
      ? zonedToUtc(addDaysToKey(key, spanDays), "00:00", tz)
      : new Date(occStart.getTime() + durationMs);
    if (occEnd <= from || occStart >= to) continue;
    out.push({ key: `${event.id}:${key}`, event, start: occStart, end: occEnd, date: key, allDay, recurring: true });
  }
  return out;
}

export function expandEvents(
  events: readonly Commitment[],
  from: Date,
  to: Date,
  defaultTimeZone: string,
): Occurrence[] {
  return events
    .flatMap((e) => expandEvent(e, from, to, defaultTimeZone))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
}

// ---------- Conflicts ----------

/**
 * Timed occurrences that overlap another timed occurrence. All-day events
 * never conflict. Returns, per occurrence key, the titles it overlaps.
 */
export function findConflicts(occurrences: readonly Occurrence[]): Map<string, string[]> {
  const timed = occurrences
    .filter((o) => !o.allDay)
    .slice()
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out = new Map<string, string[]>();
  const add = (o: Occurrence, other: Occurrence) => {
    const list = out.get(o.key) ?? [];
    if (!list.includes(other.event.title)) list.push(other.event.title);
    out.set(o.key, list);
  };
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) {
      add(timed[i], timed[j]);
      add(timed[j], timed[i]);
    }
  }
  return out;
}

/** Occurrences in `occurrences` that overlap [start, end), ignoring `excludeEventId`. */
export function overlapping(
  occurrences: readonly Occurrence[],
  start: Date,
  end: Date,
  excludeKey?: (o: Occurrence) => boolean,
): Occurrence[] {
  return occurrences.filter(
    (o) => !o.allDay && o.start < end && o.end > start && !(excludeKey && excludeKey(o)),
  );
}
