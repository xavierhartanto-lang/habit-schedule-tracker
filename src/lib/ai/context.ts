import type {
  Commitment,
  ContextCategory,
  ContextItem,
  Conversation,
  Goal,
  Habit,
  Preferences,
  Profile,
  Task,
} from "@/lib/domain/types";

/**
 * Structured user context the AI assistant receives.
 *
 * The assistant reads this snapshot instead of raw database rows, so what
 * the model can see is explicit, minimal and respects privacy settings:
 *
 * - personalization off: only timezone and day bounds are shared. No
 *   schedule, goals, habits, saved facts or past conversations.
 * - memory off: anything learned from conversations (source = conversation)
 *   and past conversation recaps are left out. Facts the user typed in
 *   themselves are still shared.
 *
 * Built server-side by `context-builder.ts`. Types only here, so client
 * components may import them.
 */

/** The things onboarding tries to learn, in the order it usually asks. */
export type OnboardingTopic =
  | "fixed_commitments"
  | "activities"
  | "interests"
  | "goals"
  | "routines"
  | "working_times"
  | "scheduling_preferences";

export const ONBOARDING_TOPICS: readonly OnboardingTopic[] = [
  "fixed_commitments",
  "activities",
  "interests",
  "goals",
  "routines",
  "working_times",
  "scheduling_preferences",
];

export type UserContext = {
  /** ISO time the snapshot was built. */
  generatedAt: string;
  permissions: { personalization: boolean; memory: boolean };
  profile: Pick<Profile, "displayName" | "gradeLevel" | "school" | "timezone">;
  preferences: Pick<Preferences, "dayStartTime" | "dayEndTime" | "weekStartsOn">;
  /** Null until onboarding is finished. */
  onboardedAt: string | null;
  /**
   * fixed: every repeating fixed commitment plus one-offs in the next two weeks.
   * flexible: open flexible work that is not long overdue.
   */
  commitments: { fixed: Commitment[]; flexible: Commitment[] };
  /** Activities, interests, routines, working times and preferences. */
  facts: Record<ContextCategory, ContextItem[]>;
  goals: Goal[];
  openTasks: Task[];
  /** completedOn covers the current week in the user's timezone. */
  habits: Habit[];
  /** Recaps of recent conversations (memory). Excludes the current one. */
  recentConversations: Pick<Conversation, "id" | "kind" | "title" | "summary" | "lastMessageAt">[];
  /** Which onboarding topics already have saved information. */
  coverage: Record<OnboardingTopic, boolean>;
};

export type BuildUserContextOptions = {
  /** Leave this conversation out of `recentConversations`. */
  excludeConversationId?: string;
  /** Defaults to now. Mainly for tests. */
  now?: Date;
};

export interface UserContextBuilder {
  build(userId: string, options?: BuildUserContextOptions): Promise<UserContext>;
}
