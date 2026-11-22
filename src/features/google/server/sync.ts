import "server-only";

import {
  claimGoogleSync,
  deleteCommitmentsById,
  deleteImportedEvents,
  getGoogleConnection,
  listGoogleCalendars,
  listImportedEventKeys,
  replaceGoogleCalendars,
  updateGoogleConnection,
  upsertImportedEvents,
} from "@/lib/db/google";
import type { GoogleConnectionRow } from "@/lib/db/database.types";
import { getProfile } from "@/lib/db/profiles";
import { GoogleAuthError, getGoogleConfig, listCalendars, listEvents, refreshAccessToken, type GoogleConfig } from "@/lib/google/api";
import { decryptToken, encryptToken } from "@/lib/google/crypto";
import { mapGoogleEvent, staleIds, syncWindow, type ImportedEvent } from "@/lib/google/map";

/**
 * One-way sync, Google → Whitespace. Each run:
 * 1. refreshes the calendar list,
 * 2. upserts every event in the window from the calendars the user picked
 *    (the unique external key means re-running never duplicates),
 * 3. deletes imported events that are gone from Google, and events from
 *    calendars the user turned off.
 * Nothing is ever written to Google.
 */

/** How long a sync counts as fresh for the automatic background sync. */
export const FRESH_FOR_MS = 15 * 60_000;

export type SyncOutcome =
  | { status: "not_configured" | "not_connected" | "fresh" | "busy" }
  | { status: "synced"; imported: number; removed: number }
  | { status: "error"; error: string };

async function accessToken(userId: string, conn: GoogleConnectionRow, config: GoogleConfig, now: Date): Promise<string> {
  const cached = conn.access_token ? decryptToken(conn.access_token, config.clientSecret) : null;
  const expires = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
  if (cached && expires - now.getTime() > 60_000) return cached;

  const refresh = decryptToken(conn.refresh_token, config.clientSecret);
  if (!refresh) throw new GoogleAuthError();
  const t = await refreshAccessToken(config, refresh);
  await updateGoogleConnection(userId, {
    access_token: encryptToken(t.access_token, config.clientSecret),
    access_token_expires_at: new Date(now.getTime() + t.expires_in * 1000).toISOString(),
  });
  return t.access_token;
}

export async function syncGoogleCalendar(
  userId: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const config = getGoogleConfig();
  if (!config) return { status: "not_configured" };
  const conn = await getGoogleConnection(userId);
  if (!conn) return { status: "not_connected" };
  if (!options.force && conn.last_synced_at && now.getTime() - Date.parse(conn.last_synced_at) < FRESH_FOR_MS) {
    return { status: "fresh" };
  }
  // A failed auth won't fix itself; wait for the user to reconnect.
  if (!options.force && conn.last_sync_error?.startsWith("Google access expired")) return { status: "fresh" };
  if (!(await claimGoogleSync(userId, now))) return { status: "busy" };

  try {
    const token = await accessToken(userId, conn, config, now);
    const profile = await getProfile(userId);
    const userTimeZone = profile?.timezone ?? "UTC";

    const list = await listCalendars(token);
    const zones = new Map(list.map((c) => [c.id, c.timeZone ?? null]));
    await replaceGoogleCalendars(
      userId,
      list.map((c) => ({
        googleId: c.id,
        name: c.summaryOverride ?? c.summary ?? "Calendar",
        color: c.backgroundColor ?? null,
        primary: Boolean(c.primary),
      })),
    );

    const calendars = await listGoogleCalendars(userId);
    const window = syncWindow(now);
    let imported = 0;
    let removed = 0;

    for (const cal of calendars) {
      if (!cal.selected) {
        removed += await deleteImportedEvents(userId, cal.google_calendar_id);
        continue;
      }
      const page = await listEvents(token, cal.google_calendar_id, window);
      const events = page.items
        .map((e) => mapGoogleEvent(e, { userTimeZone, calendarTimeZone: page.timeZone ?? zones.get(cal.google_calendar_id) }))
        .filter((e): e is ImportedEvent => e !== null);
      // One row per Google id, even if a page repeats one.
      const byId = new Map(events.map((e) => [e.externalId, e]));
      await upsertImportedEvents(userId, cal.google_calendar_id, cal.life_area_id, [...byId.values()]);
      imported += byId.size;

      // When Google had more than we fetched, only prune up to what we saw.
      const lastSeen = page.truncated && events.length ? events[events.length - 1].startsAt : window.to.toISOString();
      const existing = await listImportedEventKeys(userId, cal.google_calendar_id, {
        from: window.from.toISOString(),
        to: lastSeen,
      });
      const stale = staleIds(existing, new Set(byId.keys()));
      await deleteCommitmentsById(userId, stale);
      removed += stale.length;
    }

    await updateGoogleConnection(userId, { last_synced_at: now.toISOString(), last_sync_error: null, sync_started_at: null });
    return { status: "synced", imported, removed };
  } catch (e) {
    const message =
      e instanceof GoogleAuthError ? e.message : "Couldn't reach Google Calendar. Whitespace will try again soon.";
    if (!(e instanceof GoogleAuthError)) console.error("[google-sync]", e);
    await updateGoogleConnection(userId, { last_sync_error: message, sync_started_at: null }).catch(() => undefined);
    return { status: "error", error: message };
  }
}
