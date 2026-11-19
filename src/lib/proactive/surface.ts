import { z } from "zod";
import {
  DEFAULT_ASSISTANT_SETTINGS,
  PROACTIVITY_LEVELS,
  type AssistantSettings,
  type ProactivityLevel,
  type Recommendation,
  type RecommendationKind,
  type RecommendationPriority,
} from "@/features/proactive/types";
import { minutesInZone } from "@/lib/scheduling/zoned";

/**
 * Frequency controls: how many recommendations the assistant raises on
 * its own, which priorities count, how long before it raises the same one
 * again, and quiet hours. Pure.
 */

export const LEVEL_RULES: Record<ProactivityLevel, { limit: number; minPriority: RecommendationPriority; cooldownHours: number }> = {
  minimal: { limit: 1, minPriority: "high", cooldownHours: 72 },
  balanced: { limit: 2, minPriority: "medium", cooldownHours: 24 },
  proactive: { limit: 3, minPriority: "low", cooldownHours: 12 },
};

const PRIORITY_RANK: Record<RecommendationPriority, number> = { high: 0, medium: 1, low: 2 };

/** Within the same priority: what breaks a plan first, then hard deadlines, then softer nudges. */
const KIND_RANK: Record<RecommendationKind, number> = {
  plan_broken: 0,
  deadline_at_risk: 1,
  overdue: 2,
  deadline_soon: 3,
  overload_day: 4,
  missed_session: 5,
  postponed: 6,
  overload_week: 7,
  start_early: 8,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const assistantSettingsSchema = z
  .object({
    proactivity: z.enum(PROACTIVITY_LEVELS as unknown as [ProactivityLevel, ...ProactivityLevel[]], { error: "Pick how proactive the assistant should be." }),
    quietHoursStart: z.string().regex(HHMM, "Use a time like 22:00.").nullable(),
    quietHoursEnd: z.string().regex(HHMM, "Use a time like 07:00.").nullable(),
  })
  .refine((s) => (s.quietHoursStart === null) === (s.quietHoursEnd === null), "Set both a start and an end for quiet hours.")
  .refine((s) => s.quietHoursStart === null || s.quietHoursStart !== s.quietHoursEnd, "Quiet hours need a length.");

/** Stored value -> settings; anything malformed falls back to defaults. */
export function settingsFromRow(row: { proactivity?: string | null; quiet_hours_start?: string | null; quiet_hours_end?: string | null } | null): AssistantSettings {
  if (!row) return DEFAULT_ASSISTANT_SETTINGS;
  const parsed = assistantSettingsSchema.safeParse({
    proactivity: row.proactivity ?? DEFAULT_ASSISTANT_SETTINGS.proactivity,
    // Postgres returns "22:00:00".
    quietHoursStart: row.quiet_hours_start ? row.quiet_hours_start.slice(0, 5) : null,
    quietHoursEnd: row.quiet_hours_end ? row.quiet_hours_end.slice(0, 5) : null,
  });
  return parsed.success ? parsed.data : DEFAULT_ASSISTANT_SETTINGS;
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** True inside quiet hours, in the user's time zone. End before start crosses midnight. */
export function isQuietTime(now: Date, timeZone: string, s: AssistantSettings): boolean {
  if (!s.quietHoursStart || !s.quietHoursEnd) return false;
  const m = minutesInZone(now, timeZone);
  const start = toMinutes(s.quietHoursStart);
  const end = toMinutes(s.quietHoursEnd);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export function raisedRecently(lastShownAt: string | null, level: ProactivityLevel, now: Date): boolean {
  if (!lastShownAt) return false;
  return now.getTime() - Date.parse(lastShownAt) < LEVEL_RULES[level].cooldownHours * 3_600_000;
}

export function rank<T extends Pick<Recommendation, "priority" | "kind" | "target">>(recs: readonly T[]): T[] {
  return recs
    .slice()
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (a.target.date ?? "9999").localeCompare(b.target.date ?? "9999"),
    );
}

/**
 * What the assistant raises on Home: open recommendations at or above the
 * level's priority, fresh ones first, at most the level's limit. Nothing
 * during quiet hours. `all` returns every open one, ranked.
 */
export function surface(
  recs: readonly Recommendation[],
  input: { settings: AssistantSettings; now: Date; timeZone: string; mode: "home" | "all" },
): Recommendation[] {
  const open = rank(recs.filter((r) => r.status === "open"));
  if (input.mode === "all") return open;
  if (isQuietTime(input.now, input.timeZone, input.settings)) return [];
  const rule = LEVEL_RULES[input.settings.proactivity];
  const eligible = open.filter((r) => PRIORITY_RANK[r.priority] <= PRIORITY_RANK[rule.minPriority]);
  const fresh = eligible.filter((r) => !r.raisedRecently);
  const quiet = eligible.filter((r) => r.raisedRecently);
  return [...fresh, ...quiet].slice(0, rule.limit);
}
