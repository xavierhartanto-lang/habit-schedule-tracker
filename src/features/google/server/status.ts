import "server-only";

import { GOOGLE_MIGRATION_MISSING, getGoogleConnection, listGoogleCalendars } from "@/lib/db/google";
import { DataValidationError } from "@/lib/db/client";
import { getGoogleConfig } from "@/lib/google/api";
import type { GoogleStatus } from "../types";

/** What the Settings card needs. Never throws. */
export async function getGoogleStatus(userId: string): Promise<GoogleStatus> {
  if (!getGoogleConfig()) return { state: "not_configured" };
  try {
    const conn = await getGoogleConnection(userId);
    if (!conn) return { state: "disconnected" };
    const calendars = await listGoogleCalendars(userId);
    return {
      state: "connected",
      email: conn.google_email,
      lastSyncedAt: conn.last_synced_at,
      lastError: conn.last_sync_error,
      calendars: calendars.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        primary: c.is_primary,
        selected: c.selected,
        lifeAreaId: c.life_area_id,
      })),
    };
  } catch (e) {
    if (e instanceof DataValidationError && e.message === GOOGLE_MIGRATION_MISSING) return { state: "needs_migration" };
    console.error("[google-status]", e);
    return { state: "unavailable" };
  }
}
