import "server-only";

import { getGoogleConnection, updateGoogleConnection } from "@/lib/db/google";
import type { GoogleConnectionRow } from "@/lib/db/database.types";
import {
  GoogleAuthError,
  deleteEvent,
  getEvent,
  getGoogleConfig,
  listCalendars,
  listEvents,
  listInstances,
  patchEvent,
  refreshAccessToken,
  type GoogleCalendarListEntry,
  type GoogleConfig,
} from "@/lib/google/api";
import { decryptToken, encryptToken } from "@/lib/google/crypto";
import type { GoogleEvent } from "@/lib/google/map";

/**
 * A signed-in Google Calendar client for one user. The assistant's Google
 * writes go through this interface only, so tests can swap in a fake Google.
 */
export type GoogleClient = {
  canWrite: boolean;
  getEvent(calendarId: string, eventId: string): Promise<GoogleEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  patchEvent(calendarId: string, eventId: string, body: Record<string, unknown>): Promise<GoogleEvent>;
  listInstances(calendarId: string, seriesId: string, window: { from: Date; to: Date }): Promise<GoogleEvent[]>;
  listCalendars(): Promise<GoogleCalendarListEntry[]>;
  listEvents(calendarId: string, window: { from: Date; to: Date }): ReturnType<typeof listEvents>;
};

/** Google isn't connected (or not set up on this server). */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google Calendar isn't connected.");
    this.name = "GoogleNotConnectedError";
  }
}

export async function accessToken(userId: string, conn: GoogleConnectionRow, config: GoogleConfig, now: Date): Promise<string> {
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

export function clientFromToken(token: string, canWrite: boolean): GoogleClient {
  return {
    canWrite,
    getEvent: (c, e) => getEvent(token, c, e),
    deleteEvent: (c, e) => deleteEvent(token, c, e),
    patchEvent: (c, e, b) => patchEvent(token, c, e, b),
    listInstances: (c, s, w) => listInstances(token, c, s, w),
    listCalendars: () => listCalendars(token),
    listEvents: (c, w) => listEvents(token, c, w),
  };
}

export async function googleClientFor(userId: string, now = new Date()): Promise<GoogleClient> {
  const config = getGoogleConfig();
  if (!config) throw new GoogleNotConnectedError();
  const conn = await getGoogleConnection(userId);
  if (!conn) throw new GoogleNotConnectedError();
  return clientFromToken(await accessToken(userId, conn, config, now), conn.can_write === true);
}
