"use server";

import { DataValidationError } from "@/lib/db/client";
import { createTask, deleteTask, setTaskStatus, updateTask } from "@/lib/db/tasks";
import { validateTaskForm } from "@/lib/domain/tasks";
import type { TaskStatus } from "@/lib/domain/types";
import type { ActionResult } from "@/features/shared/action-result";
import { profileTimeZone } from "@/features/shared/profile-tz";
import { runAction } from "@/features/shared/run-action";

/** Task writes. Tasks are never placed on the calendar automatically. */

const PATHS = ["/", "/tasks"];

export async function saveTask(id: string | null, form: unknown): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    // Dates are read in the user's profile time zone, whatever the browser says.
    const timezone = await profileTimeZone(userId);
    const result = validateTaskForm({ ...(form as object), timezone });
    if (!result.ok) throw new DataValidationError(result.error);
    if (id === null) return createTask(userId, result.value);
    return updateTask(userId, id, result.value);
  });
}

export async function setTaskDone(id: string, done: boolean): Promise<ActionResult> {
  const status: TaskStatus = done ? "done" : "todo";
  return runAction(PATHS, (userId) => setTaskStatus(userId, id, status));
}

export async function removeTask(id: string): Promise<ActionResult> {
  return runAction(PATHS, (userId) => deleteTask(userId, id));
}
