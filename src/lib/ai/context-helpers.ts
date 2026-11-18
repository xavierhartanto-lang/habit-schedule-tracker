import type { Commitment, ContextCategory, ContextItem, Goal } from "@/lib/domain/types";
import { CONTEXT_CATEGORIES } from "@/lib/domain/types";
import type { OnboardingTopic, UserContext } from "./context";

/**
 * Pure helpers behind the user context builder. No database, no network,
 * so they are easy to test.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for `now` in the given IANA timezone. Falls back to UTC. */
export function localDateKey(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function shiftDateKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The current week (inclusive date keys) in the user's timezone. */
export function currentWeekRange(
  now: Date,
  timeZone: string,
  weekStartsOn: 0 | 1,
): { from: string; to: string } {
  const today = localDateKey(now, timeZone);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const from = shiftDateKey(today, -((dow - weekStartsOn + 7) % 7));
  return { from, to: shiftDateKey(from, 6) };
}

/** The planning window used for fixed one-off commitments: now to two weeks out. */
export function planningWindow(now: Date): { from: string; to: string } {
  return { from: now.toISOString(), to: new Date(now.getTime() + 14 * DAY_MS).toISOString() };
}

export function groupFacts(items: ContextItem[]): Record<ContextCategory, ContextItem[]> {
  const groups = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, [] as ContextItem[]])) as Record<
    ContextCategory,
    ContextItem[]
  >;
  for (const item of items) groups[item.category].push(item);
  return groups;
}

const ACTIVITY_AREAS = new Set(["extracurricular", "athletics", "creative"]);

export function computeCoverage(input: {
  commitments: { fixed: Commitment[]; flexible: Commitment[] };
  facts: Record<ContextCategory, ContextItem[]>;
  goals: Goal[];
}): Record<OnboardingTopic, boolean> {
  const { commitments, facts, goals } = input;
  const all = [...commitments.fixed, ...commitments.flexible];
  return {
    fixed_commitments: commitments.fixed.length > 0,
    activities: facts.activity.length > 0 || all.some((c) => c.area !== null && ACTIVITY_AREAS.has(c.area)),
    interests: facts.interest.length > 0,
    goals: goals.length > 0,
    routines: facts.routine.length > 0,
    working_times: facts.working_time.length > 0,
    scheduling_preferences: facts.preference.length > 0,
  };
}

/** Drops anything learned in conversation when memory is off. */
export function respectMemory<T extends { source?: string }>(rows: T[], memory: boolean): T[] {
  return memory ? rows : rows.filter((r) => r.source !== "conversation");
}

/** The context shared when personalization is off: nothing about the user's life. */
export function minimalContext(input: {
  now: Date;
  timezone: string;
  preferences: UserContext["preferences"];
  memory: boolean;
  onboardedAt: string | null;
}): UserContext {
  const facts = groupFacts([]);
  const commitments = { fixed: [], flexible: [] };
  return {
    generatedAt: input.now.toISOString(),
    permissions: { personalization: false, memory: input.memory },
    profile: { displayName: null, gradeLevel: null, school: null, timezone: input.timezone },
    preferences: input.preferences,
    onboardedAt: input.onboardedAt,
    commitments,
    facts,
    goals: [],
    openTasks: [],
    habits: [],
    recentConversations: [],
    coverage: computeCoverage({ commitments, facts, goals: [] }),
  };
}
