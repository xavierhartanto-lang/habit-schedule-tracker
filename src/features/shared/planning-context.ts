import "server-only";

import { connection } from "next/server";
import { cache } from "react";
import { getSessionUser } from "@/lib/auth/session";
import { listLifeAreas } from "@/lib/db/life-areas";
import { getPreferences, getProfile } from "@/lib/db/profiles";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { dateKeyInZone, isValidTimeZone } from "@/lib/scheduling/zoned";
import { DEFAULT_PREFERENCES, DEFAULT_PROFILE } from "@/features/settings/defaults";

/**
 * Everything a planning page needs before loading its own data: who is
 * signed in, their time zone, week start, today's date and life areas.
 * Reads cookies and the clock: render callers inside <Suspense>.
 */
export type PlanningContext =
  | { state: "preview" | "signed-out"; timeZone: string; weekStartsOn: 0 | 1; todayKey: string; areas: [] }
  | {
      state: "ready";
      userId: string;
      timeZone: string;
      weekStartsOn: 0 | 1;
      todayKey: string;
      areas: LifeAreaRecord[];
    };

/** Cached per request, so several sections of one page share a single load. */
export const loadPlanningContext = cache(async (): Promise<PlanningContext> => {
  // Reads the clock ("today"), so this always renders per request.
  await connection();
  const fallbackTz = DEFAULT_PROFILE.timezone;
  if (!isSupabaseConfigured()) {
    return {
      state: "preview",
      timeZone: fallbackTz,
      weekStartsOn: DEFAULT_PREFERENCES.weekStartsOn,
      todayKey: dateKeyInZone(new Date(), fallbackTz),
      areas: [],
    };
  }
  const user = await getSessionUser();
  if (!user) {
    return {
      state: "signed-out",
      timeZone: fallbackTz,
      weekStartsOn: DEFAULT_PREFERENCES.weekStartsOn,
      todayKey: dateKeyInZone(new Date(), fallbackTz),
      areas: [],
    };
  }
  // Errors propagate so the page can show its error state.
  const [profile, prefs, areas] = await Promise.all([
    getProfile(user.id),
    getPreferences(user.id),
    listLifeAreas(user.id),
  ]);
  const timeZone = isValidTimeZone(profile?.timezone) ? profile.timezone : fallbackTz;
  return {
    state: "ready",
    userId: user.id,
    timeZone,
    weekStartsOn: prefs?.weekStartsOn ?? DEFAULT_PREFERENCES.weekStartsOn,
    todayKey: dateKeyInZone(new Date(), timeZone),
    areas,
  };
});
