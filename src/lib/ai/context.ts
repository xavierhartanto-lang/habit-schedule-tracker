import type {
  Commitment,
  Goal,
  Habit,
  Preferences,
  Profile,
  Task,
} from "@/lib/domain/types";

/**
 * Structured user context the AI assistant will receive in a later phase.
 *
 * The assistant reads this snapshot instead of raw database rows, so what
 * the model can see is explicit, minimal and respects privacy settings
 * (e.g. aiPersonalizationEnabled = false means only the current request is shared).
 *
 * No AI functionality is implemented yet. This file only defines the shape.
 */
export type UserContext = {
  profile: Pick<Profile, "displayName" | "gradeLevel" | "timezone">;
  preferences: Pick<Preferences, "dayStartTime" | "dayEndTime" | "weekStartsOn">;
  week: {
    fixed: Commitment[];
    flexible: Commitment[];
  };
  openTasks: Task[];
  habits: Habit[];
  goals: Goal[];
};

export interface UserContextBuilder {
  build(userId: string): Promise<UserContext>;
}
