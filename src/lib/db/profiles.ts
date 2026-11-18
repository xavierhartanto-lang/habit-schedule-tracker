import "server-only";

import type { Preferences, Profile } from "@/lib/domain/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PreferencesRow, ProfileRow } from "./database.types";

/**
 * Data access for profiles and preferences.
 * Every query runs as the signed-in user, so RLS limits it to their own rows.
 */

function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.display_name,
    gradeLevel: row.grade_level,
    school: row.school,
    timezone: row.timezone,
  };
}

function toPreferences(row: PreferencesRow): Preferences {
  return {
    weekStartsOn: row.week_starts_on === 0 ? 0 : 1,
    dayStartTime: row.day_start_time.slice(0, 5),
    dayEndTime: row.day_end_time.slice(0, 5),
    aiPersonalizationEnabled: row.ai_personalization_enabled,
    aiMemoryEnabled: row.ai_memory_enabled,
    shareUsageAnalytics: row.share_usage_analytics,
  };
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data ? toProfile(data) : null;
}

export async function getPreferences(userId: string): Promise<Preferences | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? toPreferences(data) : null;
}

export async function updateProfile(
  userId: string,
  input: Pick<Profile, "displayName" | "gradeLevel" | "school" | "timezone">,
) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: input.displayName,
      grade_level: input.gradeLevel,
      school: input.school,
      timezone: input.timezone,
    })
    .eq("id", userId);
  if (error) throw error;
}

export async function updatePreferences(userId: string, input: Preferences) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase
    .from("user_preferences")
    .update({
      week_starts_on: input.weekStartsOn,
      day_start_time: input.dayStartTime,
      day_end_time: input.dayEndTime,
      ai_personalization_enabled: input.aiPersonalizationEnabled,
      ai_memory_enabled: input.aiMemoryEnabled,
      share_usage_analytics: input.shareUsageAnalytics,
    })
    .eq("user_id", userId);
  if (error) throw error;
}
