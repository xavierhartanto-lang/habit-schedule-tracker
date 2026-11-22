import "server-only";

import type { GoogleEvent } from "./map";

/**
 * Thin wrapper over Google's OAuth and Calendar REST endpoints.
 * calendar.readonly lists calendars and events; calendar.events lets
 * Whitespace change, move and remove events the user asked it to.
 * Every write passes sendUpdates=none: Whitespace never emails guests.
 */

export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_SCOPES = ["openid", "email", READ_SCOPE, WRITE_SCOPE];

/** True when a granted scope string allows event writes. */
export function canWrite(scope: string | undefined): boolean {
  return (scope ?? "").split(/\s+/).some((s) => s === WRITE_SCOPE || s === "https://www.googleapis.com/auth/calendar");
}

export type GoogleConfig = { clientId: string; clientSecret: string };

/** Server-only env. Null when Google import isn't set up. */
export function getGoogleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Must match an "Authorized redirect URI" in Google Cloud exactly. */
export function redirectUri(origin: string): string {
  const override = process.env.GOOGLE_REDIRECT_URI?.trim();
  return override || `${origin}/api/google/callback`;
}

/** Google said the grant is gone (revoked, expired, or password changed). */
export class GoogleAuthError extends Error {
  constructor(message = "Google access expired. Reconnect Google Calendar.") {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class GoogleApiError extends Error {
  readonly status: number;
  /** Google's own error code, e.g. "invalid_client" or "redirect_uri_mismatch". */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.code = code;
  }
}

export function authUrl(config: GoogleConfig, origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // A refresh token, so imports keep working without signing in again.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant") throw new GoogleAuthError();
    throw new GoogleApiError(`Google token request failed (${json.error ?? res.status}).`, res.status, json.error ?? null);
  }
  return json as TokenResponse;
}

export function exchangeCode(config: GoogleConfig, origin: string, code: string) {
  return tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
}

export function refreshAccessToken(config: GoogleConfig, refreshToken: string) {
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
}

/** Best effort: tells Google to forget the grant. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
    cache: "no-store",
  }).catch(() => undefined);
}

/**
 * The email in an id_token we just received from Google's token endpoint
 * over TLS. Used only as a label ("Connected as …"), never for auth.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

/** The event is gone in Google (deleted there, or never existed). */
export class GoogleGoneError extends Error {
  constructor() {
    super("That event no longer exists in Google Calendar.");
    this.name = "GoogleGoneError";
  }
}

/** Google refused a write: the scope is missing, or the user can't edit this event. */
export class GoogleForbiddenError extends Error {
  readonly missingScope: boolean;
  constructor(missingScope: boolean) {
    super(missingScope ? "Whitespace needs permission to edit Google Calendar." : "Google Calendar didn't allow this change.");
    this.name = "GoogleForbiddenError";
    this.missingScope = missingScope;
  }
}

async function call<T>(accessToken: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401) throw new GoogleAuthError();
  if (res.status === 404 || res.status === 410) throw new GoogleGoneError();
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
    if (res.status === 403) {
      const reasons = (json?.error?.errors ?? []).map((e) => e.reason);
      if (reasons.includes("insufficientPermissions") || /insufficient.*scope/i.test(json?.error?.message ?? "")) throw new GoogleForbiddenError(true);
      if (reasons.includes("forbidden") || reasons.includes("forbiddenForNonOrganizer")) throw new GoogleForbiddenError(false);
    }
    throw new GoogleApiError(json?.error?.message ?? `Google Calendar request failed (${res.status}).`, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(accessToken: string, url: string) => call<T>(accessToken, url);

const EVENT_FIELDS =
  "id,status,htmlLink,summary,description,location,eventType,start,end,attendees(self,responseStatus,resource),recurringEventId,organizer(self),guestsCanModify,recurrence";

const eventUrl = (calendarId: string, eventId: string, query = "") =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${query}`;

export function getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEvent> {
  return call<GoogleEvent>(accessToken, eventUrl(calendarId, eventId, `?fields=${encodeURIComponent(EVENT_FIELDS)}`));
}

/** Removes an event (an occurrence's id removes that day; a series' id removes every day). */
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  await call<void>(accessToken, eventUrl(calendarId, eventId, "?sendUpdates=none"), { method: "DELETE" });
}

/** Changes some fields. `{ status: "confirmed" }` brings back a recently deleted event. */
export function patchEvent(accessToken: string, calendarId: string, eventId: string, body: Record<string, unknown>): Promise<GoogleEvent> {
  return call<GoogleEvent>(accessToken, eventUrl(calendarId, eventId, `?sendUpdates=none&fields=${encodeURIComponent(EVENT_FIELDS)}`), {
    method: "PATCH",
    body,
  });
}

/** Every occurrence of a repeating event in the window. */
export async function listInstances(
  accessToken: string,
  calendarId: string,
  seriesId: string,
  window: { from: Date; to: Date },
): Promise<GoogleEvent[]> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      maxResults: "250",
      fields: `nextPageToken,items(${EVENT_FIELDS})`,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await get<{ items?: GoogleEvent[]; nextPageToken?: string }>(accessToken, eventUrl(calendarId, seriesId, `/instances?${params}`));
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && items.length < MAX_EVENTS_PER_CALENDAR);
  return items;
}

export type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  timeZone?: string;
  hidden?: boolean;
  accessRole?: "owner" | "writer" | "reader" | "freeBusyReader";
};

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const out: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "250", minAccessRole: "reader" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await get<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(
      accessToken,
      `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`,
    );
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 500);
  return out;
}

/** Most events one calendar can bring in per sync. */
export const MAX_EVENTS_PER_CALENDAR = 1500;

export async function listEvents(
  accessToken: string,
  calendarId: string,
  window: { from: Date; to: Date },
): Promise<{ items: GoogleEvent[]; timeZone: string | null; truncated: boolean }> {
  const items: GoogleEvent[] = [];
  let timeZone: string | null = null;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      maxResults: "250",
      fields: `nextPageToken,timeZone,items(${EVENT_FIELDS})`,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await get<{ items?: GoogleEvent[]; nextPageToken?: string; timeZone?: string }>(
      accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    );
    timeZone = page.timeZone ?? timeZone;
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && items.length < MAX_EVENTS_PER_CALENDAR);
  return { items: items.slice(0, MAX_EVENTS_PER_CALENDAR), timeZone, truncated: Boolean(pageToken) };
}
