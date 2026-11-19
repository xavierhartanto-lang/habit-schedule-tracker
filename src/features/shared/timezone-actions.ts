"use server";

import { revalidatePath } from "next/cache";

import { getSessionUser } from "@/lib/auth/session";
import { getProfile, updateProfile } from "@/lib/db/profiles";
import { isValidTimeZone } from "@/lib/scheduling/zoned";

/**
 * New profiles start in UTC, so greetings, "today" and due dates are off by
 * hours for everyone else. When the profile is still on that default, adopt
 * the browser's time zone. A zone the user picked in Settings is never changed.
 */
export async function adoptBrowserTimeZone(timeZone: string): Promise<{ changed: boolean }> {
  if (!isValidTimeZone(timeZone) || timeZone === "UTC" || timeZone === "Etc/UTC") return { changed: false };
  const user = await getSessionUser();
  if (!user) return { changed: false };
  try {
    const profile = await getProfile(user.id);
    if (!profile || profile.timezone !== "UTC") return { changed: false };
    await updateProfile(user.id, {
      displayName: profile.displayName,
      gradeLevel: profile.gradeLevel,
      school: profile.school,
      timezone: timeZone,
    });
  } catch {
    return { changed: false };
  }
  revalidatePath("/", "layout");
  return { changed: true };
}
