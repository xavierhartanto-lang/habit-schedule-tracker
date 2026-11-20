import "server-only";

import { isAiConfigured } from "@/lib/ai/config";
import { summarizeWeek } from "@/lib/ai/service";
import { listEventsForRange } from "@/lib/db/events";
import { listGoals } from "@/lib/db/goals";
import { listTasks } from "@/lib/db/tasks";
import { getBriefing, isMissingBriefingTable, markBriefing, saveBriefing, type StoredBriefing } from "@/lib/db/weekly-briefings";
import type { Json } from "@/lib/db/database.types";
import type { Goal, LifeAreaRecord, Task } from "@/lib/domain/types";
import { buildBriefingPrompt, validateBriefing } from "@/lib/insights/briefing-ai";
import { goalTime, weekTime, type AreaTimeInput, type GoalTime, type WeekTime } from "@/lib/insights/area-time";
import { briefingWindow, buildWeeklyFacts, factLines, factsHash, headline, showOnHome, weekLabel, type BriefingWindow, type WeeklyFacts } from "@/lib/insights/weekly";
import type { Analysis } from "@/lib/proactive/analyze";
import { addDaysToKey, startOfDayInZone, startOfWeekKey } from "@/lib/scheduling/zoned";
import type { Recommendation } from "@/features/proactive/types";
import { loadProactiveWithAnalysis } from "@/features/proactive/server/service";
import { loadPlanningContext } from "@/features/shared/planning-context";

/**
 * Phase 7.6 server side: the real numbers behind Insights and the weekly
 * briefing. Everything is read as the signed-in user (RLS) and computed by
 * the pure modules in lib/insights. The AI only ever writes the short
 * summary, from the fact lines, and is optional.
 */

export type InsightsCtx = { userId: string; timeZone: string; weekStartsOn: 0 | 1; todayKey: string; areas: LifeAreaRecord[] };

export type InsightsData = {
  thisWeek: WeekTime;
  lastWeek: WeekTime;
  goals: GoalTime[];
  briefing: BriefingView | null;
};

export type BriefingView = {
  window: BriefingWindow;
  facts: WeeklyFacts;
  lines: string[];
  /** Home's shorter version: problems, what's due, the load. */
  compactLines: string[];
  heading: string;
  headline: string;
  hash: string;
  stored: StoredBriefing | null;
  /** The weekly_briefings table exists (the migration ran). */
  tracked: boolean;
};

const HISTORY_WEEKS = 2;
const PENDING = "pending";
const AI_TIMEOUT_MS = 12_000;
/** A failed summary for the same facts is retried at most this often. */
const RETRY_MS = 60 * 60_000;

/** Events and tasks for the weeks Insights and the briefing look at. */
async function loadHistory(ctx: InsightsCtx): Promise<{ events: AreaTimeInput["events"]; tasks: Task[] }> {
  const current = startOfWeekKey(ctx.todayKey, ctx.weekStartsOn);
  const [{ events }, tasks] = await Promise.all([
    listEventsForRange(ctx.userId, {
      from: startOfDayInZone(addDaysToKey(current, -7 * HISTORY_WEEKS), ctx.timeZone).toISOString(),
      to: startOfDayInZone(addDaysToKey(current, 14), ctx.timeZone).toISOString(),
    }),
    listTasks(ctx.userId, { doneWithinDays: 7 * (HISTORY_WEEKS + 1) }),
  ]);
  return { events, tasks };
}

function input(ctx: InsightsCtx, now: Date, events: AreaTimeInput["events"], tasks: Task[]): AreaTimeInput {
  return { now: now.toISOString(), timeZone: ctx.timeZone, weekStartsOn: ctx.weekStartsOn, events, tasks, areas: ctx.areas };
}

/**
 * The briefing's facts, plus the cached row. Pass the engine output when
 * the caller already has it (Home), so nothing is computed twice.
 */
export async function loadBriefing(
  ctx: InsightsCtx,
  options: {
    now?: Date;
    engine?: { analysis: Analysis | null; recommendations: Recommendation[] };
    history?: { events: AreaTimeInput["events"]; tasks: Task[] };
    /** Home: stop early (no extra reads) unless the briefing should show there now. */
    onlyForHome?: boolean;
  } = {},
): Promise<BriefingView | null> {
  const now = options.now ?? new Date();
  if (options.onlyForHome) {
    const w = briefingWindow(now, ctx.timeZone, ctx.todayKey, ctx.weekStartsOn);
    if (!w.offerOnHome) return null;
    const row = await getBriefing(ctx.userId, w.weekStart).catch(() => undefined);
    // Table missing (undefined): Home can't remember it, so it doesn't show there.
    if (row === undefined || !showOnHome(w, row, now)) return null;
  }
  const engine: { analysis: Analysis | null; recommendations: Recommendation[] } =
    options.engine ??
    (await loadProactiveWithAnalysis(ctx.userId, { now, surface: "all" }).then(({ state, analysis }) => ({ analysis, recommendations: state.recommendations })));
  if (!engine.analysis) return null;
  const history = options.history ?? (await loadHistory(ctx));
  const window = briefingWindow(now, ctx.timeZone, ctx.todayKey, ctx.weekStartsOn);
  const data = input(ctx, now, history.events, history.tasks);
  const facts = buildWeeklyFacts({
    analysis: engine.analysis,
    window,
    recommendations: engine.recommendations,
    reviewed: weekTime(data, window.reviewStart),
    before: weekTime(data, addDaysToKey(window.reviewStart, -7)),
  });
  const hash = factsHash(facts);

  let stored: StoredBriefing | null = null;
  let tracked = true;
  try {
    stored = await getBriefing(ctx.userId, window.weekStart);
    // Make sure the week has a row, so Home can remember it was shown or closed.
    // "pending" = no summary attempted yet for this week.
    if (!stored) stored = await saveBriefing(ctx.userId, { weekStart: window.weekStart, factsHash: PENDING, facts: facts as unknown as Json, summary: null });
  } catch (error) {
    if (!isMissingBriefingTable(error)) throw error;
    console.warn("[insights] weekly_briefings table missing: run migration 20261130000000");
    tracked = false;
  }
  return { window, facts, lines: factLines(facts, ctx.todayKey), compactLines: factLines(facts, ctx.todayKey, { compact: true }), heading: weekLabel(facts), headline: headline(facts), hash, stored, tracked };
}

/** Whether Home shows the briefing card right now. */
export function briefingOnHome(view: BriefingView | null, now = new Date()): boolean {
  return !!view && view.tracked && showOnHome(view.window, view.stored, now);
}

/**
 * The AI summary for these facts: the cached one when the facts haven't
 * changed, otherwise a new one (validated against the fact lines). Null
 * when the AI is off, fails, or says something the facts don't support:
 * the factual briefing shows instead. Safe to call repeatedly: one row per
 * week, regenerated only when the facts' hash changes.
 */
export async function briefingSummary(ctx: InsightsCtx, view: BriefingView, now = new Date()): Promise<string | null> {
  const s = view.stored;
  const fresh = s && s.factsHash === view.hash;
  if (fresh && s.summary) return s.summary;
  if (view.facts.empty || !isAiConfigured()) return null;
  // Same facts, the AI failed or was rejected before: don't hammer it.
  if (fresh && now.getTime() - Date.parse(s.generatedAt) < RETRY_MS) return null;

  let summary: string | null = null;
  try {
    const wire = await summarizeWeek({ prompt: buildBriefingPrompt(view.lines, view.heading), signal: AbortSignal.timeout(AI_TIMEOUT_MS) });
    summary = validateBriefing(wire.summary, view.lines);
    if (!summary) console.warn("[insights] briefing summary failed validation; showing the facts");
  } catch (error) {
    console.warn("[insights] briefing summary unavailable", error);
  }
  if (view.tracked) {
    await saveBriefing(ctx.userId, { weekStart: view.window.weekStart, factsHash: view.hash, facts: view.facts as unknown as Json, summary }).catch((error) =>
      console.error("[insights] couldn't cache the briefing", error),
    );
  }
  return summary;
}

export async function markBriefingFor(userId: string, weekStart: string, mark: "shown" | "dismissed"): Promise<void> {
  try {
    await markBriefing(userId, weekStart, mark);
  } catch (error) {
    if (!isMissingBriefingTable(error)) throw error;
  }
}

/** Everything the Insights page shows. */
export async function loadInsights(ctx: InsightsCtx, now = new Date()): Promise<InsightsData> {
  const history = await loadHistory(ctx);
  const data = input(ctx, now, history.events, history.tasks);
  const current = startOfWeekKey(ctx.todayKey, ctx.weekStartsOn);
  const goals: Goal[] = await listGoals(ctx.userId, { status: "active", limit: 20 }).catch(() => []);
  const from = startOfDayInZone(current, ctx.timeZone).getTime();
  const to = startOfDayInZone(addDaysToKey(current, 7), ctx.timeZone).getTime();
  const briefing = await loadBriefing(ctx, { now, history }).catch((error) => {
    console.error("[insights] weekly briefing failed", error);
    return null;
  });
  return {
    thisWeek: weekTime(data, current),
    lastWeek: weekTime(data, addDaysToKey(current, -7)),
    goals: goalTime(data, goals, from, to),
    briefing,
  };
}

/** The briefing's fact lines for the assistant's weekly check-in, so all three places agree. */
export async function weeklyBriefingText(userId: string, now = new Date()): Promise<string | null> {
  const ctx = await loadPlanningContext();
  if (ctx.state !== "ready" || ctx.userId !== userId) return null;
  const view = await loadBriefing({ userId, timeZone: ctx.timeZone, weekStartsOn: ctx.weekStartsOn, todayKey: ctx.todayKey, areas: ctx.areas }, { now });
  return view ? view.lines.map((l) => `- ${l}`).join("\n") : null;
}
