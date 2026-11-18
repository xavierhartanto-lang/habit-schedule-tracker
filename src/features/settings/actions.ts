"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { updatePreferences, updateProfile } from "@/lib/db/profiles";

export type SaveState = { ok?: boolean; error?: string } | undefined;

export async function saveProfile(_: SaveState, formData: FormData): Promise<SaveState> {
  const user = await getSessionUser();
  if (!user) return { error: "Sign in to save your profile." };

  const grade = Number(formData.get("gradeLevel"));
  try {
    await updateProfile(user.id, {
      displayName: String(formData.get("displayName") ?? "").trim() || null,
      gradeLevel: Number.isInteger(grade) && grade >= 6 && grade <= 13 ? grade : null,
      school: String(formData.get("school") ?? "").trim() || null,
      timezone: String(formData.get("timezone") ?? "UTC"),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save." };
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function savePreferences(_: SaveState, formData: FormData): Promise<SaveState> {
  const user = await getSessionUser();
  if (!user) return { error: "Sign in to save your preferences." };

  const time = (v: FormDataEntryValue | null, fallback: string) =>
    typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : fallback;

  try {
    await updatePreferences(user.id, {
      weekStartsOn: formData.get("weekStartsOn") === "0" ? 0 : 1,
      dayStartTime: time(formData.get("dayStartTime"), "07:00"),
      dayEndTime: time(formData.get("dayEndTime"), "22:30"),
      aiPersonalizationEnabled: formData.get("aiPersonalizationEnabled") === "on",
      aiMemoryEnabled: formData.get("aiMemoryEnabled") === "on",
      shareUsageAnalytics: formData.get("shareUsageAnalytics") === "on",
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save." };
  }
  revalidatePath("/settings");
  return { ok: true };
}
