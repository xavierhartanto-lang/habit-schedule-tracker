"use server";

import { lookupBellSchedule, type BellLookupResult } from "@/lib/ai/bell-lookup";
import { isAiConfigured } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { getSessionUser } from "@/lib/auth/session";
import { saveSchoolSchedule, skipSchoolSchedule } from "@/lib/db/school-schedules";
import type { ActionResult } from "@/features/shared/action-result";
import { profileTimeZone } from "@/features/shared/profile-tz";
import { PLANNING_PATHS, runAction } from "@/features/shared/run-action";
import { adoptBrowserTimeZone } from "@/features/shared/timezone-actions";

/**
 * Bell schedule setup. Lookup never saves anything: it only pre-fills the
 * card. Save writes the schedule and its repeating "School" events in one
 * transaction, and only when the user taps Save.
 */

const PATHS = [...PLANNING_PATHS, "/onboarding", "/school-schedule", "/settings"];

export type LookupActionResult = { ok: true; result: BellLookupResult } | { ok: false; error: string };

export async function lookupSchoolBellSchedule(input: { school: string; district: string }): Promise<LookupActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in first." };
  if (!isAiConfigured()) return { ok: true, result: { found: false, reason: "Lookup needs the assistant, which isn't set up." } };
  const school = String(input.school ?? "").trim();
  if (school.length < 2) return { ok: false, error: "Type your school's name." };
  try {
    const result = await lookupBellSchedule({ school, district: String(input.district ?? "").trim() || null });
    return { ok: true, result };
  } catch (e) {
    if (!(e instanceof AiError)) console.error("[school-schedule] lookup failed", e);
    // A failed lookup is never a dead end: the card opens blank instead.
    return { ok: true, result: { found: false, reason: "The lookup didn't finish." } };
  }
}

export async function saveSchoolBellSchedule(input: {
  schedule: unknown;
  school: string;
  district: string;
  /** This device's zone. Used only while the profile is still on the UTC default (new users land here first). */
  browserTimeZone?: string;
}): Promise<ActionResult> {
  if (input.browserTimeZone) await adoptBrowserTimeZone(String(input.browserTimeZone)).catch(() => undefined);
  return runAction(PATHS, async (userId) => {
    const timeZone = await profileTimeZone(userId);
    await saveSchoolSchedule(userId, {
      schedule: input.schedule,
      school: String(input.school ?? ""),
      district: String(input.district ?? ""),
      timeZone,
    });
  });
}

export async function skipSchoolBellSchedule(input: { school: string; district: string }): Promise<ActionResult> {
  return runAction(PATHS, (userId) =>
    skipSchoolSchedule(userId, { school: String(input.school ?? ""), district: String(input.district ?? "") }),
  );
}
