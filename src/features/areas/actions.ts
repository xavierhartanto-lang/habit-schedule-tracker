"use server";

import { createLifeArea, deleteLifeArea, moveLifeArea, updateLifeArea } from "@/lib/db/life-areas";
import { isUuid } from "@/lib/domain/context-items";
import { NotFoundError } from "@/lib/db/client";
import type { ActionResult } from "@/features/shared/action-result";
import { PLANNING_PATHS, runAction } from "@/features/shared/run-action";

export async function saveLifeArea(id: string | null, input: unknown): Promise<ActionResult> {
  return runAction(PLANNING_PATHS, async (userId) => {
    if (id === null) return createLifeArea(userId, input);
    return updateLifeArea(userId, id, input);
  });
}

export async function moveArea(id: string, direction: "up" | "down"): Promise<ActionResult> {
  return runAction(["/areas"], async (userId) => {
    if (!isUuid(id) || (direction !== "up" && direction !== "down")) throw new NotFoundError("Life area");
    await moveLifeArea(userId, id, direction);
  });
}

/** Deletes an area. Its items move to `reassignTo`, or become uncategorized. */
export async function removeLifeArea(id: string, reassignTo: string | null): Promise<ActionResult> {
  return runAction(PLANNING_PATHS, (userId) => deleteLifeArea(userId, id, reassignTo));
}
