/**
 * Time zone aware date math. Pure functions, no React or database.
 *
 * Events are stored as UTC instants. The calendar is drawn in the user's
 * profile time zone (not the browser's), so every "which day / what time"
 * question goes through these helpers. Dates are handled as "date keys"
 * (YYYY-MM-DD strings) to avoid accidental local-time conversions.
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(at: Date, timeZone: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** UTC offset of `timeZone` at `at`, in ms (local = utc + offset). */
export function timeZoneOffset(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Converts a wall-clock date and time ("HH:MM") in `timeZone` to a UTC instant. */
export function zonedToUtc(dateKey: string, time: string, timeZone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - timeZoneOffset(new Date(guess), timeZone);
  // Second pass corrects for a DST change between the guess and the answer.
  return new Date(guess - timeZoneOffset(new Date(first), timeZone));
}

/** The local date (YYYY-MM-DD) of an instant in `timeZone`. */
export function dateKeyInZone(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight of an instant in `timeZone`. */
export function minutesInZone(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" (24h) of an instant in `timeZone`. */
export function timeKeyInZone(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Local midnight of a date in `timeZone`, as a UTC instant. */
export function startOfDayInZone(dateKey: string, timeZone: string): Date {
  return zonedToUtc(dateKey, "00:00", timeZone);
}

// ---------- Date key arithmetic (calendar dates, no time zone) ----------

function keyToUtcMs(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function utcMsToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysToKey(key: string, days: number): string {
  return utcMsToKey(keyToUtcMs(key) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetweenKeys(a: string, b: string): number {
  return Math.round((keyToUtcMs(b) - keyToUtcMs(a)) / DAY_MS);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekdayOfKey(key: string): number {
  const d = new Date(keyToUtcMs(key)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** First day of the week containing `key`. weekStartsOn: 0 = Sunday, 1 = Monday. */
export function startOfWeekKey(key: string, weekStartsOn: 0 | 1 = 1): string {
  const jsDay = new Date(keyToUtcMs(key)).getUTCDay();
  const diff = (jsDay - weekStartsOn + 7) % 7;
  return addDaysToKey(key, -diff);
}

export function weekKeys(key: string, weekStartsOn: 0 | 1 = 1): string[] {
  const start = startOfWeekKey(key, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
}

export function startOfMonthKey(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function addMonthsToKey(key: string, months: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/** Six full weeks covering the month that contains `key`. */
export function monthGridKeys(key: string, weekStartsOn: 0 | 1 = 1): string[] {
  const first = startOfWeekKey(startOfMonthKey(key), weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => addDaysToKey(first, i));
}

// ---------- Formatting ----------

/** Formats a date key without any time zone shift. */
export function formatDateKey(key: string, options: Intl.DateTimeFormatOptions, locale?: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: "UTC" });
}

export function formatTimeInZone(at: Date, timeZone: string, locale?: string): string {
  return at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
}

/** "3 PM", "3:30 PM" style label for minutes since midnight. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "AM" : "PM";
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Same wall-clock date and time, read in another zone. "9:00 AM Sat in UTC"
 * becomes "9:00 AM Sat in Los Angeles". Used to repair times that were saved
 * while the profile was still on the UTC default.
 */
export function rezoneWallClock(iso: string, fromZone: string, toZone: string): string {
  const at = new Date(iso);
  return zonedToUtc(dateKeyInZone(at, fromZone), timeKeyInZone(at, fromZone), toZone).toISOString();
}
