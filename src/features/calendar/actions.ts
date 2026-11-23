"use server";

import { DataValidationError, NotFoundError } from "@/lib/db/client";
import { createEvent, deleteEvent, endSeriesBefore, getEvent, skipOccurrence, updateEvent } from "@/lib/db/events";
import { getProfile } from "@/lib/db/profiles";
import { isUuid } from "@/lib/domain/context-items";
import { validateEventForm } from "@/lib/domain/events";
import { dateKeyInZone, isDateKey, isValidTimeZone } from "@/lib/scheduling/zoned";
import { DEFAULT_PROFILE } from "@/features/settings/defaults";
import type { ActionResult } from "@/features/shared/action-result";
import { PLANNING_PATHS, runAction } from "@/features/shared/run-action";
import { stageForBookedEvent } from "@/features/automations/server/stage";
import { removeGoogleEvent } from "@/features/google/server/writes";

/**
 * Calendar writes. Every change here comes from the user pressing a
 * button: the app never creates, moves or deletes events on its own.
 */

const IMPORTED = "This event comes from Google Calendar. Ask Whitespace to move it, or change it in Google Calendar.";

/** The event form doesn't edit Google events (the assistant and Delete below do, in Google too). */
async function assertEditable(userId: string, id: string): Promise<void> {
  const event = await getEvent(userId, id);
  if (event.externalSource) throw new DataValidationError(IMPORTED);
}

export type EditScope = "single" | "series";
export type DeleteScope = "single" | "following" | "all";

/**
 * Creates or updates an event.
 * scope "single" on a recurring event detaches that one occurrence: it
 * becomes its own event and is skipped in the series.
 */
export async function saveEvent(args: {
  id: string | null;
  scope?: EditScope;
  occurrenceDate?: string | null;
  form: unknown;
}): Promise<ActionResult> {
  return runAction(PLANNING_PATHS, async (userId) => {
    const result = validateEventForm(args.form);
    if (!result.ok) throw new DataValidationError(result.error);
    const write = result.value;

    if (args.id === null) {
      const created = await createEvent(userId, write);
      await stageForBookedEvent(userId, created);
      return created;
    }
    if (!isUuid(args.id)) throw new NotFoundError("Event");
    await assertEditable(userId, args.id);

    if (args.scope === "single") {
      const date = args.occurrenceDate;
      if (!isDateKey(date)) throw new DataValidationError("Missing the date of this occurrence.");
      const series = await getEvent(userId, args.id);
      if (!series.recurrenceRule) return updateEvent(userId, args.id, write);
      const single = await createEvent(userId, { ...write, recurrenceRule: null });
      await stageForBookedEvent(userId, single);
      try {
        await skipOccurrence(userId, args.id, date);
      } catch (e) {
        await deleteEvent(userId, single.id).catch(() => {});
        throw e;
      }
      return single;
    }
    return updateEvent(userId, args.id, write);
  });
}

export async function removeEvent(args: {
  id: string;
  scope: DeleteScope;
  occurrenceDate?: string | null;
}): Promise<ActionResult> {
  return runAction(PLANNING_PATHS, async (userId) => {
    if (!isUuid(args.id)) throw new NotFoundError("Event");
    await assertEditable(userId, args.id);
    if (args.scope === "all") return deleteEvent(userId, args.id);

    const event = await getEvent(userId, args.id);
    if (!event.recurrenceRule) return deleteEvent(userId, args.id);
    const date = args.occurrenceDate;
    if (!isDateKey(date)) throw new DataValidationError("Missing the date of this occurrence.");
    if (args.scope === "single") return skipOccurrence(userId, args.id, date);

    const profileTz = (await getProfile(userId))?.timezone;
    const tz = isValidTimeZone(event.timezone)
      ? event.timezone
      : isValidTimeZone(profileTz)
        ? profileTz
        : DEFAULT_PROFILE.timezone;
    const firstDate = dateKeyInZone(new Date(event.startsAt!), tz);
    return endSeriesBefore(userId, args.id, date, firstDate);
  });
}

/**
 * Deletes a Google Calendar event from Google and from Whitespace.
 * "single" removes that occurrence; "all" the whole repeating series.
 */
export async function removeGoogleCalendarEvent(args: { id: string; scope: "single" | "all" }): Promise<ActionResult> {
  return runAction([...PLANNING_PATHS, "/insights"], async (userId) => {
    if (!isUuid(args.id)) throw new NotFoundError("Event");
    await removeGoogleEvent(userId, args.id, args.scope === "all" ? "series" : "one");
  });
}
