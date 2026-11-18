import "server-only";

import type { Habit } from "@/lib/domain/types";
import { dbError, requireDb } from "./client";
import type { HabitRow } from "./database.types";

/** Read access to habits. Habit tracking changes are outside Phase 2. */

function toHabit(row: HabitRow, completedOn: string[]): Habit {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    cadence:
      row.cadence === "daily"
        ? { type: "daily" }
        : { type: "weekly", timesPerWeek: row.times_per_week ?? 1 },
    completedOn,
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
    .limit(options.limit ?? 50);
  if (error) throw dbError(error);
  if (!habits.length) return [];

  const { data: logs, error: logError } = await supabase
    .from("habit_logs")
    .select("*")
    .eq("user_id", userId)
    .gte("logged_on", range.from)
    .lte("logged_on", range.to);
  if (logError) throw dbError(logError);

  return habits.map((h) =>
    toHabit(
      h,
      logs.filter((l) => l.habit_id === h.id).map((l) => l.logged_on).sort(),
    ),
  );
}
