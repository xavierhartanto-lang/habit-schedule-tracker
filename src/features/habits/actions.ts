"use server";

import { DataValidationError, NotFoundError } from "@/lib/db/client";
import { createGoal, deleteGoal, setGoalProgress, updateGoal } from "@/lib/db/goals";
import { createHabit, deleteHabit, setHabitDone, updateHabit } from "@/lib/db/habits";
import { isUuid } from "@/lib/domain/context-items";
import { validateHabitForm } from "@/lib/domain/habits";
import { addDaysToKey, dateKeyInZone, isDateKey } from "@/lib/scheduling/zoned";
import type { ActionResult } from "@/features/shared/action-result";
import { profileTimeZone } from "@/features/shared/profile-tz";
import { runAction } from "@/features/shared/run-action";

const PATHS = ["/", "/habits"];
const GOAL_PATHS = ["/", "/habits", "/tasks", "/about-you"];

// ---------- Habits ----------

export async function saveHabit(id: string | null, form: unknown): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    const result = validateHabitForm(form);
    if (!result.ok) throw new DataValidationError(result.error);
    if (id === null) return createHabit(userId, result.value);
    return updateHabit(userId, id, result.value);
  });
}

export async function removeHabit(id: string): Promise<ActionResult> {
  return runAction(PATHS, (userId) => deleteHabit(userId, id));
}

/** Checks a habit off (or un-checks it) for a day up to today, within the last year. */
export async function setHabitDay(habitId: string, date: string, done: boolean): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    if (!isUuid(habitId)) throw new NotFoundError("Habit");
    if (!isDateKey(date) || typeof done !== "boolean") throw new DataValidationError("Invalid date.");
    const today = dateKeyInZone(new Date(), await profileTimeZone(userId));
    if (date > today) throw new DataValidationError("You can't check off a day that hasn't happened yet.");
    if (date < addDaysToKey(today, -366)) throw new DataValidationError("That day is too far back to change.");
    await setHabitDone(userId, habitId, date, done);
  });
}

// ---------- Goals ----------

export async function saveGoalForm(id: string | null, form: unknown): Promise<ActionResult> {
  return runAction(GOAL_PATHS, async (userId) => {
    const input = { ...(form as object), source: "manual" };
    if (id === null) return createGoal(userId, input);
    if (!isUuid(id)) throw new NotFoundError("Goal");
    return updateGoal(userId, id, form);
  });
}

export async function updateGoalProgress(id: string, progress: number): Promise<ActionResult> {
  return runAction(GOAL_PATHS, async (userId) => {
    if (!isUuid(id)) throw new NotFoundError("Goal");
    await setGoalProgress(userId, id, progress);
  });
}

export async function removeGoalById(id: string): Promise<ActionResult> {
  return runAction(GOAL_PATHS, async (userId) => {
    if (!isUuid(id)) throw new NotFoundError("Goal");
    await deleteGoal(userId, id);
  });
}
