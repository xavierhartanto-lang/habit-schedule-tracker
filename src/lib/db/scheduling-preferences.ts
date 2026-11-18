import "server-only";

import {
  defaultSchedulingPreferences,
  schedulingPreferencesSchema,
  type SchedulingPreferences,
} from "@/lib/scheduling/planner";
import { DataValidationError, dbError, requireDb } from "./client";
import type { Json, SchedulingPreferencesRow } from "./database.types";
import { getPreferences } from "./profiles";

/**
 * Scheduling preferences (working hours, protected time, session lengths,
 * buffers, daily limits) for the scheduling engine. RLS limits every
 * query to the signed-in user's own row.
 */

function fromRow(row: SchedulingPreferencesRow, fallback: SchedulingPreferences): SchedulingPreferences {
  const parsed = schedulingPreferencesSchema.safeParse({
    workingHours: { ...fallback.workingHours, ...(row.working_hours as object) },
    protectedTimes: row.protected_times,
    minSessionMinutes: row.min_session_minutes,
    maxSessionMinutes: row.max_session_minutes,
    bufferMinutes: row.buffer_minutes,
    dailyCapMinutes: row.daily_cap_minutes,
    keepFreePercent: row.keep_free_percent,
  });
  // A malformed stored value never breaks planning: fall back to defaults.
  return parsed.success ? parsed.data : fallback;
}

/** Saved preferences, or defaults built from the user's day start and end. */
export async function getSchedulingPreferences(userId: string): Promise<SchedulingPreferences> {
  const supabase = await requireDb();
  const [{ data, error }, prefs] = await Promise.all([
    supabase.from("scheduling_preferences").select("*").eq("user_id", userId).maybeSingle(),
    getPreferences(userId),
  ]);
  if (error) throw dbError(error);
  const fallback = defaultSchedulingPreferences({
    dayStartTime: prefs?.dayStartTime ?? "07:00",
    dayEndTime: prefs?.dayEndTime ?? "22:30",
  });
  return data ? fromRow(data, fallback) : fallback;
}

/** Validates and saves. Throws DataValidationError with a readable message. */
export async function saveSchedulingPreferences(userId: string, input: unknown): Promise<SchedulingPreferences> {
  const parsed = schedulingPreferencesSchema.safeParse(input);
  if (!parsed.success) throw new DataValidationError(parsed.error.issues[0]?.message ?? "Invalid scheduling preferences.");
  const p = parsed.data;
  const supabase = await requireDb();
  const { error } = await supabase.from("scheduling_preferences").upsert(
    {
      user_id: userId,
      working_hours: p.workingHours as unknown as Json,
      protected_times: p.protectedTimes as unknown as Json,
      min_session_minutes: p.minSessionMinutes,
      max_session_minutes: p.maxSessionMinutes,
      buffer_minutes: p.bufferMinutes,
      daily_cap_minutes: p.dailyCapMinutes,
      keep_free_percent: p.keepFreePercent,
    },
    { onConflict: "user_id" },
  );
  if (error) throw dbError(error);
  return p;
}
