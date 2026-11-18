import "server-only";

import { validateLifeAreaInput } from "@/lib/domain/life-areas";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { isUuid } from "@/lib/domain/context-items";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { LifeAreaRow } from "./database.types";

/**
 * User-defined life areas. Deleting one never deletes the records in it:
 * delete_life_area (SQL) moves them to another area or leaves them
 * uncategorized, in one transaction.
 */

export const MAX_LIFE_AREAS = 30;

function toLifeArea(row: LifeAreaRow): LifeAreaRecord {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    legacyKey: row.legacy_key,
  };
}

function friendlyUnique(error: { message: string; code?: string }) {
  if (error.code === "23505") return new DataValidationError("You already have an area with that name.");
  return dbError(error);
}

export async function listLifeAreas(userId: string): Promise<LifeAreaRecord[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("life_areas")
    .select("*")
    .eq("user_id", userId)
    .order("position")
    .order("created_at")
    .limit(MAX_LIFE_AREAS + 10);
  if (error) throw dbError(error);
  return data.map(toLifeArea);
}

export async function createLifeArea(userId: string, input: unknown): Promise<LifeAreaRecord> {
  const result = validateLifeAreaInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const supabase = await requireDb();

  const { data: existing, error: listError } = await supabase
    .from("life_areas")
    .select("position")
    .eq("user_id", userId)
    .order("position", { ascending: false })
    .limit(MAX_LIFE_AREAS);
  if (listError) throw dbError(listError);
  if (existing.length >= MAX_LIFE_AREAS) {
    throw new DataValidationError(`You can have up to ${MAX_LIFE_AREAS} life areas.`);
  }

  const { data, error } = await supabase
    .from("life_areas")
    .insert({
      user_id: userId,
      name: result.value.name,
      color: result.value.color,
      position: Math.min((existing[0]?.position ?? -1) + 1, 1000),
    })
    .select("*")
    .single();
  if (error) throw friendlyUnique(error);
  return toLifeArea(data);
}

export async function updateLifeArea(userId: string, id: string, input: unknown): Promise<LifeAreaRecord> {
  if (!isUuid(id)) throw new NotFoundError("Life area");
  const result = validateLifeAreaInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("life_areas")
    .update({ name: result.value.name, color: result.value.color })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw friendlyUnique(error);
  if (!data) throw new NotFoundError("Life area");
  return toLifeArea(data);
}

/** Swaps an area with its neighbour in the list. */
export async function moveLifeArea(userId: string, id: string, direction: "up" | "down"): Promise<void> {
  const areas = await listLifeAreas(userId);
  const index = areas.findIndex((a) => a.id === id);
  if (index === -1) throw new NotFoundError("Life area");
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= areas.length) return;
  const reordered = areas.slice();
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  const supabase = await requireDb();
  const changed = reordered
    .map((a, position) => ({ id: a.id, position }))
    .filter((a, i) => reordered[i].position !== a.position);
  const results = await Promise.all(
    changed.map((a) =>
      supabase.from("life_areas").update({ position: a.position }).eq("user_id", userId).eq("id", a.id),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw dbError(failed.error);
}

/** How many records use each area: { areaId: count }. */
export async function countLifeAreaUsage(userId: string): Promise<Record<string, number>> {
  const supabase = await requireDb();
  const tables = ["commitments", "tasks", "habits", "goals", "context_items"] as const;
  const results = await Promise.all(
    tables.map((t) =>
      supabase.from(t).select("life_area_id").eq("user_id", userId).not("life_area_id", "is", null).limit(5000),
    ),
  );
  const counts: Record<string, number> = {};
  for (const r of results) {
    if (r.error) throw dbError(r.error);
    for (const row of r.data as { life_area_id: string | null }[]) {
      if (row.life_area_id) counts[row.life_area_id] = (counts[row.life_area_id] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Deletes an area. Its records move to `reassignTo`, or become
 * uncategorized when it is null. Never deletes the records themselves.
 */
export async function deleteLifeArea(userId: string, id: string, reassignTo: string | null): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Life area");
  if (reassignTo !== null && (!isUuid(reassignTo) || reassignTo === id)) {
    throw new DataValidationError("Choose a different life area.");
  }
  const supabase = await requireDb();
  const { error } = await supabase.rpc("delete_life_area", { p_area_id: id, p_reassign_to: reassignTo });
  if (error) {
    if (error.code === "P0002") throw new NotFoundError("Life area");
    if (error.code === "22023") throw new DataValidationError("Choose a different life area.");
    throw dbError(error);
  }
  void userId;
}
