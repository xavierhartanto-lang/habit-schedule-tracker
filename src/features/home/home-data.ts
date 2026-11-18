import "server-only";

import { cache } from "react";
import { listEventsForRange } from "@/lib/db/events";
import { listOpenTasks } from "@/lib/db/tasks";
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
  error: boolean;
};

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
      error: true,
    };
  }
  if (ctx.state !== "ready") return { ctx, events: [], openTasks: [], error: false };
  try {
    const from = startOfDayInZone(addDaysToKey(ctx.todayKey, -1), ctx.timeZone).toISOString();
    const to = startOfDayInZone(addDaysToKey(ctx.todayKey, LOOKAHEAD_DAYS + 1), ctx.timeZone).toISOString();
    const [{ events }, openTasks] = await Promise.all([
      listEventsForRange(ctx.userId, { from, to }),
      listOpenTasks(ctx.userId, { limit: 200 }),
    ]);
    return { ctx, events, openTasks, error: false };
  } catch {
    return { ctx, events: [], openTasks: [], error: true };
  }
});
