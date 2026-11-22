import "server-only";

import type { ImportedEvent } from "@/lib/google/map";
import { DataValidationError, dbError, requireDb } from "./client";
import type { GoogleCalendarRow, GoogleConnectionRow } from "./database.types";

/**
 * Storage for Google Calendar import: the connection (encrypted tokens),
 * the user's calendars, and the imported events in `commitments`.
 * Only lib/google + features/google call this.
 */

export const GOOGLE_MIGRATION_MISSING =
  "Google Calendar import needs the database update 20261201000000. Run it in Supabase, then try again.";

/** The table or column doesn't exist yet: the migration hasn't run. */
export function isMissingSchema(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    /google_(connections|calendars)|external_(source|id|calendar_id|url|series_id|access|shared)|can_write|access_role/.test(error.message ?? "")
  );
}

function fail(error: { code?: string; message: string }): Error {
  return isMissingSchema(error) ? new DataValidationError(GOOGLE_MIGRATION_MISSING) : dbError(error);
}

// ---------- Connection ----------

export async function getGoogleConnection(userId: string): Promise<GoogleConnectionRow | null> {
  const supabase = await requireDb();
  const { data, error } = await supabase.from("google_connections").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw fail(error);
  return data;
}

export async function saveGoogleConnection(
  userId: string,
  v: { email: string | null; refreshToken: string; accessToken: string; expiresAt: string; canWrite: boolean },
): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("google_connections").upsert(
    {
      user_id: userId,
      google_email: v.email,
      refresh_token: v.refreshToken,
      access_token: v.accessToken,
      access_token_expires_at: v.expiresAt,
      can_write: v.canWrite,
      // Access may have changed (e.g. edit permission granted): re-import now.
      last_synced_at: null,
      last_sync_error: null,
      sync_started_at: null,
    },
    { onConflict: "user_id" },
  );
  if (error) throw fail(error);
}

export async function updateGoogleConnection(
  userId: string,
  patch: Partial<Pick<GoogleConnectionRow, "access_token" | "access_token_expires_at" | "last_synced_at" | "last_sync_error" | "sync_started_at">>,
): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("google_connections").update(patch).eq("user_id", userId);
  if (error) throw fail(error);
}

/**
 * Claims the sync lock. False when another sync started less than two
 * minutes ago (a crashed sync frees the lock after that).
 */
export async function claimGoogleSync(userId: string, now: Date): Promise<boolean> {
  const supabase = await requireDb();
  const staleBefore = new Date(now.getTime() - 2 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("google_connections")
    .update({ sync_started_at: now.toISOString() })
    .eq("user_id", userId)
    .or(`sync_started_at.is.null,sync_started_at.lt."${staleBefore}"`)
    .select("user_id");
  if (error) throw fail(error);
  return data.length > 0;
}

export async function deleteGoogleConnection(userId: string): Promise<void> {
  const supabase = await requireDb();
  const events = await supabase.from("commitments").delete().eq("user_id", userId).eq("external_source", "google");
  if (events.error) throw fail(events.error);
  const calendars = await supabase.from("google_calendars").delete().eq("user_id", userId);
  if (calendars.error) throw fail(calendars.error);
  const conn = await supabase.from("google_connections").delete().eq("user_id", userId);
  if (conn.error) throw fail(conn.error);
}

// ---------- Calendars ----------

export async function listGoogleCalendars(userId: string): Promise<GoogleCalendarRow[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("google_calendars")
    .select("*")
    .eq("user_id", userId)
    .order("is_primary", { ascending: false })
    .order("name");
  if (error) throw fail(error);
  return data;
}

/**
 * Mirrors Google's calendar list. New calendars start unselected, except
 * the primary one the first time. Choices on existing ones are kept.
 * Calendars that disappeared from Google are removed with their events.
 */
export async function replaceGoogleCalendars(
  userId: string,
  calendars: { googleId: string; name: string; color: string | null; primary: boolean; accessRole: GoogleCalendarRow["access_role"] }[],
): Promise<void> {
  const supabase = await requireDb();
  const existing = await listGoogleCalendars(userId);
  const known = new Map(existing.map((c) => [c.google_calendar_id, c]));
  const seen = new Set(calendars.map((c) => c.googleId));

  const rows = calendars.map((c) => ({
    user_id: userId,
    google_calendar_id: c.googleId,
    name: c.name.slice(0, 200) || "Calendar",
    color: c.color && /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : null,
    is_primary: c.primary,
    access_role: c.accessRole ?? null,
    selected: known.get(c.googleId)?.selected ?? (c.primary && existing.length === 0),
  }));
  if (rows.length) {
    const { error } = await supabase.from("google_calendars").upsert(rows, { onConflict: "user_id,google_calendar_id" });
    if (error) throw fail(error);
  }

  const gone = existing.filter((c) => !seen.has(c.google_calendar_id));
  for (const c of gone) {
    await deleteImportedEvents(userId, c.google_calendar_id);
    const { error } = await supabase.from("google_calendars").delete().eq("user_id", userId).eq("id", c.id);
    if (error) throw fail(error);
  }
}

export async function updateGoogleCalendar(
  userId: string,
  id: string,
  patch: { selected?: boolean; lifeAreaId?: string | null },
): Promise<GoogleCalendarRow> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("google_calendars")
    .update({
      ...(patch.selected !== undefined ? { selected: patch.selected } : {}),
      ...(patch.lifeAreaId !== undefined ? { life_area_id: patch.lifeAreaId } : {}),
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23503") throw new DataValidationError("That life area no longer exists. Pick another.");
    throw fail(error);
  }
  if (!data) throw new DataValidationError("That calendar is no longer connected. Refresh and try again.");
  return data;
}

// ---------- Imported events ----------

const CHUNK = 200;

/** Inserts new events and updates changed ones. The unique key makes it idempotent. */
export async function upsertImportedEvents(
  userId: string,
  calendarId: string,
  lifeAreaId: string | null,
  events: ImportedEvent[],
): Promise<void> {
  const supabase = await requireDb();
  for (let i = 0; i < events.length; i += CHUNK) {
    const rows = events.slice(i, i + CHUNK).map((e) => ({
      user_id: userId,
      title: e.title,
      notes: e.notes,
      location: e.location,
      kind: "fixed" as const,
      all_day: e.allDay,
      starts_at: e.startsAt,
      ends_at: e.endsAt,
      timezone: e.timezone,
      recurrence_rule: null,
      life_area_id: lifeAreaId,
      external_source: "google" as const,
      external_calendar_id: calendarId,
      external_id: e.externalId,
      external_url: e.externalUrl,
      external_series_id: e.seriesId,
      external_access: e.access,
      external_shared: e.shared,
    }));
    const { error } = await supabase
      .from("commitments")
      .upsert(rows, { onConflict: "user_id,external_source,external_calendar_id,external_id" });
    if (error) throw fail(error);
  }
}

/** Imported events from one calendar that overlap the window. */
export async function listImportedEventKeys(
  userId: string,
  calendarId: string,
  window: { from: string; to: string },
): Promise<{ id: string; externalId: string }[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .select("id, external_id")
    .eq("user_id", userId)
    .eq("external_source", "google")
    .eq("external_calendar_id", calendarId)
    .gt("ends_at", window.from)
    .lt("starts_at", window.to)
    .limit(5000);
  if (error) throw fail(error);
  return data.map((r) => ({ id: r.id, externalId: r.external_id ?? "" }));
}

export async function deleteCommitmentsById(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const supabase = await requireDb();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await supabase.from("commitments").delete().eq("user_id", userId).in("id", ids.slice(i, i + CHUNK));
    if (error) throw fail(error);
  }
}

/** Every imported event from one calendar (it was turned off or removed). */
export async function deleteImportedEvents(userId: string, calendarId: string): Promise<number> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .delete()
    .eq("user_id", userId)
    .eq("external_source", "google")
    .eq("external_calendar_id", calendarId)
    .select("id");
  if (error) throw fail(error);
  return data.length;
}

/** Changes the life area of every event already imported from a calendar. */
export async function setImportedEventsArea(userId: string, calendarId: string, lifeAreaId: string | null): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase
    .from("commitments")
    .update({ life_area_id: lifeAreaId })
    .eq("user_id", userId)
    .eq("external_source", "google")
    .eq("external_calendar_id", calendarId);
  if (error) throw fail(error);
}

// ---------- Writing back to Google ----------

export type ImportedEventRef = {
  id: string;
  title: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string | null;
  calendarId: string;
  externalId: string;
  seriesId: string | null;
  access: "read" | "delete" | "edit";
  shared: boolean;
};

/** An imported event with everything needed to change it in Google. Null if it isn't one. */
export async function getImportedEvent(userId: string, id: string): Promise<ImportedEventRef | null> {
  const supabase = await requireDb();
  const { data, error } = await supabase.from("commitments").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw fail(error);
  if (!data || data.external_source !== "google" || !data.external_id || !data.external_calendar_id || !data.starts_at || !data.ends_at) return null;
  return {
    id: data.id,
    title: data.title,
    location: data.location,
    startsAt: data.starts_at,
    endsAt: data.ends_at,
    allDay: data.all_day,
    timezone: data.timezone,
    calendarId: data.external_calendar_id,
    externalId: data.external_id,
    seriesId: data.external_series_id ?? null,
    access: data.external_access ?? "read",
    shared: data.external_shared ?? false,
  };
}

/** Rows of one repeating Google event (optionally only those overlapping a window). */
export async function listSeriesRows(
  userId: string,
  calendarId: string,
  seriesId: string,
  window?: { from: string; to: string },
): Promise<{ id: string; externalId: string }[]> {
  const supabase = await requireDb();
  let q = supabase
    .from("commitments")
    .select("id, external_id")
    .eq("user_id", userId)
    .eq("external_source", "google")
    .eq("external_calendar_id", calendarId)
    .eq("external_series_id", seriesId)
    .limit(5000);
  if (window) q = q.gt("ends_at", window.from).lt("starts_at", window.to);
  const { data, error } = await q;
  if (error) throw fail(error);
  return data.map((r) => ({ id: r.id, externalId: r.external_id ?? "" }));
}
