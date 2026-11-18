import "server-only";

import { validateGoalInput } from "@/lib/domain/goals";
import type { DataSource, Goal, GoalStatus } from "@/lib/domain/types";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { GoalMilestoneRow, GoalRow } from "./database.types";

/** Goals and their milestones. Milestones are read here; editing them comes later. */

function toGoal(row: GoalRow, milestones: GoalMilestoneRow[]): Goal {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    description: row.description,
    targetDate: row.target_date,
    status: row.status,
    horizon: row.horizon,
    source: row.source,
    milestones: milestones
      .filter((m) => m.goal_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((m) => ({ id: m.id, title: m.title, done: m.done_at !== null })),
  };
}

export async function listGoals(
  userId: string,
  options: { status?: GoalStatus; source?: DataSource; limit?: number } = {},
): Promise<Goal[]> {
  const supabase = await requireDb();
  let query = supabase
    .from("goals")
    .select("*")
    .eq("user_id", userId)
    .order("created_at")
    .limit(options.limit ?? 200);
  if (options.status) query = query.eq("status", options.status);
  if (options.source) query = query.eq("source", options.source);
  const { data: goals, error } = await query;
  if (error) throw dbError(error);
  if (!goals.length) return [];

  const { data: milestones, error: mError } = await supabase
    .from("goal_milestones")
    .select("*")
    .eq("user_id", userId)
    .in("goal_id", goals.map((g) => g.id));
  if (mError) throw dbError(mError);
  return goals.map((g) => toGoal(g, milestones));
}

/** Validates, then saves. Throws DataValidationError for bad input. */
export async function createGoal(userId: string, input: unknown): Promise<Goal> {
  const result = validateGoalInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const v = result.value;

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("goals")
    .insert({
      user_id: userId,
      title: v.title,
      area: v.area,
      description: v.description ?? null,
      target_date: v.targetDate ?? null,
      status: v.status ?? "active",
      horizon: v.horizon ?? null,
      source: v.source ?? "manual",
      source_message_id: v.sourceMessageId ?? null,
    })
    .select("*")
    .single();
  if (error) throw dbError(error);
  return toGoal(data, []);
}

/** Replaces a goal's editable fields. Its source never changes. */
export async function updateGoal(userId: string, id: string, input: unknown): Promise<Goal> {
  const result = validateGoalInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const v = result.value;

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("goals")
    .update({
      title: v.title,
      area: v.area,
      description: v.description ?? null,
      target_date: v.targetDate ?? null,
      status: v.status ?? "active",
      horizon: v.horizon ?? null,
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Goal");

  const { data: milestones, error: mError } = await supabase
    .from("goal_milestones")
    .select("*")
    .eq("user_id", userId)
    .eq("goal_id", id);
  if (mError) throw dbError(mError);
  return toGoal(data, milestones);
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("goals").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}
