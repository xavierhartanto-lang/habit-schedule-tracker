import "server-only";

import { isUuid } from "@/lib/domain/context-items";
import type { HabitWrite } from "@/lib/domain/habits";
import { WEEKDAYS, type Habit, type HabitCadence } from "@/lib/domain/types";
import { isDateKey } from "@/lib/scheduling/zoned";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { HabitRow } from "./database.types";

/** Habits and their daily check-ins (habit_logs). */

const MAX_HABITS = 100;

function toCadence(row: HabitRow): HabitCadence {
  if (row.cadence === "daily") return { type: "daily" };
  if (row.cadence === "specific_days") {
    const days = WEEKDAYS.filter((_, i) => (row.weekdays ?? []).includes(i + 1));
    return days.length ? { type: "specific_days", days } : { type: "daily" };
  }
  return { type: "weekly", timesPerWeek: row.times_per_week ?? 1 };
}

function toHabit(row: HabitRow, completedOn: string[]): Habit {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    lifeAreaId: row.life_area_id,
    description: row.description,
    cadence: toCadence(row),
    completedOn,
    createdAt: row.created_at,
  };
}

function cadenceColumns(c: HabitCadence) {
  if (c.type === "daily") return { cadence: "daily" as const, times_per_week: null, weekdays: null };
  if (c.type === "weekly") return { cadence: "weekly" as const, times_per_week: c.timesPerWeek, weekdays: null };
  return {
    cadence: "specific_days" as const,
    times_per_week: null,
    weekdays: c.days.map((d) => WEEKDAYS.indexOf(d) + 1),
  };
}

/**
 * Active habits with the days they were completed in a date range.
 * `from` and `to` are YYYY-MM-DD, inclusive.
 */
export async function listActiveHabits(
  userId: string,
  range: { from: string; to: string },
  options: { limit?: number } = {},
): Promise<Habit[]> {
  const supabase = await requireDb();
  const { data: habits, error } = await supabase
    .from("habits")
    .select("*")
    .eq("user_id", userId)
    .is("archived_at", null)
    .order("created_at")
    .limit(options.limit ?? MAX_HABITS);
  if (error) throw dbError(error);
  if (!habits.length) return [];

  const { data: logs, error: logError } = await supabase
    .from("habit_logs")
    .select("habit_id, logged_on")
    .eq("user_id", userId)
    .in("habit_id", habits.map((h) => h.id))
    .gte("logged_on", range.from)
    .lte("logged_on", range.to)
    .limit(20_000);
  if (logError) throw dbError(logError);

  return habits.map((h) =>
    toHabit(
      h,
      logs.filter((l) => l.habit_id === h.id).map((l) => l.logged_on).sort(),
    ),
  );
}

function friendly(error: { message: string; code?: string }) {
  if (error.code === "23503") return new DataValidationError("That life area no longer exists. Pick another.");
  if (error.code === "23514") return new DataValidationError("Some details are not valid. Check and try again.");
  return dbError(error);
}

/** `v` must come from validateHabitForm. */
export async function createHabit(userId: string, v: HabitWrite): Promise<void> {
  const supabase = await requireDb();
  const { count, error: countError } = await supabase
    .from("habits")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("archived_at", null);
  if (countError) throw dbError(countError);
  if ((count ?? 0) >= MAX_HABITS) throw new DataValidationError(`You can track up to ${MAX_HABITS} habits.`);

  const { error } = await supabase.from("habits").insert({
    user_id: userId,
    title: v.title,
    description: v.description,
    life_area_id: v.lifeAreaId,
    ...cadenceColumns(v.cadence),
  });
  if (error) throw friendly(error);
}

export async function updateHabit(userId: string, id: string, v: HabitWrite): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Habit");
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("habits")
    .update({
      title: v.title,
      description: v.description,
      life_area_id: v.lifeAreaId,
      ...cadenceColumns(v.cadence),
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw friendly(error);
  if (!data) throw new NotFoundError("Habit");
}

export async function deleteHabit(userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Habit");
  const supabase = await requireDb();
  const { error } = await supabase.from("habits").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}

/** Marks a habit done (or not done) on a date. Idempotent. */
export async function setHabitDone(userId: string, habitId: string, date: string, done: boolean): Promise<void> {
  if (!isUuid(habitId)) throw new NotFoundError("Habit");
  if (!isDateKey(date)) throw new DataValidationError("Invalid date.");
  const supabase = await requireDb();
  if (done) {
    const { error } = await supabase
      .from("habit_logs")
      .upsert(
        { user_id: userId, habit_id: habitId, logged_on: date },
        { onConflict: "habit_id,logged_on", ignoreDuplicates: true },
      );
    if (error) {
      // The ownership trigger rejects habits that are not the user's.
      if (error.code === "P0001") throw new NotFoundError("Habit");
      throw dbError(error);
    }
    return;
  }
  const { error } = await supabase
    .from("habit_logs")
    .delete()
    .eq("user_id", userId)
    .eq("habit_id", habitId)
    .eq("logged_on", date);
  if (error) throw dbError(error);
}
