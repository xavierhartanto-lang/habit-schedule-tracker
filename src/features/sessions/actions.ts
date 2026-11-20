"use server";

import { DataValidationError } from "@/lib/db/client";
import { setSessionOutcome } from "@/lib/db/events";
import type { SessionOutcome } from "@/lib/domain/types";
import type { ActionResult } from "@/features/shared/action-result";
import { PLANNING_PATHS, runAction } from "@/features/shared/run-action";

const OUTCOMES: readonly SessionOutcome[] = ["done", "partial", "missed"];

/**
 * Phase 7 plan vs reality: the user says what happened to a Whitespace
 * work session that has started. Only records a fact; it never moves or
 * removes anything. A missed session is picked up by the engine, which
 * offers (never applies) a new slot. `null` clears the answer (undo).
 */
export async function recordSessionOutcome(input: { id: string; outcome: SessionOutcome | null }): Promise<ActionResult> {
  return runAction(PLANNING_PATHS, async (userId) => {
    if (input.outcome !== null && !OUTCOMES.includes(input.outcome)) throw new DataValidationError("Unknown answer.");
    await setSessionOutcome(userId, input.id, input.outcome);
  });
}
