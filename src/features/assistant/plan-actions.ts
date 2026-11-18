"use server";

/**
 * TEMPORARY STUB so the UI branch builds on its own. The backend branch
 * ("Build Phase 4 AI actions and approvals") owns the real file; on merge
 * that version replaces this one entirely.
 */

import type { PlanActionResult } from "./plan-types";

const notReady = async (): Promise<PlanActionResult> => ({ ok: false, error: "Approvals aren't connected yet." });

export async function approvePlanItems(_: { planId: string; itemIds?: string[]; edits?: Record<string, { start: string; end: string }>; requestId: string }) {
  void _;
  return notReady();
}
export async function rejectPlanItems(_: { planId: string; itemIds?: string[] }) {
  void _;
  return notReady();
}
export async function editPlanItem(_: { planId: string; itemId: string; start: string; end: string; title?: string }) {
  void _;
  return notReady();
}
export async function requestAlternatives(_: { planId: string; itemIds: string[] }) {
  void _;
  return notReady();
}
export async function undoPlanItem(_: { planId: string; itemId: string }) {
  void _;
  return notReady();
}
