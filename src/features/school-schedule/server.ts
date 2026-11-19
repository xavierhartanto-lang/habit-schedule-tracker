import "server-only";

import { cache } from "react";
import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/db/profiles";
import { getSchoolSchedule, type StoredSchoolSchedule } from "@/lib/db/school-schedules";

export type SchoolScheduleState =
  | { state: "signed_out" }
  /** Table missing (migration not run) or a read failed: never block the user on this. */
  | { state: "unavailable" }
  | { state: "ready"; stored: StoredSchoolSchedule; profileSchool: string | null };

export const loadSchoolSchedule = cache(async (): Promise<SchoolScheduleState> => {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { state: "signed_out" };
  try {
    const [stored, profile] = await Promise.all([getSchoolSchedule(user.id), getProfile(user.id)]);
    return { state: "ready", stored, profileSchool: profile?.school ?? null };
  } catch (error) {
    console.error("[school-schedule] load failed (has the school_schedules migration run?)", error);
    return { state: "unavailable" };
  }
});
