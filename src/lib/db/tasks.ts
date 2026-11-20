import "server-only";

import { isUuid } from "@/lib/domain/context-items";
import type { TaskWrite } from "@/lib/domain/tasks";
import type { Task, TaskStatus } from "@/lib/domain/types";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { TaskRow } from "./database.types";

/**
 * Tasks: to-dos that are separate from calendar events.
 * Nothing here schedules a task onto the calendar.
 */

const MAX_TASKS = 1000;

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    lifeAreaId: row.life_area_id,
    description: row.description,
    goalId: row.goal_id,
    priority: row.priority,
    status: row.status,
    dueAt: row.due_at,
    estimatedMinutes: row.estimated_minutes,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Optional until the Phase 5 migration has run.
    postponeCount: row.postpone_count ?? 0,
    lastPostponedAt: row.last_postponed_at ?? null,
    parentTaskId: row.parent_task_id ?? null,
  };
}

/** Tasks not yet done, soonest due first. */
export async function listOpenTasks(userId: string, options: { limit?: number } = {}): Promise<Task[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "done")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(options.limit ?? 50);
  if (error) throw dbError(error);
  return data.map(toTask);
}

/** Open tasks plus tasks completed in the last `doneWithinDays` days. */
export async function listTasks(userId: string, options: { doneWithinDays?: number } = {}): Promise<Task[]> {
  const supabase = await requireDb();
  const since = new Date(Date.now() - (options.doneWithinDays ?? 30) * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .or(`status.neq.done,completed_at.gte."${since}",completed_at.is.null`)
    .order("created_at", { ascending: false })
    .limit(MAX_TASKS);
  if (error) throw dbError(error);
  return data.map(toTask);
}

function columns(v: TaskWrite) {
  return {
    title: v.title,
    description: v.description,
    life_area_id: v.lifeAreaId,
    goal_id: v.goalId,
    priority: v.priority,
    status: v.status,
    due_at: v.dueAt,
    estimated_minutes: v.estimatedMinutes,
  };
}

function friendly(error: { message: string; code?: string }) {
  if (error.code === "23503") return new DataValidationError("That life area or goal no longer exists.");
  if (error.code === "23514") return new DataValidationError("Some details are not valid. Check and try again.");
  return dbError(error);
}

/** `v` must come from validateTaskForm. */
export async function createTask(userId: string, v: TaskWrite): Promise<Task> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      ...columns(v),
      completed_at: v.status === "done" ? new Date().toISOString() : null,
    })
    .select("*")
    .single();
  if (error) throw friendly(error);
  return toTask(data);
}

export async function updateTask(userId: string, id: string, v: TaskWrite): Promise<Task> {
  if (!isUuid(id)) throw new NotFoundError("Task");
  const supabase = await requireDb();
  const { data: before, error: readError } = await supabase
    .from("tasks")
    .select("status, completed_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (readError) throw dbError(readError);
  if (!before) throw new NotFoundError("Task");

  const completedAt =
    v.status === "done" ? (before.status === "done" ? before.completed_at : new Date().toISOString()) : null;
  const { data, error } = await supabase
    .from("tasks")
    .update({ ...columns(v), completed_at: completedAt })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw friendly(error);
  if (!data) throw new NotFoundError("Task");
  return toTask(data);
}

export async function setTaskStatus(userId: string, id: string, status: TaskStatus): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Task");
  if (status !== "todo" && status !== "in_progress" && status !== "done") {
    throw new DataValidationError("Unknown status.");
  }
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("tasks")
    .update({ status, completed_at: status === "done" ? new Date().toISOString() : null })
    .eq("user_id", userId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Task");
}

export async function deleteTask(userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Task");
  const supabase = await requireDb();
  const { error } = await supabase.from("tasks").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}

export async function getTask(userId: string, id: string): Promise<Task> {
  if (!isUuid(id)) throw new NotFoundError("Task");
  const supabase = await requireDb();
  const { data, error } = await supabase.from("tasks").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Task");
  return toTask(data);
}

export type StepWrite = { title: string; estimatedMinutes: number; dueAt: string | null };

/**
 * Phase 7.3: saves the steps of a task as real tasks linked to it. They take
 * the parent's life area, goal and priority. Needs migration 20261129000000.
 */
export async function createSteps(userId: string, parent: Task, steps: StepWrite[]): Promise<Task[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("tasks")
    .insert(
      steps.map((s) => ({
        user_id: userId,
        title: s.title,
        description: null,
        life_area_id: parent.lifeAreaId ?? null,
        goal_id: parent.goalId ?? null,
        priority: parent.priority,
        status: "todo" as const,
        due_at: s.dueAt,
        estimated_minutes: s.estimatedMinutes,
        parent_task_id: parent.id,
      })),
    )
    .select("*");
  if (error) {
    if (error.code === "42703" || /parent_task_id/.test(error.message)) {
      throw new DataValidationError("Steps need the latest database update. Run migration 20261129000000 in Supabase.");
    }
    if (error.code === "23514") throw new DataValidationError("A step can't have its own steps.");
    throw friendly(error);
  }
  return data.map(toTask);
}
