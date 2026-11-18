import { z } from "zod";
import { MAX_COUNT, MAX_INTERVAL, buildRRule, type Recurrence } from "@/lib/scheduling/recurrence";
import { addDaysToKey, zonedToUtc } from "@/lib/scheduling/zoned";
import { WEEKDAYS, type CommitmentKind, type Weekday } from "./types";
import type { ValidationResult } from "./context-items";
import { check, zDateKey, zOptionalAreaId, zOptionalText, zTime, zTimeZone, zTitle } from "./validation";

/**
 * Calendar event form → database write. Pure: the server action calls
 * this, then lib/db/events stores the result.
 *
 * Times arrive as local wall-clock values plus the IANA zone they are in,
 * and are converted to UTC instants here. All-day events are stored as
 * local midnight to local midnight (end exclusive).
 */

export type RepeatChoice = "NONE" | Recurrence["freq"];
export type RepeatEnds = "never" | "until" | "count";

export type EventForm = {
  title: string;
  description: string | null;
  location: string | null;
  lifeAreaId: string | null;
  kind: CommitmentKind;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** Inclusive for all-day events. */
  endDate: string;
  endTime: string;
  timezone: string;
  repeat: {
    freq: RepeatChoice;
    interval: number;
    byDay: Weekday[];
    ends: RepeatEnds;
    until: string | null;
    count: number | null;
  };
};

export type EventWrite = {
  title: string;
  notes: string | null;
  location: string | null;
  lifeAreaId: string | null;
  kind: CommitmentKind;
  allDay: boolean;
  startsAt: string;
  endsAt: string;
  timezone: string;
  recurrenceRule: string | null;
};

const MAX_EVENT_DAYS = 31;

const schema = z.object({
  title: zTitle(200),
  description: zOptionalText(2000, "Description"),
  location: zOptionalText(200, "Location"),
  lifeAreaId: zOptionalAreaId,
  kind: z.enum(["fixed", "flexible"], { error: "Choose fixed or flexible." }),
  allDay: z.boolean(),
  startDate: zDateKey,
  startTime: zTime,
  endDate: zDateKey,
  endTime: zTime,
  timezone: zTimeZone,
  repeat: z.object({
    freq: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"], { error: "Unknown repeat option." }),
    interval: z.number().int().min(1).max(MAX_INTERVAL, `Repeat at most every ${MAX_INTERVAL}.`),
    byDay: z.array(z.enum(WEEKDAYS as unknown as [Weekday, ...Weekday[]])).max(7),
    ends: z.enum(["never", "until", "count"]),
    until: z.union([zDateKey, z.null()]),
    count: z.union([z.number().int().min(1).max(MAX_COUNT, `Repeat at most ${MAX_COUNT} times.`), z.null()]),
  }),
});

export function validateEventForm(raw: unknown): ValidationResult<EventWrite> {
  const parsed = check(schema, raw);
  if (!parsed.ok) return parsed;
  const f = parsed.value;

  let startsAt: Date;
  let endsAt: Date;
  if (f.allDay) {
    if (f.endDate < f.startDate) return { ok: false, error: "The end date must be on or after the start date." };
    startsAt = zonedToUtc(f.startDate, "00:00", f.timezone);
    endsAt = zonedToUtc(addDaysToKey(f.endDate, 1), "00:00", f.timezone);
  } else {
    startsAt = zonedToUtc(f.startDate, f.startTime, f.timezone);
    endsAt = zonedToUtc(f.endDate, f.endTime, f.timezone);
    if (endsAt <= startsAt) return { ok: false, error: "The end time must be after the start time." };
  }
  if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DAYS * 86_400_000) {
    return { ok: false, error: `Events can last at most ${MAX_EVENT_DAYS} days.` };
  }

  let recurrenceRule: string | null = null;
  const r = f.repeat;
  if (r.freq !== "NONE") {
    const rule: Recurrence = { freq: r.freq, interval: r.interval };
    if (r.freq === "WEEKLY") {
      if (!r.byDay.length) return { ok: false, error: "Pick at least one day to repeat on." };
      rule.byDay = WEEKDAYS.filter((d) => r.byDay.includes(d));
    }
    if (r.ends === "until") {
      if (!r.until) return { ok: false, error: "Pick the date the repeat ends." };
      if (r.until < f.startDate) return { ok: false, error: "The repeat must end after it starts." };
      rule.until = r.until;
    } else if (r.ends === "count") {
      if (!r.count) return { ok: false, error: "Say how many times it repeats." };
      rule.count = r.count;
    }
    recurrenceRule = buildRRule(rule);
  }

  return {
    ok: true,
    value: {
      title: f.title,
      notes: f.description,
      location: f.location,
      lifeAreaId: f.lifeAreaId,
      kind: f.kind,
      allDay: f.allDay,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone: f.timezone,
      recurrenceRule,
    },
  };
}
