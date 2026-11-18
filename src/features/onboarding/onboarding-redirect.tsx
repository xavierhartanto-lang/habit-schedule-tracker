import { getSessionUser } from "@/lib/auth/session";
import { getOnboardedAt } from "@/lib/db/profiles";
import { redirect } from "next/navigation";

/**
 * Sends signed-in users who haven't finished (or skipped) setup to the
 * onboarding conversation. Renders nothing. Reads cookies, so it must sit
 * inside <Suspense>.
 */
export async function OnboardingRedirect() {
  const user = await getSessionUser();
  if (!user) return null;
  const onboardedAt = await getOnboardedAt(user.id).catch(() => "unknown");
  if (onboardedAt === null) redirect("/onboarding");
  return null;
}
