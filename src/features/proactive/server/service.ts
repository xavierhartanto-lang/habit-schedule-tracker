import "server-only";

import type { PlanView } from "@/features/assistant/plan-types";
import { NotFoundError } from "@/lib/db/client";
import type { DailyBrief, ProactiveState, Recommendation } from "../types";

/**
 * STUB (UI thread) for the engine's server module. Same names and shapes as
 * /mnt/project-files/phase-5/recommendations-api.md. Returns "nothing to
 * suggest", so Home falls back to its Phase 4 opening. Replaced on merge.
 */

export async function loadProactive(
  _userId: string,
  options: { now?: Date; surface?: "home" | "all" } = {},
): Promise<ProactiveState> {
  const now = options.now ?? new Date();
  return {
    settings: { proactivity: "balanced", quietHoursStart: "22:00", quietHoursEnd: "07:00" },
    quiet: false,
    today: { date: now.toISOString().slice(0, 10), timeZone: "UTC", events: [], freeMinutes: 0, focus: [], message: "", action: null },
    recommendations: [],
    openCount: 0,
  };
}

export async function proposeFromRecommendationFor(
  _userId: string,
  _input: { id: string; actionId: string; conversationId: string | null; sourceMessageId: string | null; now?: Date },
): Promise<{ plan: PlanView | null; prompt: string | null; recommendation: Recommendation }> {
  throw new NotFoundError("recommendation");
}

export async function proposeDailyPlanFor(
  _userId: string,
  _input: { conversationId: string | null; sourceMessageId: string | null; now?: Date },
): Promise<{ plan: PlanView | null; brief: DailyBrief }> {
  throw new Error("Daily planning isn't available yet.");
}
