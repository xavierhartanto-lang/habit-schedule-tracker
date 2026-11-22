import "server-only";

import { DataValidationError } from "@/lib/db/client";
import {
  deleteCommitmentsById,
  getImportedEvent,
  listGoogleCalendars,
  listSeriesRows,
  upsertImportedEvents,
  type ImportedEventRef,
} from "@/lib/db/google";
import { getProfile } from "@/lib/db/profiles";
import { GoogleApiError, GoogleAuthError, GoogleForbiddenError, GoogleGoneError } from "@/lib/google/api";
import { mapGoogleEvent, staleIds, syncWindow, type GoogleEvent, type ImportedEvent } from "@/lib/google/map";
import { dateKeyInZone } from "@/lib/scheduling/zoned";
import { googleClientFor, type GoogleClient } from "./client";

/**
 * Changes the assistant makes to Google Calendar events: remove, move,
 * rename. Google is written first; Whitespace's copy is then refreshed from
 * what Google returns, so the two never disagree. Every change returns an
 * undo record, and undoing restores Google too (deleted events come back
 * with the same id, so links and invites survive).
 *
 * "one" changes a single occurrence; "series" changes every occurrence of a
 * repeating Google event.
 */

export type GoogleScope = "one" | "series";

export type GoogleUndo = {
  calendarId: string;
  /** The Google id that changed: an occurrence, or the series. */
  eventId: string;
  scope: GoogleScope;
  restore: { kind: "undelete" } | { kind: "patch"; body: Record<string, unknown> };
};

export type GoogleChange = { title?: string; startsAt?: string; endsAt?: string; location?: string | null };

const RECONNECT = "Whitespace needs permission to edit Google Calendar. Reconnect it in Settings (one tap), then ask again.";

/** User-facing reason for a failed Google write. */
function friendly(e: unknown, title: string): Error {
  if (e instanceof DataValidationError) return e;
  if (e instanceof GoogleForbiddenError) {
    return new DataValidationError(
      e.missingScope ? RECONNECT : `Google Calendar didn't let Whitespace change ${title}. Only its organizer can.`,
    );
  }
  if (e instanceof GoogleAuthError) return new DataValidationError(e.message);
  if (e instanceof GoogleApiError) return new DataValidationError(`Google Calendar didn't accept the change to ${title}. Try again in a moment.`);
  return e instanceof Error ? e : new Error(String(e));
}

async function target(userId: string, commitmentId: string): Promise<ImportedEventRef> {
  const ev = await getImportedEvent(userId, commitmentId);
  if (!ev) throw new DataValidationError("That Google Calendar event is no longer on your calendar.");
  return ev;
}

function requireAccess(client: GoogleClient, ev: ImportedEventRef, need: "delete" | "edit"): void {
  if (!client.canWrite) throw new DataValidationError(RECONNECT);
  if (ev.access === "read") throw new DataValidationError(`${ev.title} is on a Google calendar you can only view, so Whitespace can't change it.`);
  if (need === "edit" && ev.access !== "edit") {
    throw new DataValidationError(`${ev.title} is someone else's invite, so only they can move or rename it. Whitespace can remove it from your calendar instead.`);
  }
}

// ---------- Keeping Whitespace's copy in step ----------

async function context(userId: string, calendarId: string, client: GoogleClient) {
  const [calendars, profile] = await Promise.all([listGoogleCalendars(userId), getProfile(userId)]);
  const cal = calendars.find((c) => c.google_calendar_id === calendarId);
  return {
    lifeAreaId: cal?.life_area_id ?? null,
    calendarWritable: client.canWrite && (cal?.access_role === "owner" || cal?.access_role === "writer"),
    userTimeZone: profile?.timezone ?? "UTC",
  };
}

async function storeOne(userId: string, client: GoogleClient, calendarId: string, event: GoogleEvent, replacing?: string): Promise<void> {
  const ctx = await context(userId, calendarId, client);
  const mapped = mapGoogleEvent(event, ctx);
  if (replacing && (!mapped || mapped.externalId !== event.id)) await deleteCommitmentsById(userId, [replacing]);
  if (mapped) await upsertImportedEvents(userId, calendarId, ctx.lifeAreaId, [mapped]);
}

/** Re-reads every occurrence of a series from Google and mirrors it. */
async function storeSeries(userId: string, client: GoogleClient, calendarId: string, seriesId: string, now: Date): Promise<void> {
  const window = syncWindow(now);
  let items: GoogleEvent[] = [];
  try {
    items = await client.listInstances(calendarId, seriesId, window);
  } catch (e) {
    if (!(e instanceof GoogleGoneError)) throw e;
  }
  const ctx = await context(userId, calendarId, client);
  const mapped = items.map((e) => mapGoogleEvent(e, ctx)).filter((e): e is ImportedEvent => e !== null);
  await upsertImportedEvents(userId, calendarId, ctx.lifeAreaId, mapped);
  const existing = await listSeriesRows(userId, calendarId, seriesId, { from: window.from.toISOString(), to: window.to.toISOString() });
  await deleteCommitmentsById(userId, staleIds(existing, new Set(mapped.map((m) => m.externalId))));
}

// ---------- Changes ----------

export async function removeGoogleEvent(
  userId: string,
  commitmentId: string,
  scope: GoogleScope,
  now = new Date(),
  client?: GoogleClient,
): Promise<GoogleUndo> {
  const ev = await target(userId, commitmentId);
  try {
    const g = client ?? (await googleClientFor(userId, now));
    requireAccess(g, ev, "delete");
    const series = scope === "series" && ev.seriesId ? ev.seriesId : null;
    const eventId = series ?? ev.externalId;
    try {
      await g.deleteEvent(ev.calendarId, eventId);
    } catch (e) {
      if (!(e instanceof GoogleGoneError)) throw e; // already gone in Google: just tidy up here
    }
    if (series) {
      const rows = await listSeriesRows(userId, ev.calendarId, series);
      await deleteCommitmentsById(userId, rows.map((r) => r.id));
    } else {
      await deleteCommitmentsById(userId, [ev.id]);
    }
    return { calendarId: ev.calendarId, eventId, scope: series ? "series" : "one", restore: { kind: "undelete" } };
  } catch (e) {
    throw friendly(e, ev.title);
  }
}

function sameMoment(a: string | undefined, b: string): boolean {
  return a !== undefined && Date.parse(a) === Date.parse(b);
}

export async function updateGoogleEvent(
  userId: string,
  commitmentId: string,
  change: GoogleChange,
  scope: GoogleScope,
  options: { now?: Date; expect?: { title?: string | null; starts_at?: string | null; ends_at?: string | null }; client?: GoogleClient } = {},
): Promise<GoogleUndo> {
  const now = options.now ?? new Date();
  const ev = await target(userId, commitmentId);
  // Changed since it was suggested: refuse instead of overwriting.
  const x = options.expect;
  if (x && ((x.title && x.title !== ev.title) || (x.starts_at && !sameMoment(x.starts_at, ev.startsAt)) || (x.ends_at && !sameMoment(x.ends_at, ev.endsAt)))) {
    throw new DataValidationError(`${ev.title} changed since this was suggested, so nothing was changed.`);
  }
  try {
    const g = options.client ?? (await googleClientFor(userId, now));
    requireAccess(g, ev, "edit");
    const timed = change.startsAt !== undefined || change.endsAt !== undefined;
    if (timed && ev.allDay) throw new DataValidationError(`${ev.title} is an all-day event. Change its days in Google Calendar.`);
    const tz = ev.timezone ?? "UTC";
    const series = scope === "series" && ev.seriesId ? ev.seriesId : null;

    if (!series) {
      const body: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      if (change.title !== undefined) {
        body.summary = change.title;
        before.summary = ev.title;
      }
      if (change.location !== undefined) {
        body.location = change.location ?? "";
        before.location = ev.location ?? "";
      }
      if (timed) {
        body.start = { dateTime: change.startsAt ?? ev.startsAt, timeZone: tz };
        body.end = { dateTime: change.endsAt ?? ev.endsAt, timeZone: tz };
        before.start = { dateTime: ev.startsAt, timeZone: tz };
        before.end = { dateTime: ev.endsAt, timeZone: tz };
      }
      const patched = await g.patchEvent(ev.calendarId, ev.externalId, body);
      await storeOne(userId, g, ev.calendarId, patched, ev.id);
      return { calendarId: ev.calendarId, eventId: ev.externalId, scope: "one", restore: { kind: "patch", body: before } };
    }

    // Every occurrence: change the series itself.
    const master = await g.getEvent(ev.calendarId, series);
    const body: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    if (change.title !== undefined) {
      body.summary = change.title;
      before.summary = master.summary ?? ev.title;
    }
    if (change.location !== undefined) {
      body.location = change.location ?? "";
      before.location = master.location ?? "";
    }
    if (timed) {
      const newStart = change.startsAt ?? ev.startsAt;
      const newEnd = change.endsAt ?? ev.endsAt;
      if (dateKeyInZone(new Date(newStart), tz) !== dateKeyInZone(new Date(ev.startsAt), tz)) {
        throw new DataValidationError(
          `Whitespace can give every ${ev.title} a new time on the same day. To change the day it repeats on, change it in Google Calendar (or move just one).`,
        );
      }
      if (!master.start?.dateTime || !master.end?.dateTime) throw new DataValidationError(`${ev.title} is an all-day event. Change it in Google Calendar.`);
      const dStart = Date.parse(newStart) - Date.parse(ev.startsAt);
      const dEnd = Date.parse(newEnd) - Date.parse(ev.endsAt);
      const mtz = master.start.timeZone ?? tz;
      body.start = { dateTime: new Date(Date.parse(master.start.dateTime) + dStart).toISOString(), timeZone: mtz };
      body.end = { dateTime: new Date(Date.parse(master.end.dateTime) + dEnd).toISOString(), timeZone: master.end.timeZone ?? mtz };
      before.start = master.start;
      before.end = master.end;
    }
    await g.patchEvent(ev.calendarId, series, body);
    await storeSeries(userId, g, ev.calendarId, series, now);
    return { calendarId: ev.calendarId, eventId: series, scope: "series", restore: { kind: "patch", body: before } };
  } catch (e) {
    throw friendly(e, ev.title);
  }
}

/** Puts Google (and Whitespace's copy) back the way it was. */
export async function undoGoogleChange(userId: string, undo: GoogleUndo, now = new Date(), client?: GoogleClient): Promise<void> {
  try {
    const g = client ?? (await googleClientFor(userId, now));
    const body = undo.restore.kind === "undelete" ? { status: "confirmed" } : undo.restore.body;
    const restored = await g.patchEvent(undo.calendarId, undo.eventId, body);
    if (undo.scope === "series") await storeSeries(userId, g, undo.calendarId, undo.eventId, now);
    else await storeOne(userId, g, undo.calendarId, restored);
  } catch (e) {
    if (e instanceof GoogleGoneError) {
      throw new DataValidationError("That Google Calendar event can't come back anymore (Google already cleared it).");
    }
    throw friendly(e, "that event");
  }
}
