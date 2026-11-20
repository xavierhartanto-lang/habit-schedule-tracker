import "server-only";

import { isUuid } from "@/lib/domain/context-items";
import type { EventWrite } from "@/lib/domain/events";
import type { Commitment, SessionOutcome } from "@/lib/domain/types";
import { buildRRule, parseRRule } from "@/lib/scheduling/recurrence";
import { addDaysToKey, isDateKey } from "@/lib/scheduling/zoned";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import { toCommitment } from "./commitments";

/**
 * Calendar events, stored in the `commitments` table.
 * Only the user's own actions change events: nothing here moves or
 * creates events automatically.
 */

const MAX_EVENTS = 1000;

/**
 * Events that can appear between `from` and `to`: every recurring event
 * (expanded on the client), plus one-off events that overlap the window.
 * Also returns flexible activities that have no time yet.
 */
export async function listEventsForRange(
  userId: string,
  range: { from: string; to: string },
): Promise<{ events: Commitment[]; unplaced: Commitment[] }> {
  const supabase = await requireDb();
  const [timed, unplaced] = await Promise.all([
    supabase
      .from("commitments")
      .select("*")
      .eq("user_id", userId)
      .not("starts_at", "is", null)
      .or(`recurrence_rule.not.is.null,and(ends_at.gt."${range.from}",starts_at.lt."${range.to}")`)
      .order("starts_at")
      .limit(MAX_EVENTS),
    supabase
      .from("commitments")
      .select("*")
      .eq("user_id", userId)
      .is("starts_at", null)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(100),
  ]);
  if (timed.error) throw dbError(timed.error);
  if (unplaced.error) throw dbError(unplaced.error);
  return { events: timed.data.map(toCommitment), unplaced: unplaced.data.map(toCommitment) };
}

export async function getEvent(userId: string, id: string): Promise<Commitment> {
  if (!isUuid(id)) throw new NotFoundError("Event");
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Event");
  return toCommitment(data);
}

function columns(v: EventWrite) {
  return {
    title: v.title,
    notes: v.notes,
    location: v.location,
    life_area_id: v.lifeAreaId,
    kind: v.kind,
    all_day: v.allDay,
    starts_at: v.startsAt,
    ends_at: v.endsAt,
    timezone: v.timezone,
    recurrence_rule: v.recurrenceRule,
  };
}

/** `v` must come from validateEventForm. */
export async function createEvent(userId: string, v: EventWrite): Promise<Commitment> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .insert({ user_id: userId, source: "manual", ...columns(v) })
    .select("*")
    .single();
  if (error) throw friendly(error);
  return toCommitment(data);
}

/** Replaces an event (or a whole series). Skipped dates are kept when it still repeats. */
export async function updateEvent(userId: string, id: string, v: EventWrite): Promise<Commitment> {
  if (!isUuid(id)) throw new NotFoundError("Event");
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .update({
      ...columns(v),
      ...(v.recurrenceRule ? {} : { recurrence_exceptions: [] }),
      // A flexible activity that now has a time no longer needs these.
      estimated_minutes: null,
      due_at: null,
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw friendly(error);
  if (!data) throw new NotFoundError("Event");
  return toCommitment(data);
}

/** Removes one occurrence (local date) from a recurring series. */
export async function skipOccurrence(userId: string, id: string, date: string): Promise<void> {
  if (!isDateKey(date)) throw new DataValidationError("Invalid date.");
  const event = await getEvent(userId, id);
  if (!event.recurrenceRule) throw new DataValidationError("This event does not repeat.");
  const exceptions = Array.from(new Set([...(event.recurrenceExceptions ?? []), date])).sort();
  if (exceptions.length > 500) throw new DataValidationError("This series has too many skipped dates.");
  const supabase = await requireDb();
  const { error } = await supabase
    .from("commitments")
    .update({ recurrence_exceptions: exceptions })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw dbError(error);
}

/**
 * Ends a series before `date` (this and following occurrences are removed).
 * Deletes the series when `date` is its first occurrence.
 */
export async function endSeriesBefore(userId: string, id: string, date: string, firstDate: string): Promise<void> {
  if (!isDateKey(date) || !isDateKey(firstDate)) throw new DataValidationError("Invalid date.");
  const event = await getEvent(userId, id);
  const rule = parseRRule(event.recurrenceRule);
  if (!rule) throw new DataValidationError("This event does not repeat.");
  if (date <= firstDate) {
    await deleteEvent(userId, id);
    return;
  }
  const until = addDaysToKey(date, -1);
  const next = buildRRule({ ...rule, count: undefined, until: rule.until && rule.until < until ? rule.until : until });
  const supabase = await requireDb();
  const { error } = await supabase
    .from("commitments")
    .update({
      recurrence_rule: next,
      recurrence_exceptions: (event.recurrenceExceptions ?? []).filter((d) => d < date),
    })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw dbError(error);
}

export async function deleteEvent(userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Event");
  const supabase = await requireDb();
  const { error } = await supabase.from("commitments").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}

function friendly(error: { message: string; code?: string }) {
  if (error.code === "23503") return new DataValidationError("That life area no longer exists. Pick another.");
  if (error.code === "23514") return new DataValidationError("Some details are not valid. Check the times and try again.");
  return dbError(error);
}

// ---------------------------------------------------------------------------
// Phase 7: session outcomes (plan vs reality)
// ---------------------------------------------------------------------------

const OUTCOME_MISSING = "Recording sessions needs the Phase 7 database update (20261128000000). Run it in Supabase, then try again.";

function outcomeError(error: { message: string; code?: string }) {
  // Column missing: the migration hasn't run yet.
  if (error.code === "42703" || error.code === "PGRST204" || /outcome/.test(error.message)) return new DataValidationError(OUTCOME_MISSING);
  return dbError(error);
}

/**
 * Records what happened to a Whitespace work session that has started.
 * Only sessions (rows created from an approved plan) take an outcome;
 * calendar events never do. `outcome: null` clears it (undo).
 */
export async function setSessionOutcome(
  userId: string,
  id: string,
  outcome: SessionOutcome | null,
  now = new Date(),
): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Session");
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .update(
      outcome
        ? { outcome, outcome_at: now.toISOString(), outcome_source: "user" as const }
        : { outcome: null, outcome_at: null, outcome_source: null },
    )
    .eq("user_id", userId)
    .eq("id", id)
    .not("plan_item_id", "is", null)
    .lte("starts_at", now.toISOString())
    .select("id");
  if (error) throw outcomeError(error);
  if (!data.length) throw new NotFoundError("Session");
}

/**
 * The task is done, so its past sessions with nothing recorded count as
 * done. Best effort: returns quietly if the Phase 7 columns are missing.
 */
export async function markPastSessionsDone(userId: string, taskId: string, now = new Date()): Promise<void> {
  if (!isUuid(taskId)) return;
  const supabase = await requireDb();
  const { error } = await supabase
    .from("commitments")
    .update({ outcome: "done", outcome_at: now.toISOString(), outcome_source: "task_done" as const })
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .not("plan_item_id", "is", null)
    .is("outcome", null)
    .lte("ends_at", now.toISOString());
  if (error && !(error.code === "42703" || error.code === "PGRST204" || /outcome/.test(error.message))) throw dbError(error);
}
