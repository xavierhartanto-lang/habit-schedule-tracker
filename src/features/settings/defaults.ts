import type { Preferences, Profile } from "@/lib/domain/types";

export const DEFAULT_PROFILE: Omit<Profile, "id"> = {
  displayName: null,
  gradeLevel: null,
  school: null,
  timezone: "America/Los_Angeles",
};

export const DEFAULT_PREFERENCES: Preferences = {
  weekStartsOn: 1,
  dayStartTime: "07:00",
  dayEndTime: "22:30",
  aiPersonalizationEnabled: true,
  aiMemoryEnabled: true,
  shareUsageAnalytics: false,
};
