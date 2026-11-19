"use server";

import { revalidatePath } from "next/cache";

import type { PlanView } from "@/features/assistant/plan-types";
import { getSessionUser } from "@/lib/auth/session";
import { DataValidationError, NotFoundError, SupabaseNotConfiguredError } from "@/lib/db/client";
import { getAssistantSettings as readSettings, saveAssistantSettings as writeSettings } from "@/lib/db/scheduling-preferences";
import { isUuid } from "@/lib/domain/context-items";
import { dismissFor, linkPlanFor, markShownFor, proposeFromRecommendationFor } from "./server/service";
import type { AssistantSettings } from "./types";

/**
 * Server actions for proactive recommendations and assistant settings.
 * Contract: /mnt/project-files/phase-5/recommendations-api.md (section 3).
 * Only ids and choices come from the client; everything else is re-read.
 */

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

function friendly(error: unknown): string {
  if (error instanceof DataValidationError) return error.message;
  if (error instanceof NotFoundError) return "That suggestion wasn't found. Refresh to see the latest.";
  if (error instanceof SupabaseNotConfiguredError) return "Saving is off until Supabase is connected.";
  console.error("[proactive] action failed", error);
  return "Something went wrong. Try again.";
}

async function run<T extends object>(fn: (userId: string) => Promise<T>): Promise<Result<T>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to continue." };
  try {
    return { ok: true, ...(await fn(user.id)) };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

export async function dismissRecommendation(input: { id: string; reason?: "not_now" | "not_relevant" }): Promise<Result> {
  if (!isUuid(input?.id)) return { ok: false, error: "That suggestion wasn't found." };
  const reason = input.reason === "not_now" ? "not_now" : "not_relevant";
  return run(async (userId) => {
    await dismissFor(userId, { id: input.id, reason });
    revalidatePath("/");
    return {};
  });
}

export async function proposeFromRecommendation(input: {
  id: string;
  actionId: string;
  conversationId?: string | null;
}): Promise<Result<{ plan: PlanView | null; prompt: string | null }>> {
  if (!isUuid(input?.id) || typeof input.actionId !== "string" || input.actionId.length > 60) {
    return { ok: false, error: "That suggestion wasn't found." };
  }
  const conversationId = input.conversationId && isUuid(input.conversationId) ? input.conversationId : null;
  return run(async (userId) => {
    const { plan, prompt } = await proposeFromRecommendationFor(userId, {
      id: input.id,
      actionId: input.actionId,
      conversationId,
      sourceMessageId: null,
    });
    return { plan, prompt };
  });
}

export async function linkRecommendationPlan(input: { id: string; planId: string }): Promise<Result> {
  if (!isUuid(input?.id) || !isUuid(input.planId)) return { ok: false, error: "That suggestion wasn't found." };
  return run(async (userId) => {
    await linkPlanFor(userId, input);
    return {};
  });
}

export async function markRecommendationsShown(input: { ids: string[] }): Promise<Result> {
  const ids = Array.isArray(input?.ids) ? input.ids.filter(isUuid).slice(0, 20) : [];
  if (!ids.length) return { ok: true };
  return run(async (userId) => {
    await markShownFor(userId, ids);
    return {};
  });
}

export async function getAssistantSettings(): Promise<Result<{ settings: AssistantSettings }>> {
  return run(async (userId) => ({ settings: await readSettings(userId) }));
}

export async function saveAssistantSettings(input: AssistantSettings): Promise<Result<{ settings: AssistantSettings }>> {
  return run(async (userId) => {
    const settings = await writeSettings(userId, input);
    revalidatePath("/");
    revalidatePath("/settings");
    return { settings };
  });
}
