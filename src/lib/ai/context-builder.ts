import "server-only";

import { requireDb } from "@/lib/db/client";
import { listCommitmentsForWindow } from "@/lib/db/commitments";
import { listContextItems } from "@/lib/db/context-items";
import { listConversations } from "@/lib/db/conversations";
import { listGoals } from "@/lib/db/goals";
import { listActiveHabits } from "@/lib/db/habits";
import { getOnboardedAt, getPreferences, getProfile } from "@/lib/db/profiles";
import { listOpenTasks } from "@/lib/db/tasks";
import type { BuildUserContextOptions, UserContext, UserContextBuilder } from "./context";
import {
  computeCoverage,
  currentWeekRange,
  groupFacts,
  minimalContext,
  planningWindow,
  respectMemory,
} from "./context-helpers";

/**
 * Builds the UserContext snapshot from Supabase, as the signed-in user.
 *
 * Throws SupabaseNotConfiguredError when Supabase env vars are missing and
 * DatabaseError when a query fails. It never fills gaps with guesses:
 * missing information stays missing so the assistant asks instead.
 */

const DEFAULT_PREFERENCES: UserContext["preferences"] = {
  dayStartTime: "07:00",
  dayEndTime: "22:30",
  weekStartsOn: 1,
};

const RECENT_CONVERSATIONS = 5;

export const userContextBuilder: UserContextBuilder = {
  async build(userId: string, options: BuildUserContextOptions = {}): Promise<UserContext> {
    await requireDb();
    const now = options.now ?? new Date();

    const [profile, prefs, onboardedAt] = await Promise.all([
      getProfile(userId),
      getPreferences(userId),
      getOnboardedAt(userId),
    ]);

    const timezone = profile?.timezone ?? "UTC";
    const preferences = prefs
      ? { dayStartTime: prefs.dayStartTime, dayEndTime: prefs.dayEndTime, weekStartsOn: prefs.weekStartsOn }
      : DEFAULT_PREFERENCES;
    const personalization = prefs?.aiPersonalizationEnabled ?? true;
    const memory = prefs?.aiMemoryEnabled ?? true;

    if (!personalization) {
      return minimalContext({ now, timezone, preferences, memory, onboardedAt });
    }

    const [commitments, items, goals, openTasks, habits, conversations] = await Promise.all([
      listCommitmentsForWindow(userId, planningWindow(now)),
      listContextItems(userId, { limit: 300 }),
      listGoals(userId, { status: "active", limit: 50 }),
      listOpenTasks(userId, { limit: 50 }),
      listActiveHabits(userId, currentWeekRange(now, timezone, preferences.weekStartsOn)),
      memory
        ? listConversations(userId, { limit: RECENT_CONVERSATIONS + 1 })
        : Promise.resolve([]),
    ]);

    const shared = {
      commitments: {
        fixed: respectMemory(commitments.fixed, memory),
        flexible: respectMemory(commitments.flexible, memory),
      },
      facts: groupFacts(respectMemory(items, memory)),
      goals: respectMemory(goals, memory),
    };

    return {
      generatedAt: now.toISOString(),
      permissions: { personalization, memory },
      profile: {
        displayName: profile?.displayName ?? null,
        gradeLevel: profile?.gradeLevel ?? null,
        school: profile?.school ?? null,
        timezone,
      },
      preferences,
      onboardedAt,
      ...shared,
      openTasks,
      habits,
      recentConversations: conversations
        .filter((c) => c.id !== options.excludeConversationId)
        .slice(0, RECENT_CONVERSATIONS)
        .map(({ id, kind, title, summary, lastMessageAt }) => ({ id, kind, title, summary, lastMessageAt })),
      coverage: computeCoverage(shared),
    };
  },
};

export function buildUserContext(userId: string, options?: BuildUserContextOptions) {
  return userContextBuilder.build(userId, options);
}
