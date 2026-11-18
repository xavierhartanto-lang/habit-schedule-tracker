import { WEEKDAYS, type Commitment, type ContextAttributes, type Weekday } from "@/lib/domain/types";

/**
 * Pure helpers for showing and editing saved facts.
 * Times are always shown in the user's own time zone, never the browser's.
 */

export const WEEKDAY_LABELS: Record<Weekday, { short: string; letter: string }> = {
  mo: { short: "Mon", letter: "M" },
  tu: { short: "Tue", letter: "T" },
  we: { short: "Wed", letter: "W" },
  th: { short: "Thu", letter: "T" },
  fr: { short: "Fri", letter: "F" },
  sa: { short: "Sat", letter: "S" },
  su: { short: "Sun", letter: "S" },
};

/** "16:30" -> "4:30 PM" */
export function formatTimeOfDay(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Mon-Fri, weekends and every day read as words, not lists. */
export function formatDays(days: readonly Weekday[]): string {
  const set = new Set(days);
  const ordered = WEEKDAYS.filter((d) => set.has(d));
  if (ordered.length === 7) return "Every day";
  if (ordered.length === 5 && !set.has("sa") && !set.has("su")) return "Weekdays";
  if (ordered.length === 2 && set.has("sa") && set.has("su")) return "Weekends";
  return ordered.map((d) => WEEKDAY_LABELS[d].short).join(", ");
}

export function formatTimeRange(start?: string | null, end?: string | null): string | null {
  if (start && end) return `${formatTimeOfDay(start)} – ${formatTimeOfDay(end)}`;
  if (start) return `from ${formatTimeOfDay(start)}`;
  if (end) return `until ${formatTimeOfDay(end)}`;
  return null;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** One line for a context item's optional structure, or null if it has none. */
export function describeAttributes(a: ContextAttributes): string | null {
  const parts: string[] = [];
  if (a.days?.length) parts.push(formatDays(a.days));
  const range = formatTimeRange(a.startTime, a.endTime);
  if (range) parts.push(range);
  if (a.timesPerWeek) parts.push(`${a.timesPerWeek}× a week`);
  if (a.durationMinutes) parts.push(formatDuration(a.durationMinutes));
  return parts.length ? parts.join(" · ") : null;
}

// ---------- Time zones ----------

function zonedParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    asUtc: Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ),
  };
}

/** Local date ("YYYY-MM-DD") and time ("HH:MM") of an instant in `timeZone`. */
export function toZoned(iso: string, timeZone: string): { dateKey: string; time: string } {
  const { dateKey, time } = zonedParts(new Date(iso), timeZone);
  return { dateKey, time };
}

/** Wall-clock date and time in `timeZone` -> ISO instant. */
export function fromZoned(dateKey: string, time: string, timeZone: string): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const offsetAt = (ms: number) => zonedParts(new Date(ms), timeZone).asUtc - Math.floor(ms / 1000) * 1000;
  const first = guess - offsetAt(guess);
  // Second pass corrects for a DST change between the guess and the answer.
  return new Date(guess - offsetAt(first)).toISOString();
}

export function formatDate(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}

// ---------- Commitments ----------

/** Weekdays from an RRULE's BYDAY, or null if the rule is not a simple weekly one. */
export function weeklyDaysFromRule(rule: string | null | undefined): Weekday[] | null {
  if (!rule || !/^FREQ=WEEKLY(;|$)/.test(rule)) return null;
  const byDay = rule.match(/BYDAY=([A-Z,+\-0-9]+)/)?.[1];
  if (!byDay) return null;
  const given = new Set(byDay.split(",").map((d) => d.slice(-2).toLowerCase()));
  const days = WEEKDAYS.filter((d) => given.has(d));
  return days.length ? days : null;
}

/** Editable shape of a commitment in the user's time zone. */
export type CommitmentDraft = {
  title: string;
  /** A life area id, or "" for none. */
  lifeAreaId: string;
  kind: Commitment["kind"];
  /** Fixed: weekly days. Empty means a one-time event on `date`. */
  days: Weekday[];
  date: string;
  startTime: string;
  endTime: string;
  /** Flexible only. */
  estimatedMinutes: string;
  dueDate: string;
  location: string;
  notes: string;
};

export function commitmentToDraft(c: Commitment, timeZone: string): CommitmentDraft {
  const start = c.startsAt ? toZoned(c.startsAt, timeZone) : null;
  const end = c.endsAt ? toZoned(c.endsAt, timeZone) : null;
  return {
    title: c.title,
    lifeAreaId: c.lifeAreaId ?? "",
    kind: c.kind,
    days: weeklyDaysFromRule(c.recurrenceRule) ?? [],
    date: start?.dateKey ?? "",
    startTime: start?.time ?? "",
    endTime: end?.time ?? "",
    estimatedMinutes: c.estimatedMinutes ? String(c.estimatedMinutes) : "",
    dueDate: c.dueAt ? toZoned(c.dueAt, timeZone).dateKey : "",
    location: c.location ?? "",
    notes: c.notes ?? "",
  };
}

/** One line describing when a commitment happens. */
export function describeCommitment(c: Commitment, timeZone: string): string | null {
  if (c.kind === "fixed") {
    const d = commitmentToDraft(c, timeZone);
    const range = formatTimeRange(d.startTime || null, d.endTime || null);
    if (d.days.length) return [formatDays(d.days), range].filter(Boolean).join(" · ");
    if (c.recurrenceRule) return [`Repeats (${c.recurrenceRule.replace(/^FREQ=/, "").toLowerCase()})`, range].filter(Boolean).join(" · ");
    return [d.date ? formatDate(d.date) : null, range].filter(Boolean).join(" · ") || null;
  }
  const parts: string[] = [];
  if (c.estimatedMinutes) parts.push(`about ${formatDuration(c.estimatedMinutes)}`);
  if (c.dueAt) parts.push(`due ${formatDate(toZoned(c.dueAt, timeZone).dateKey)}`);
  return parts.length ? parts.join(" · ") : null;
}
