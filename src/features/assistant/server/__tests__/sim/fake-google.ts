import type { Commitment } from "@/lib/domain/types";
import type { GoogleEvent, ImportedEvent } from "@/lib/google/map";
import { syncWindow } from "@/lib/google/map";
import { addDaysToKey, dateKeyInZone, zonedToUtc } from "@/lib/scheduling/zoned";
import { newId, state } from "./fake-db";

/**
 * A stand-in for Google Calendar, behind the same GoogleClient interface the
 * app uses, plus the lib/db/google functions over the simulated database.
 * Whitespace's copies of Google events (state.db.events) must always match
 * what this fake Google holds: the simulation checks that after every scenario.
 *
 * Two calendars: "primary" (the user's own, writable) and "school"
 * (shared with them view-only).
 */

const TZ = "America/Los_Angeles";

type Stored = GoogleEvent & { id: string; calendarId: string; cancelledWithSeries?: boolean };

export const google: { events: Map<string, Stored>; canWrite: boolean; writes: string[] } = {
  events: new Map(),
  canWrite: true,
  writes: [],
};

const key = (cal: string, id: string) => `${cal}/${id}`;
const clone = <T>(v: T): T => structuredClone(v);

export function resetGoogle(): void {
  google.events = new Map();
  google.canWrite = true;
  google.writes = [];
}

export const CALENDARS = [
  { id: "cal-1", user_id: "u1", google_calendar_id: "primary", name: "Me", color: null, is_primary: true, selected: true, life_area_id: null, access_role: "owner", created_at: "", updated_at: "" },
  { id: "cal-2", user_id: "u1", google_calendar_id: "school", name: "School", color: null, is_primary: false, selected: true, life_area_id: null, access_role: "reader", created_at: "", updated_at: "" },
];

type GoogleInput = {
  title: string;
  day: string;
  start: string;
  end: string;
  /** Repeats weekly from `day`. */
  weekly?: boolean;
  calendar?: "primary" | "school";
  /** An invite from someone else: the user can remove it but not move it. */
  invite?: boolean;
  location?: string;
};

function access(calendar: string, invite: boolean): Commitment["externalAccess"] {
  if (calendar === "school" || !google.canWrite) return "read";
  return invite ? "delete" : "edit";
}

function mirror(ev: Stored): Commitment {
  const row = {
    id: newId(),
    title: ev.summary ?? "Busy",
    area: null,
    kind: "fixed",
    startsAt: new Date(ev.start!.dateTime!).toISOString(),
    endsAt: new Date(ev.end!.dateTime!).toISOString(),
    timezone: TZ,
    recurrenceRule: null,
    recurrenceExceptions: [],
    location: ev.location ?? null,
    source: "manual",
    externalSource: "google",
    externalSeriesId: ev.recurringEventId ?? null,
    externalAccess: access(ev.calendarId, !!ev.organizer && !ev.organizer.self),
    externalShared: (ev.attendees ?? []).some((a) => !a.self),
    externalCalendarId: ev.calendarId,
    externalId: ev.id,
  } as Commitment;
  return row;
}

/**
 * Adds an event to Google and to Whitespace's copy (as a sync would).
 * Returns Whitespace's row for the first occurrence from today on.
 */
export function addGoogle(input: GoogleInput): Commitment {
  const calendarId = input.calendar ?? "primary";
  const base = `g${newId().slice(-6)}`;
  const invite = !!input.invite;
  const common = {
    calendarId,
    summary: input.title,
    location: input.location,
    status: "confirmed",
    organizer: { self: !invite },
    attendees: invite ? [{ self: true, responseStatus: "accepted" }, { self: false, responseStatus: "accepted" }] : undefined,
  };
  const window = syncWindow(state.db.now);
  const rows: Commitment[] = [];
  const at = (day: string, t: string) => ({ dateTime: zonedToUtc(day, t, TZ).toISOString(), timeZone: TZ });
  if (!input.weekly) {
    const ev: Stored = { ...common, id: base, start: at(input.day, input.start), end: at(input.day, input.end) };
    google.events.set(key(calendarId, ev.id), ev);
    rows.push(mirror(ev));
  } else {
    google.events.set(key(calendarId, base), { ...common, id: base, start: at(input.day, input.start), end: at(input.day, input.end), recurrence: ["RRULE:FREQ=WEEKLY"] });
    for (let day = input.day; zonedToUtc(day, "00:00", TZ) < window.to; day = addDaysToKey(day, 7)) {
      const ev: Stored = { ...common, id: `${base}_${day.replaceAll("-", "")}`, recurringEventId: base, start: at(day, input.start), end: at(day, input.end) };
      google.events.set(key(calendarId, ev.id), ev);
      if (Date.parse(ev.end!.dateTime!) > window.from.getTime()) rows.push(mirror(ev));
    }
  }
  state.db.events.push(...rows);
  return rows.find((r) => Date.parse(r.endsAt!) > state.db.now.getTime()) ?? rows[0];
}

// ---------- GoogleClient ----------

async function gone(): Promise<never> {
  const { GoogleGoneError } = await import("@/lib/google/api");
  throw new GoogleGoneError();
}

function find(cal: string, id: string): Stored | undefined {
  return google.events.get(key(cal, id));
}

function instancesOf(cal: string, seriesId: string): Stored[] {
  return [...google.events.values()].filter((e) => e.calendarId === cal && e.recurringEventId === seriesId);
}

export const fakeClient = {
  get canWrite() {
    return google.canWrite;
  },
  async getEvent(cal: string, id: string): Promise<GoogleEvent> {
    const ev = find(cal, id);
    if (!ev || ev.status === "cancelled") return gone();
    return clone(ev);
  },
  async deleteEvent(cal: string, id: string): Promise<void> {
    const ev = find(cal, id);
    if (!ev || ev.status === "cancelled") return gone();
    if (cal === "school") {
      const { GoogleForbiddenError } = await import("@/lib/google/api");
      throw new GoogleForbiddenError(false);
    }
    google.writes.push(`delete ${id}`);
    ev.status = "cancelled";
    if (ev.recurrence) {
      for (const i of instancesOf(cal, id)) {
        if (i.status !== "cancelled") {
          i.status = "cancelled";
          i.cancelledWithSeries = true;
        }
      }
    }
  },
  async patchEvent(cal: string, id: string, body: Record<string, unknown>): Promise<GoogleEvent> {
    const ev = find(cal, id);
    if (!ev) return gone();
    google.writes.push(`patch ${id} ${Object.keys(body).sort().join(",")}`);
    if (body.status === "confirmed") {
      ev.status = "confirmed";
      if (ev.recurrence) {
        for (const i of instancesOf(cal, id)) {
          if (i.cancelledWithSeries) {
            i.status = "confirmed";
            delete i.cancelledWithSeries;
          }
        }
      }
      return clone(ev);
    }
    if (ev.status === "cancelled") return gone();
    const start = body.start as { dateTime: string } | undefined;
    const end = body.end as { dateTime: string } | undefined;
    if (ev.recurrence) {
      // A series: every occurrence follows (new times keep each one's day).
      const dStart = start ? Date.parse(start.dateTime) - Date.parse(ev.start!.dateTime!) : 0;
      const dEnd = end ? Date.parse(end.dateTime) - Date.parse(ev.end!.dateTime!) : 0;
      for (const i of instancesOf(cal, id)) {
        if (typeof body.summary === "string") i.summary = body.summary;
        if (body.location !== undefined) i.location = (body.location as string) || undefined;
        i.start = { ...i.start, dateTime: new Date(Date.parse(i.start!.dateTime!) + dStart).toISOString() };
        i.end = { ...i.end, dateTime: new Date(Date.parse(i.end!.dateTime!) + dEnd).toISOString() };
      }
    }
    if (typeof body.summary === "string") ev.summary = body.summary;
    if (body.location !== undefined) ev.location = (body.location as string) || undefined;
    if (start) ev.start = { ...ev.start, ...start };
    if (end) ev.end = { ...ev.end, ...end };
    return clone(ev);
  },
  async listInstances(cal: string, seriesId: string, window: { from: Date; to: Date }): Promise<GoogleEvent[]> {
    const master = find(cal, seriesId);
    if (!master || master.status === "cancelled") return gone();
    return instancesOf(cal, seriesId)
      .filter((i) => i.status !== "cancelled" && Date.parse(i.end!.dateTime!) > window.from.getTime() && Date.parse(i.start!.dateTime!) < window.to.getTime())
      .map(clone);
  },
  async listCalendars() {
    throw new Error("not used in the simulation");
  },
  async listEvents() {
    throw new Error("not used in the simulation");
  },
};

// ---------- lib/db/google over the simulated database ----------

type Row = Commitment & { externalCalendarId?: string; externalId?: string };
const rows = () => state.db.events as Row[];

export const dbGoogleModule = {
  getImportedEvent: async (_u: string, id: string) => {
    const r = rows().find((e) => e.id === id);
    if (!r || r.externalSource !== "google") return null;
    return {
      id: r.id,
      title: r.title,
      location: r.location ?? null,
      startsAt: r.startsAt!,
      endsAt: r.endsAt!,
      allDay: !!r.allDay,
      timezone: r.timezone ?? null,
      calendarId: r.externalCalendarId!,
      externalId: r.externalId!,
      seriesId: r.externalSeriesId ?? null,
      access: r.externalAccess ?? "read",
      shared: !!r.externalShared,
    };
  },
  deleteCommitmentsById: async (_u: string, ids: string[]) => {
    state.db.events = state.db.events.filter((e) => !ids.includes(e.id));
  },
  listGoogleCalendars: async () => clone(CALENDARS),
  listSeriesRows: async (_u: string, cal: string, seriesId: string, window?: { from: string; to: string }) =>
    rows()
      .filter(
        (r) =>
          r.externalCalendarId === cal &&
          r.externalSeriesId === seriesId &&
          (!window || (Date.parse(r.endsAt!) > Date.parse(window.from) && Date.parse(r.startsAt!) < Date.parse(window.to))),
      )
      .map((r) => ({ id: r.id, externalId: r.externalId! })),
  upsertImportedEvents: async (_u: string, cal: string, lifeAreaId: string | null, events: ImportedEvent[]) => {
    for (const e of events) {
      const existing = rows().find((r) => r.externalCalendarId === cal && r.externalId === e.externalId);
      const fields = {
        title: e.title,
        location: e.location,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        timezone: e.timezone,
        lifeAreaId,
        externalSeriesId: e.seriesId,
        externalAccess: e.access,
        externalShared: e.shared,
      };
      if (existing) Object.assign(existing, fields);
      else
        state.db.events.push({
          id: newId(),
          area: null,
          kind: "fixed",
          recurrenceRule: null,
          recurrenceExceptions: [],
          source: "manual",
          externalSource: "google",
          externalCalendarId: cal,
          externalId: e.externalId,
          ...fields,
        } as Row);
    }
  },
};

/**
 * Whitespace's copy matches Google exactly: every live Google occurrence in
 * the sync window has one row with the same title and times, and no row
 * points at an event Google no longer has. Returns the differences.
 */
export function mirrorDifferences(): string[] {
  const window = syncWindow(state.db.now);
  const out: string[] = [];
  const live = [...google.events.values()].filter(
    (e) => !e.recurrence && e.status !== "cancelled" && Date.parse(e.end!.dateTime!) > window.from.getTime() && Date.parse(e.start!.dateTime!) < window.to.getTime(),
  );
  const mine = rows().filter((r) => r.externalSource === "google");
  for (const g of live) {
    const r = mine.filter((x) => x.externalCalendarId === g.calendarId && x.externalId === g.id);
    if (r.length !== 1) {
      out.push(`${g.summary} ${dateKeyInZone(new Date(g.start!.dateTime!), TZ)}: ${r.length} rows`);
      continue;
    }
    const same =
      r[0].title === g.summary &&
      Date.parse(r[0].startsAt!) === Date.parse(g.start!.dateTime!) &&
      Date.parse(r[0].endsAt!) === Date.parse(g.end!.dateTime!) &&
      (r[0].location ?? null) === (g.location ?? null);
    if (!same) out.push(`${g.summary} ${g.id}: Whitespace has "${r[0].title}" ${r[0].startsAt}`);
  }
  const liveIds = new Set(live.map((g) => key(g.calendarId, g.id)));
  for (const r of mine) if (!liveIds.has(key(r.externalCalendarId!, r.externalId!))) out.push(`${r.title} (${r.externalId}) is gone from Google`);
  return out;
}

/** What Google holds, for "nothing changed in Google" checks. */
export function googleSnapshot(): string {
  return JSON.stringify([...google.events.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
