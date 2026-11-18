import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/db/profiles";

/** ", Maya" when a profile name exists. Reads the session: render inside <Suspense>. */
export async function FirstName() {
  const user = await getSessionUser();
  if (!user) return null;
  const profile = await getProfile(user.id);
  const first = profile?.displayName?.split(" ")[0];
  return first ? <>, {first}</> : null;
}
