import "server-only";

import { rezoneWallClock } from "@/lib/scheduling/zoned";
import { dbError, requireDb } from "./client";

/**
 * New profiles start in UTC. Anything the user created before the app
 * learned their real zone (often during onboarding) was read as UTC wall
 * clock: "debate Saturday 9 AM" became 9 AM UTC, which is 1 AM in Los Angeles.
 *
 * Called once, right after the profile moves off UTC. Keeps every saved wall
 * clock time and reads it in the new zone instead.
 */
export async function moveUtcTimesToZone(userId: string, timeZone: string): Promise<void> {
  const supabase = await requireDb();
  const shift = (iso: string | null) => (iso ? rezoneWallClock(iso, "UTC", timeZone) : null);

  const { data: commitments, error } = await supabase
    .from("commitments")
    .select("id, starts_at, ends_at, due_at, timezone")
    .eq("user_id", userId)
    .or("timezone.is.null,timezone.eq.UTC,timezone.eq.Etc/UTC");
  if (error) throw dbError(error);
  for (const c of commitments) {
    const { error: e } = await supabase
      .from("commitments")
      .update({ starts_at: shift(c.starts_at), ends_at: shift(c.ends_at), due_at: shift(c.due_at), timezone: timeZone })
      .eq("id", c.id)
      .eq("user_id", userId);
    if (e) throw dbError(e);
  }

  // Tasks have no zone of their own: every one that exists now was saved while the profile was UTC.
  const { data: tasks, error: tasksError } = await supabase
    .from("tasks")
    .select("id, due_at")
    .eq("user_id", userId)
    .not("due_at", "is", null);
  if (tasksError) throw dbError(tasksError);
  for (const t of tasks) {
    const { error: e } = await supabase.from("tasks").update({ due_at: shift(t.due_at) }).eq("id", t.id).eq("user_id", userId);
    if (e) throw dbError(e);
  }
}
