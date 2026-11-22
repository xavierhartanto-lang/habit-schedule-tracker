import { isDateKey, isValidTimeZone, zonedToUtc } from "@/lib/scheduling/zoned";

/**
 * Google Calendar event → Whitespace event. Pure, so it is unit tested.
 *
 * Imported events are fixed: they hold their time and the planner works
 * around them. Recurring Google events arrive already expanded
 * (singleEvents=true), so each occurrence is its own row and nothing here
 * has to translate Google's recurrence rules.
 */

export type GoogleDateTime = { date?: string; dateTime?: string; timeZone?: string };

export type GoogleEvent = {
  id?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  eventType?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  attendees?: { self?: boolean; responseStatus?: string; resource?: boolean }[];
  /** Set on each occurrence of a repeating event: the series' id. */
  recurringEventId?: string;
  organizer?: { self?: boolean };
  guestsCanModify?: boolean;
  /** Set on a repeating event's master. */
  recurrence?: string[];
};

export type GoogleAccess = "read" | "delete" | "edit";

export type ImportedEvent = {
  externalId: string;
  title: string;
  notes: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string;
  externalUrl: string | null;
  seriesId: string | null;
  access: GoogleAccess;
  shared: boolean;
};

/**
 * What Whitespace may do to an event: nothing without write access to the
 * calendar; remove it from the calendar with it; move or rename it only when
 * the user organizes it (or the organizer lets guests edit).
 */
export function accessFor(event: GoogleEvent, calendarWritable: boolean): GoogleAccess {
  if (!calendarWritable) return "read";
  const organizes = !event.organizer || event.organizer.self === true;
  return organizes || event.guestsCanModify ? "edit" : "delete";
}

/** Someone other than the user (and rooms) is invited. */
export function isShared(event: GoogleEvent): boolean {
  return (event.attendees ?? []).some((a) => !a.self && !a.resource);
}

/** Event types that are not plans: working location chips and birthdays. */
const SKIPPED_TYPES = new Set(["workingLocation", "birthday"]);

/** Zero-length events still need room on the calendar. */
const MIN_MINUTES = 15;

function clip(value: string | undefined, max: number): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
}

/** Google descriptions are HTML. Keep the words and line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Returns null for events that should not be on the user's calendar:
 * cancelled, declined, working-location chips, birthdays, or malformed.
 *
 * All-day events use the user's own zone, so "Nov 22" stays Nov 22 for
 * them (the same way all-day events made in Whitespace are stored).
 */
export function mapGoogleEvent(
  event: GoogleEvent,
  ctx: { userTimeZone: string; calendarTimeZone?: string | null; calendarWritable?: boolean },
): ImportedEvent | null {
  if (!event.id || event.status === "cancelled") return null;
  if (event.eventType && SKIPPED_TYPES.has(event.eventType)) return null;
  if (event.attendees?.some((a) => a.self && a.responseStatus === "declined")) return null;
  const start = event.start;
  const end = event.end;
  if (!start || !end) return null;

  const userTz = isValidTimeZone(ctx.userTimeZone) ? ctx.userTimeZone : "UTC";
  let startsAt: number;
  let endsAt: number;
  let allDay = false;
  let timezone = userTz;

  if (start.date) {
    if (!isDateKey(start.date)) return null;
    const endDate = end.date && isDateKey(end.date) && end.date > start.date ? end.date : null;
    startsAt = zonedToUtc(start.date, "00:00", userTz).getTime();
    endsAt = endDate ? zonedToUtc(endDate, "00:00", userTz).getTime() : startsAt + 86_400_000;
    allDay = true;
  } else if (start.dateTime && end.dateTime) {
    startsAt = Date.parse(start.dateTime);
    endsAt = Date.parse(end.dateTime);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return null;
    const zone = start.timeZone ?? ctx.calendarTimeZone ?? null;
    if (isValidTimeZone(zone)) timezone = zone;
  } else {
    return null;
  }
  if (endsAt <= startsAt) endsAt = startsAt + MIN_MINUTES * 60_000;

  const description = event.description ? htmlToText(event.description) : undefined;
  return {
    externalId: event.id,
    // Private events from shared calendars come without a title.
    title: clip(event.summary, 200) ?? "Busy",
    notes: clip(description, 2000),
    location: clip(event.location, 200),
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    allDay,
    timezone,
    externalUrl: event.htmlLink && /^https:\/\//.test(event.htmlLink) && event.htmlLink.length <= 2048 ? event.htmlLink : null,
    seriesId: event.recurringEventId && event.recurringEventId.length <= 1024 ? event.recurringEventId : null,
    access: accessFor(event, ctx.calendarWritable ?? false),
    shared: isShared(event),
  };
}

/**
 * The window each sync keeps in step with Google: two weeks back (so
 * recent history and Insights stay right) and six months ahead.
 * Older imported events are left as they were.
 */
export function syncWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - 14 * 86_400_000),
    to: new Date(now.getTime() + 183 * 86_400_000),
  };
}

/** Rows to delete: imported before, inside the window, and gone from Google now. */
export function staleIds(
  existing: { id: string; externalId: string }[],
  fetchedExternalIds: ReadonlySet<string>,
): string[] {
  return existing.filter((e) => !fetchedExternalIds.has(e.externalId)).map((e) => e.id);
}
