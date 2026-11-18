import "server-only";

import type { Task } from "@/lib/domain/types";
import { dbError, requireDb } from "./client";
import type { TaskRow } from "./database.types";

/** Read access to tasks. Editing tasks is outside Phase 2. */

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    priority: row.priority,
    status: row.status,
    dueAt: row.due_at,
    estimatedMinutes: row.estimated_minutes,
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
