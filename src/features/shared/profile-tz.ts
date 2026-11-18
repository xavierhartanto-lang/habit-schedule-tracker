import "server-only";

import { getProfile } from "@/lib/db/profiles";
import { isValidTimeZone } from "@/lib/scheduling/zoned";
import { DEFAULT_PROFILE } from "@/features/settings/defaults";

/** The user's profile time zone, used to interpret dates typed into forms. */
export async function profileTimeZone(userId: string): Promise<string> {
  const tz = (await getProfile(userId))?.timezone;
  return isValidTimeZone(tz) ? tz : DEFAULT_PROFILE.timezone;
}
