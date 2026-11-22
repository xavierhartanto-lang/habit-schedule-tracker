"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { DataValidationError } from "@/lib/db/client";
import {
  deleteGoogleConnection,
  deleteImportedEvents,
  getGoogleConnection,
  setImportedEventsArea,
  updateGoogleCalendar,
} from "@/lib/db/google";
import { isUuid } from "@/lib/domain/context-items";
import { getGoogleConfig, revokeToken } from "@/lib/google/api";
import { decryptToken } from "@/lib/google/crypto";
import type { ActionResult } from "@/features/shared/action-result";
import { PLANNING_PATHS, runAction } from "@/features/shared/run-action";
import { syncGoogleCalendar } from "./server/sync";

/**
 * Google Calendar import actions. Connecting happens through
 * /api/google/connect (a redirect), everything else is here.
 */

const PATHS = [...PLANNING_PATHS, "/settings", "/insights"];

function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

/** "Sync now" in Settings. */
export async function syncGoogleNow(): Promise<ActionResult & { summary?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to sync." };
  try {
    const r = await syncGoogleCalendar(user.id, { force: true });
    if (r.status === "error") return { ok: false, error: r.error };
    if (r.status === "busy") return { ok: true, summary: "A sync is already running." };
    if (r.status === "not_connected") return { ok: false, error: "Google Calendar isn't connected." };
    if (r.status === "not_configured") return { ok: false, error: "Google Calendar isn't set up on this server yet." };
    revalidate();
    return { ok: true, summary: r.status === "synced" ? `Up to date. ${r.imported} event${r.imported === 1 ? "" : "s"} from Google.` : "Up to date." };
  } catch (e) {
    if (e instanceof DataValidationError) return { ok: false, error: e.message };
    console.error("[google-sync-now]", e);
    return { ok: false, error: "Couldn't sync. Try again in a moment." };
  }
}

/**
 * Quiet background sync from the app shell. Does nothing when the last
 * sync is recent. `changed` tells the page to refresh.
 */
export async function autoSyncGoogle(): Promise<{ changed: boolean }> {
  if (!getGoogleConfig()) return { changed: false };
  const user = await getSessionUser();
  if (!user) return { changed: false };
  try {
    const r = await syncGoogleCalendar(user.id);
    if (r.status !== "synced") return { changed: false };
    revalidate();
    return { changed: r.imported > 0 || r.removed > 0 };
  } catch {
    // Missing migration or no database: stay quiet, Settings explains it.
    return { changed: false };
  }
}

/** Turns a calendar's import on or off. On imports it right away; off removes its events. */
export async function setGoogleCalendarSelected(id: string, selected: boolean): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    if (!isUuid(id)) throw new DataValidationError("That calendar is no longer connected.");
    const cal = await updateGoogleCalendar(userId, id, { selected });
    if (!selected) {
      await deleteImportedEvents(userId, cal.google_calendar_id);
      return;
    }
    const r = await syncGoogleCalendar(userId, { force: true });
    if (r.status === "error") throw new DataValidationError(r.error);
  });
}

/** Which life area a calendar's events belong to. Applies to events already imported too. */
export async function setGoogleCalendarArea(id: string, lifeAreaId: string | null): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    if (!isUuid(id) || (lifeAreaId !== null && !isUuid(lifeAreaId))) throw new DataValidationError("Pick a life area.");
    const cal = await updateGoogleCalendar(userId, id, { lifeAreaId });
    await setImportedEventsArea(userId, cal.google_calendar_id, lifeAreaId);
  });
}

/** Disconnects Google: forgets the tokens and removes every imported event. */
export async function disconnectGoogle(): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    const conn = await getGoogleConnection(userId);
    const config = getGoogleConfig();
    if (conn && config) {
      const token = decryptToken(conn.refresh_token, config.clientSecret);
      if (token) await revokeToken(token);
    }
    await deleteGoogleConnection(userId);
  });
}
