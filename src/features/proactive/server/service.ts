import "server-only";

import { buildPlan } from "@/lib/assistant/build-plan";
import { DataValidationError, NotFoundError } from "@/lib/db/client";
import { createPlan, listPendingBlocks, toPlanView } from "@/lib/db/plans";
import { getPreferences, getProfile } from "@/lib/db/profiles";
import {
  applyReconcile,
  getRecommendationRow,
  isMissingTable,
  linkedPlanStates,
  listRecommendationRows,
  markShown,
  pruneResolved,
  toRecommendation,
  toStored,
  updateRecommendation,
} from "@/lib/db/recommendations";
import { loadSchedulingBase } from "@/lib/db/scheduling";
import { getAssistantSettings } from "@/lib/db/scheduling-preferences";
import { analyze, type Analysis } from "@/lib/proactive/analyze";
import { buildBrief } from "@/lib/proactive/brief";
import { detectFromAnalysis, type Candidate } from "@/lib/proactive/detect";
import { reconcile } from "@/lib/proactive/reconcile";
import { specsForAction } from "@/lib/proactive/specs";
import { isQuietTime, surface as surfaceRecommendations } from "@/lib/proactive/surface";
import { addDaysToKey, dateKeyInZone, isValidTimeZone, zonedToUtc } from "@/lib/scheduling/zoned";
import type { PlanView } from "@/features/assistant/plan-types";
import { loadWorld } from "@/features/assistant/server/plan-service";
import type { AssistantSettings, DailyBrief, ProactiveState, Recommendation, RecommendationAction } from "../types";

/**
 * Phase 5 proactive assistant, server side.
 *
 *   loadProactive                 detectors -> dedupe/sync -> ranked, filtered list + daily brief
 *   proposeFromRecommendationFor  recommendation action -> a normal Phase 4 plan (approval card)
 *   proposeDailyPlanFor           the daily brief's plan_day -> a Phase 4 plan
 *   dismiss / snooze / link / markShown
 *
 * Runs on request (page load or chat), never in the background. All reads
 * and writes run as the signed-in user (RLS). Nothing here edits the
 * calendar or tasks: plans wait for the user's approval, and approval
 * re-checks conflicts (Phase 4 approveItems).
 */

const LOOKBACK_MS = 3 * 86_400_000;
const LOOKAHEAD_MS = 16 * 86_400_000;

type Fresh = {
  analysis: Analysis | null;
  settings: AssistantSettings;
};

async function loadFresh(userId: string, now: Date): Promise<Fresh> {
  const window = {
    start: new Date(now.getTime() - LOOKBACK_MS).toISOString(),
    end: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
  };
  const [base, prefs, settings, busy] = await Promise.all([
    loadSchedulingBase(userId, window),
    getPreferences(userId),
    getAssistantSettings(userId),
    listPendingBlocks(userId, { now }).catch(() => []),
  ]);
  let analysis: Analysis | null = null;
  try {
    analysis = analyze({
      now: now.toISOString(),
      timeZone: base.timeZone,
      weekStartsOn: prefs?.weekStartsOn ?? 1,
      events: base.events,
      tasks: base.openTasks,
      preferences: base.preferences,
      busy,
    });
  } catch (error) {
    // Invalid stored preferences or time zone: no recommendations, but the page still works.
    console.error("[proactive] analysis failed", error);
  }
  return { analysis, settings };
}

function emptyBrief(timeZone: string, now: Date): DailyBrief {
  return {
    date: dateKeyInZone(now, timeZone),
    timeZone,
    events: [],
    freeMinutes: 0,
    focus: [],
    message: "Nothing needs attention right now.",
    action: null,
  };
}

/** Detect, sync the table, return what to show. Never throws for missing data or a missing migration. */
export async function loadProactive(
  userId: string,
  options: { now?: Date; surface?: "home" | "all" } = {},
): Promise<ProactiveState> {
  const now = options.now ?? new Date();
  const { analysis, settings } = await loadFresh(userId, now);
  const timeZone = analysis?.timeZone ?? "UTC";
  const today = analysis ? buildBrief(analysis) : emptyBrief(timeZone, now);
  const candidates: Candidate[] = analysis ? detectFromAnalysis(analysis) : [];

  let recommendations: Recommendation[] = [];
  try {
    recommendations = await sync(userId, candidates, settings, now);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.warn("[proactive] recommendations table missing: run the Phase 5 migration");
  }

  const open = recommendations.filter((r) => r.status === "open");
  return {
    settings,
    quiet: isQuietTime(now, timeZone, settings),
    today,
    recommendations: surfaceRecommendations(open, { settings, now, timeZone, mode: options.surface ?? "home" }),
    openCount: open.length,
  };
}

async function sync(userId: string, candidates: Candidate[], settings: AssistantSettings, now: Date): Promise<Recommendation[]> {
  const rows = await listRecommendationRows(userId, now);
  const stored = rows.map(toStored);
  const plans = await linkedPlanStates(
    userId,
    stored.filter((r) => r.status === "proposed" && r.planId).map((r) => r.planId!),
    now,
  );
  const result = reconcile({ stored, candidates, plans, now });
  if (result.inserts.length || result.updates.length) {
    await applyReconcile(userId, result);
    // Occasional cleanup, piggybacking on a load that already wrote something.
    if (result.updates.some((u) => u.patch.status === "resolved")) await pruneResolved(userId, now).catch(() => undefined);
    const fresh = await listRecommendationRows(userId, now);
    return fresh.map((r) => toRecommendation(r, settings.proactivity, now));
  }
  return rows.map((r) => toRecommendation(r, settings.proactivity, now));
}

// ---------------------------------------------------------------------------
// Turning a recommendation into a plan
// ---------------------------------------------------------------------------

async function planFromActions(
  userId: string,
  action: RecommendationAction,
  input: { conversationId: string | null; sourceMessageId: string | null; now: Date },
): Promise<{ plan: PlanView | null; prompt: string | null }> {
  const { now } = input;
  const [loaded, busy] = await Promise.all([loadWorld(userId, now), listPendingBlocks(userId, { now })]);
  const spec = specsForAction(action, {
    todayKey: loaded.world.todayKey,
    timeZone: loaded.world.timeZone,
    tasks: new Map(loaded.openTasks.map((t) => [t.id, t])),
    events: new Map(loaded.events.map((e) => [e.id, e])),
    maxSessionMinutes: loaded.preferences.maxSessionMinutes,
    nowMs: now.getTime(),
  });
  if (!spec.ok) throw new DataValidationError(spec.error);
  if (spec.prompt !== null) return { plan: null, prompt: spec.prompt };

  const built = buildPlan({
    now: now.toISOString(),
    world: loaded.world,
    preferences: loaded.preferences,
    events: loaded.events,
    openTasks: loaded.openTasks,
    // Time other open plans already offer is taken, so two suggestions never book the same slot.
    busy,
    // Never "explicit": nothing is auto-applied, every item waits for approval.
    specs: spec.specs.map((s) => ({ spec: s, explicit: false })),
    sourceMessageId: input.sourceMessageId,
  });
  if (!built.items.length && !built.unscheduled.length) {
    throw new DataValidationError(built.notes[0] ?? "Nothing needs to change right now.");
  }
  const plan = await createPlan(userId, {
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId,
    built: { ...built, items: built.items.map((i) => ({ ...i, autoApply: false })) },
    now,
  });
  return { plan: toPlanView(plan, now), prompt: null };
}

const ACTIONABLE = new Set(["open", "snoozed", "proposed"]);

export async function proposeFromRecommendationFor(
  userId: string,
  input: { id: string; actionId: string; conversationId: string | null; sourceMessageId: string | null; now?: Date },
): Promise<{ plan: PlanView | null; prompt: string | null; recommendation: Recommendation }> {
  const now = input.now ?? new Date();
  const [row, settings] = await Promise.all([getRecommendationRow(userId, input.id), getAssistantSettings(userId)]);
  if (!ACTIONABLE.has(row.status)) throw new DataValidationError("This suggestion is out of date. Refresh to see the latest.");
  const rec = toRecommendation(row, settings.proactivity, now);
  const action = rec.actions.find((a) => a.id === input.actionId);
  if (!action) throw new NotFoundError("Action");

  const out = await planFromActions(userId, action, { conversationId: input.conversationId, sourceMessageId: input.sourceMessageId, now });
  if (!out.plan) return { ...out, recommendation: rec };
  const updated = await updateRecommendation(userId, rec.id, { status: "proposed", planId: out.plan.id, snoozedUntil: null });
  return { ...out, recommendation: toRecommendation(updated, settings.proactivity, now) };
}

/** Recomputes today's brief from fresh data (client task ids are never trusted) and plans it. */
export async function proposeDailyPlanFor(
  userId: string,
  input: { conversationId: string | null; sourceMessageId: string | null; now?: Date },
): Promise<{ plan: PlanView | null; brief: DailyBrief }> {
  const now = input.now ?? new Date();
  const { analysis } = await loadFresh(userId, now);
  if (!analysis) return { plan: null, brief: emptyBrief("UTC", now) };
  const brief = buildBrief(analysis);
  if (!brief.action) return { plan: null, brief };
  const { plan } = await planFromActions(userId, brief.action, { conversationId: input.conversationId, sourceMessageId: input.sourceMessageId, now });
  return { plan, brief };
}

// ---------------------------------------------------------------------------
// Acknowledging
// ---------------------------------------------------------------------------

/** not_now: hidden until tomorrow's day start (local). not_relevant: never again for this situation. */
export async function dismissFor(userId: string, input: { id: string; reason?: "not_now" | "not_relevant"; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  if (input.reason === "not_now") {
    const [profile, prefs] = await Promise.all([getProfile(userId), getPreferences(userId)]);
    const tz = isValidTimeZone(profile?.timezone) ? profile.timezone : "UTC";
    const tomorrow = addDaysToKey(dateKeyInZone(now, tz), 1);
    const until = zonedToUtc(tomorrow, (prefs?.dayStartTime ?? "07:00").slice(0, 5), tz);
    await updateRecommendation(userId, input.id, { status: "snoozed", snoozedUntil: until.toISOString() });
    return;
  }
  await updateRecommendation(userId, input.id, { status: "dismissed", snoozedUntil: null });
}

/** For a plan the UI built itself: the next load turns it into acted / dismissed from the plan's status. */
export async function linkPlanFor(userId: string, input: { id: string; planId: string }): Promise<void> {
  await updateRecommendation(userId, input.id, { status: "proposed", planId: input.planId });
}

export async function markShownFor(userId: string, ids: string[], now = new Date()): Promise<void> {
  await markShown(userId, ids, now);
}
