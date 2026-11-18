"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { DataValidationError, NotFoundError, SupabaseNotConfiguredError } from "@/lib/db/client";
import { createCommitment, deleteCommitment, listCommitments, updateCommitment } from "@/lib/db/commitments";
import { createContextItem, deleteContextItem, updateContextItem } from "@/lib/db/context-items";
import { createGoal, deleteGoal, updateGoal } from "@/lib/db/goals";
import { getProfile } from "@/lib/db/profiles";
import { isUuid } from "@/lib/domain/context-items";
import { DEFAULT_PROFILE } from "@/features/settings/defaults";
import { draftToCommitmentInput } from "./drafts";
import type { CommitmentDraft } from "./format";

/**
 * Edits from the "What Whitespace knows" page. Every write goes through
 * lib/db validation. Source (conversation / manual) is never changed by an edit.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

const PAGE = "/about-you";

function friendly(e: unknown): string {
  if (e instanceof DataValidationError) return e.message;
  if (e instanceof NotFoundError) return "That item no longer exists. Refresh to see the latest.";
  if (e instanceof SupabaseNotConfiguredError) return "Saving is off until Supabase is connected.";
  return "Could not save. Try again in a moment.";
}

async function run(fn: (userId: string) => Promise<unknown>): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to edit what Whitespace knows." };
  try {
    await fn(user.id);
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath(PAGE);
  return { ok: true };
}

function checkId(id: unknown): asserts id is string {
  if (!isUuid(id)) throw new NotFoundError("Item");
}

// ---------- Context items ----------

export async function saveContextItem(id: string | null, input: unknown): Promise<ActionResult> {
  return run(async (userId) => {
    if (id === null) return createContextItem(userId, { ...(input as object), source: "manual" });
    checkId(id);
    return updateContextItem(userId, id, input);
  });
}

export async function removeContextItem(id: string): Promise<ActionResult> {
  return run(async (userId) => {
    checkId(id);
    await deleteContextItem(userId, id);
  });
}

// ---------- Goals ----------

export async function saveGoal(id: string | null, input: unknown): Promise<ActionResult> {
  return run(async (userId) => {
    if (id === null) return createGoal(userId, { ...(input as object), source: "manual" });
    checkId(id);
    return updateGoal(userId, id, input);
  });
}

export async function removeGoal(id: string): Promise<ActionResult> {
  return run(async (userId) => {
    checkId(id);
    await deleteGoal(userId, id);
  });
}

// ---------- Commitments ----------

export async function saveCommitment(id: string | null, draft: CommitmentDraft): Promise<ActionResult> {
  return run(async (userId) => {
    const timeZone = (await getProfile(userId))?.timezone ?? DEFAULT_PROFILE.timezone;
    let existing = null;
    if (id !== null) {
      checkId(id);
      existing = (await listCommitments(userId)).find((c) => c.id === id) ?? null;
      if (!existing) throw new NotFoundError("Commitment");
    }
    const converted = draftToCommitmentInput(draft, timeZone, existing);
    if (!converted.ok) throw new DataValidationError(converted.error);
    if (id === null) return createCommitment(userId, { ...converted.value, source: "manual" });
    return updateCommitment(userId, id, converted.value);
  });
}

export async function removeCommitment(id: string): Promise<ActionResult> {
  return run(async (userId) => {
    checkId(id);
    await deleteCommitment(userId, id);
  });
}
