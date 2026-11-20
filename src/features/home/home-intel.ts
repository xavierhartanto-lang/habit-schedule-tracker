import "server-only";

import { cache } from "react";
import { isAiConfigured } from "@/lib/ai/config";
import { listGoals } from "@/lib/db/goals";
import { listTasks } from "@/lib/db/tasks";
import type { Analysis } from "@/lib/proactive/analyze";
import type { ProactiveState } from "@/features/proactive/types";
import { loadProactiveWithAnalysis } from "@/features/proactive/server/service";
import { loadHomeData } from "./home-data";
import { EMPTY_PROACTIVE, homeProactive, shownIds, type HomeProactive } from "./proactive";
import { selectSections } from "./adaptive/select";
import { evaluateSignals } from "./adaptive/signals";
import type { HomeLayout } from "./adaptive/types";

/**
 * Step 1 of the adaptive Home: data collection. One cached load per
 * request, shared by the conversation and the rail:
 *
 *   loadHomeData (events, tasks, settings)  ->  Phase 5 engine (reuses that load)
 *                                           ->  goals, recently finished tasks (optional)
 *
 * Each optional source fails on its own and becomes null; Home still opens.
 * No AI call happens here. Render callers inside <Suspense>.
 */

export type HomeIntel = {
  now: Date;
  aiConfigured: boolean;
  /** What the conversation opens with (Phase 5 mapping). */
  home: HomeProactive;
  /** Null when the engine failed. */
  proactive: ProactiveState | null;
  analysis: Analysis | null;
  /** The adaptive rail. Null when Home's core data failed or the user isn't signed in. */
  layout: HomeLayout | null;
};

const RECENT_DONE_DAYS = 7;

export const loadHomeIntel = cache(async (): Promise<HomeIntel> => {
  const now = new Date();
  const aiConfigured = isAiConfigured();
  const { ctx, events, openTasks, preferences, error } = await loadHomeData();
  if (ctx.state !== "ready" || error) {
    return { now, aiConfigured, home: EMPTY_PROACTIVE, proactive: null, analysis: null, layout: null };
  }

  const base = preferences ? { timeZone: ctx.timeZone, preferences, events, openTasks } : undefined;
  const [engine, goals, recentlyDone] = await Promise.all([
    // Suggestions are a bonus: if the engine fails, Home still opens normally.
    loadProactiveWithAnalysis(ctx.userId, { now, surface: "all", base }).catch((e) => {
      console.error("[home] proactive suggestions failed", e);
      return null;
    }),
    listGoals(ctx.userId, { status: "active", limit: 20 }).catch(() => null),
    listTasks(ctx.userId, { doneWithinDays: RECENT_DONE_DAYS }).catch(() => null),
  ]);

  const proactive = engine?.state ?? null;
  const home = proactive ? homeProactive(proactive, aiConfigured, now) : EMPTY_PROACTIVE;
  // Whatever the conversation shows (fresh or resumed) is never repeated in the rail.
  const chatShownIds = [...new Set([...shownIds(home, false), ...shownIds(home, true)])];

  let layout: HomeLayout | null = null;
  try {
    layout = selectSections(
      evaluateSignals({
        now,
        todayKey: ctx.todayKey,
        timeZone: ctx.timeZone,
        events,
        openTasks,
        analysis: engine?.analysis ?? null,
        brief: proactive?.today ?? null,
        recommendations: proactive?.recommendations ?? [],
        settings: proactive?.settings ?? null,
        chatShownIds,
        goals,
        recentlyDone,
        aiConfigured,
      }),
    );
  } catch (e) {
    // Bad data in one place must not take Home down; the stable rail still renders.
    console.error("[home] adaptive sections failed", e);
  }

  return { now, aiConfigured, home, proactive, analysis: engine?.analysis ?? null, layout };
});
