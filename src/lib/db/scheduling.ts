import "server-only";

import type { Commitment, Task } from "@/lib/domain/types";
import type { SchedulingPreferences } from "@/lib/scheduling/planner";
import { isValidTimeZone } from "@/lib/scheduling/zoned";
import { DEFAULT_PROFILE } from "@/features/settings/defaults";
import { listEventsForRange } from "./events";
import { getProfile } from "./profiles";
import { getSchedulingPreferences } from "./scheduling-preferences";
import { listOpenTasks } from "./tasks";

/**
 * Everything the scheduling engine needs about a user, read fresh from the
 * database as that user. Spread into PlanInput with `now` and `requests`,
 * or into checkPlacements at approval time.
 */
export async function loadSchedulingBase(
  userId: string,
  window: { start: string; end: string },
): Promise<{ timeZone: string; preferences: SchedulingPreferences; events: Commitment[]; openTasks: Task[] }> {
  const [profile, preferences, { events }, openTasks] = await Promise.all([
    getProfile(userId),
    getSchedulingPreferences(userId),
    listEventsForRange(userId, { from: window.start, to: window.end }),
    listOpenTasks(userId, { limit: 100 }),
  ]);
  const timeZone = isValidTimeZone(profile?.timezone) ? profile.timezone : DEFAULT_PROFILE.timezone;
  return { timeZone, preferences, events, openTasks };
}
