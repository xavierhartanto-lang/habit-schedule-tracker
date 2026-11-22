import "server-only";

import { validateCommitmentInput } from "@/lib/domain/commitments";
import type { Commitment, CommitmentKind, DataSource, LifeArea } from "@/lib/domain/types";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { CommitmentRow } from "./database.types";

/**
 * Fixed commitments (school, practice, work) and flexible work.
 * This module only stores what the user entered or confirmed.
 * It never places or moves anything on the calendar by itself.
 */

export function toCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    lifeAreaId: row.life_area_id,
    allDay: row.all_day,
    timezone: row.timezone,
    recurrenceExceptions: row.recurrence_exceptions ?? [],
    kind: row.kind,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    estimatedMinutes: row.estimated_minutes,
    dueAt: row.due_at,
    location: row.location,
    recurrenceRule: row.recurrence_rule,
    notes: row.notes,
    source: row.source,
    taskId: row.task_id ?? null,
    planItemId: row.plan_item_id ?? null,
    externalSource: row.external_source ?? null,
    externalUrl: row.external_url ?? null,
    externalSeriesId: row.external_series_id ?? null,
    externalAccess: row.external_access ?? null,
    externalShared: row.external_shared ?? false,
    outcome: row.outcome ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Explicit life area wins; otherwise the legacy enum is written and the
 * database maps it to the user's matching life area.
 */
function areaColumns(v: { area: LifeArea | null; lifeAreaId?: string | null }) {
  return v.lifeAreaId !== undefined ? { life_area_id: v.lifeAreaId } : { area: v.area };
}

export async function listCommitments(
  userId: string,
  options: { kind?: CommitmentKind; source?: DataSource; limit?: number } = {},
): Promise<Commitment[]> {
  const supabase = await requireDb();
  let query = supabase
    .from("commitments")
    .select("*")
    .eq("user_id", userId)
    .order("starts_at", { ascending: true, nullsFirst: false })
    .limit(options.limit ?? 500);
  if (options.kind) query = query.eq("kind", options.kind);
  if (options.source) query = query.eq("source", options.source);
  const { data, error } = await query;
  if (error) throw dbError(error);
  return data.map(toCommitment);
}

/**
 * Commitments relevant to planning from `from` to `to`:
 * every repeating fixed commitment, one-off fixed ones that overlap the
 * window, and flexible work that is not overdue by more than a day.
 */
export async function listCommitmentsForWindow(
  userId: string,
  window: { from: string; to: string },
  options: { source?: DataSource; limit?: number } = {},
): Promise<{ fixed: Commitment[]; flexible: Commitment[] }> {
  const supabase = await requireDb();
  const limit = options.limit ?? 100;
  const graceStart = new Date(Date.parse(window.from) - 24 * 60 * 60 * 1000).toISOString();

  let fixedQuery = supabase
    .from("commitments")
    .select("*")
    .eq("user_id", userId)
    .eq("kind", "fixed")
    .or(`recurrence_rule.not.is.null,and(ends_at.gte."${window.from}",starts_at.lt."${window.to}")`)
    .order("starts_at")
    .limit(limit);
  let flexibleQuery = supabase
    .from("commitments")
    .select("*")
    .eq("user_id", userId)
    .eq("kind", "flexible")
    .or(`due_at.is.null,due_at.gte."${graceStart}"`)
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (options.source) {
    fixedQuery = fixedQuery.eq("source", options.source);
    flexibleQuery = flexibleQuery.eq("source", options.source);
  }

  const [fixed, flexible] = await Promise.all([fixedQuery, flexibleQuery]);
  if (fixed.error) throw dbError(fixed.error);
  if (flexible.error) throw dbError(flexible.error);
  return { fixed: fixed.data.map(toCommitment), flexible: flexible.data.map(toCommitment) };
}

/** Validates, then saves. Throws DataValidationError for bad input. */
export async function createCommitment(userId: string, input: unknown): Promise<Commitment> {
  const result = validateCommitmentInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const v = result.value;

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .insert({
      user_id: userId,
      title: v.title,
      ...areaColumns(v),
      kind: v.kind,
      starts_at: v.startsAt ?? null,
      ends_at: v.endsAt ?? null,
      recurrence_rule: v.recurrenceRule ?? null,
      estimated_minutes: v.estimatedMinutes ?? null,
      due_at: v.dueAt ?? null,
      location: v.location ?? null,
      notes: v.notes ?? null,
      source: v.source ?? "manual",
      source_message_id: v.sourceMessageId ?? null,
    })
    .select("*")
    .single();
  if (error) throw dbError(error);
  return toCommitment(data);
}

/** Replaces a commitment's editable fields. Its source never changes. */
export async function updateCommitment(
  userId: string,
  id: string,
  input: unknown,
): Promise<Commitment> {
  const result = validateCommitmentInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const v = result.value;

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("commitments")
    .update({
      title: v.title,
      ...areaColumns(v),
      kind: v.kind,
      starts_at: v.startsAt ?? null,
      ends_at: v.endsAt ?? null,
      recurrence_rule: v.recurrenceRule ?? null,
      estimated_minutes: v.estimatedMinutes ?? null,
      due_at: v.dueAt ?? null,
      location: v.location ?? null,
      notes: v.notes ?? null,
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Commitment");
  return toCommitment(data);
}

export async function deleteCommitment(userId: string, id: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("commitments").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}
