"use server";

import { revalidatePath } from "next/cache";

import { getSessionUser } from "@/lib/auth/session";
import { DataValidationError, NotFoundError, SupabaseNotConfiguredError } from "@/lib/db/client";
import { toPlanView } from "@/lib/db/plans";
import { isUuid } from "@/lib/domain/context-items";
import type { PlanActionResult } from "./plan-types";
import {
  approveItems,
  editItem,
  findAlternatives,
  rejectItemsInPlan,
  undoItem,
  type ItemResult,
} from "./server/plan-service";
import type { StoredPlan } from "@/lib/db/plans";

/**
 * Server actions behind the approval cards. Contract:
 * /mnt/project-files/phase-4/assistant-api.md (section 3).
 *
 * The plan is always re-read from the database; the client only sends ids,
 * an idempotency key and optional time edits, which are validated again.
 */

const PATHS = ["/", "/calendar", "/tasks", "/habits", "/areas", "/about-you"];

function friendly(error: unknown): string {
  if (error instanceof DataValidationError) return error.message;
  if (error instanceof NotFoundError) return "That suggestion wasn't found. Refresh to see the latest.";
  if (error instanceof SupabaseNotConfiguredError) return "Saving is off until Supabase is connected.";
  console.error("[plan] action failed", error);
  return "Couldn't update the plan. Try again.";
}

function ids(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 200 || !value.every(isUuid)) throw new DataValidationError("Unknown items.");
  return value;
}

async function run(
  planId: unknown,
  fn: (userId: string, planId: string) => Promise<{ plan: StoredPlan; results: ItemResult[] }>,
  revalidate: boolean,
): Promise<PlanActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to make changes." };
  if (!isUuid(planId)) return { ok: false, error: "That suggestion wasn't found." };
  try {
    const { plan, results } = await fn(user.id, planId);
    if (revalidate) {
      for (const p of PATHS) revalidatePath(p);
      revalidatePath("/assistant", "layout");
    }
    return { ok: true, plan: toPlanView(plan), results };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

export async function approvePlanItems(input: {
  planId: string;
  itemIds?: string[];
  edits?: Record<string, { start: string; end: string }>;
  requestId: string;
}): Promise<PlanActionResult> {
  if (!isUuid(input?.requestId)) return { ok: false, error: "Missing request id." };
  return run(
    input.planId,
    async (userId, planId) => {
      const edits = input.edits && typeof input.edits === "object" ? input.edits : null;
      if (edits && Object.keys(edits).some((k) => !isUuid(k))) throw new DataValidationError("Unknown items.");
      return approveItems(userId, planId, { itemIds: ids(input.itemIds), edits, requestId: input.requestId });
    },
    true,
  );
}

export async function rejectPlanItems(input: { planId: string; itemIds?: string[] }): Promise<PlanActionResult> {
  return run(input?.planId, (userId, planId) => rejectItemsInPlan(userId, planId, ids(input.itemIds)), false);
}

export async function editPlanItem(input: {
  planId: string;
  itemId: string;
  start: string;
  end: string;
  title?: string;
}): Promise<PlanActionResult> {
  return run(
    input?.planId,
    (userId, planId) => {
      if (!isUuid(input.itemId) || typeof input.start !== "string" || typeof input.end !== "string") {
        throw new DataValidationError("Pick a start and end time.");
      }
      return editItem(userId, planId, {
        itemId: input.itemId,
        start: input.start,
        end: input.end,
        title: typeof input.title === "string" ? input.title : undefined,
      });
    },
    false,
  );
}

export async function requestAlternatives(input: { planId: string; itemIds: string[] }): Promise<PlanActionResult> {
  return run(input?.planId, (userId, planId) => findAlternatives(userId, planId, ids(input.itemIds) ?? []), false);
}

export async function undoPlanItem(input: { planId: string; itemId: string }): Promise<PlanActionResult> {
  return run(
    input?.planId,
    (userId, planId) => {
      if (!isUuid(input.itemId)) throw new DataValidationError("Unknown item.");
      return undoItem(userId, planId, input.itemId);
    },
    true,
  );
}
