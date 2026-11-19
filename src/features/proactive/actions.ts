"use server";

import type { AssistantSettings } from "./types";

/** STUB (UI thread) for the engine's server actions. Replaced on merge. */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function dismissRecommendation(_input: { id: string; reason?: "not_now" | "not_relevant" }): Promise<Result<object>> {
  return { ok: true };
}

export async function markRecommendationsShown(_input: { ids: string[] }): Promise<Result<object>> {
  return { ok: true };
}

export async function getAssistantSettings(): Promise<Result<{ settings: AssistantSettings }>> {
  return { ok: true, settings: { proactivity: "balanced", quietHoursStart: "22:00", quietHoursEnd: "07:00" } };
}

export async function saveAssistantSettings(input: AssistantSettings): Promise<Result<{ settings: AssistantSettings }>> {
  return { ok: true, settings: input };
}
