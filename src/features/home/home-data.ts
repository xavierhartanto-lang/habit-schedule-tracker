import "server-only";

import { cache } from "react";
import { listEventsForRange } from "@/lib/db/events";
import { getSchedulingPreferences } from "@/lib/db/scheduling-preferences";
import { listOpenTasks } from "@/lib/db/tasks";
import type { SchedulingPreferences } from "@/lib/scheduling/planner";
import type { Commitment, Task } from "@/lib/domain/types";
import { addDaysToKey, startOfDayInZone } from "@/lib/scheduling/zoned";
import { loadPlanningContext, type PlanningContext } from "@/features/shared/planning-context";

export const HOME_DAYS_AHEAD = 7;
/** The assistant's opening line can mention an exam up to two weeks out. */
export const LOOKAHEAD_DAYS = 14;

export type HomeData = {
  ctx: PlanningContext;
  /** Events that can occur from today through the next two weeks (expand on render). */
  events: Commitment[];
  openTasks: Task[];
  /** Scheduling settings (working hours, caps). Null when they couldn't be read. */
  preferences: SchedulingPreferences | null;
  error: boolean;
};

/**
 * Days loaded around today. Wide enough to cover the Phase 5 engine's
 * window (now - 3 days to now + 16 days), so the engine reuses this load
 * instead of reading events and tasks a second time.
 */
const BEHIND_DAYS = 3;
const AHEAD_DAYS = 17;

/** One load shared by every Home section. Render callers inside <Suspense>. */
export const loadHomeData = cache(async (): Promise<HomeData> => {
  let ctx: PlanningContext;
  try {
    ctx = await loadPlanningContext();
  } catch {
    return {
      ctx: { state: "signed-out", timeZone: "UTC", weekStartsOn: 1, todayKey: "1970-01-01", areas: [] },
      events: [],
      openTasks: [],
      preferences: null,
      error: true,
    };
  }
  if (ctx.state !== "ready") return { ctx, events: [], openTasks: [], preferences: null, error: false };
  try {
    const from = startOfDayInZone(addDaysToKey(ctx.todayKey, -BEHIND_DAYS), ctx.timeZone).toISOString();
    const to = startOfDayInZone(addDaysToKey(ctx.todayKey, Math.max(AHEAD_DAYS, LOOKAHEAD_DAYS + 1)), ctx.timeZone).toISOString();
    const [{ events }, openTasks, preferences] = await Promise.all([
      listEventsForRange(ctx.userId, { from, to }),
      listOpenTasks(ctx.userId, { limit: 200 }),
      // Optional: without it the engine reads its own copy.
      getSchedulingPreferences(ctx.userId).catch(() => null),
    ]);
    return { ctx, events, openTasks, preferences, error: false };
  } catch {
    return { ctx, events: [], openTasks: [], preferences: null, error: true };
  }
});
