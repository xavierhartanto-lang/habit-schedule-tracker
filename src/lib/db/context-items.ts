import "server-only";

import {
  normalizeContextAttributes,
  validateContextItemInput,
  validateContextItemPatch,
} from "@/lib/domain/context-items";
import type { ContextCategory, ContextItem, DataSource } from "@/lib/domain/types";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { ContextItemRow } from "./database.types";

/**
 * Facts the user has shared that are not commitments or goals:
 * activities, interests, routines, working times and preferences.
 * Input is validated in lib/domain before it is written.
 */

function toContextItem(row: ContextItemRow): ContextItem {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    details: row.details,
    area: row.area,
    attributes: normalizeContextAttributes(row.attributes),
    source: row.source,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listContextItems(
  userId: string,
  options: { category?: ContextCategory; source?: DataSource; limit?: number } = {},
): Promise<ContextItem[]> {
  const supabase = await requireDb();
  let query = supabase
    .from("context_items")
    .select("*")
    .eq("user_id", userId)
    .order("category")
    .order("created_at")
    .limit(options.limit ?? 500);
  if (options.category) query = query.eq("category", options.category);
  if (options.source) query = query.eq("source", options.source);
  const { data, error } = await query;
  if (error) throw dbError(error);
  return data.map(toContextItem);
}

/** Validates, then saves. Throws DataValidationError for bad input. */
export async function createContextItem(userId: string, input: unknown): Promise<ContextItem> {
  const result = validateContextItemInput(input);
  if (!result.ok) throw new DataValidationError(result.error);
  const v = result.value;

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("context_items")
    .insert({
      user_id: userId,
      category: v.category,
      title: v.title,
      details: v.details ?? null,
      area: v.area ?? null,
      attributes: v.attributes ?? {},
      source: v.source ?? "manual",
      source_message_id: v.sourceMessageId ?? null,
    })
    .select("*")
    .single();
  if (error) throw dbError(error);
  return toContextItem(data);
}

/** Edits an item. Where it came from (source) never changes. */
export async function updateContextItem(
  userId: string,
  id: string,
  patch: unknown,
): Promise<ContextItem> {
  const result = validateContextItemPatch(patch);
  if (!result.ok) throw new DataValidationError(result.error);
  const v = result.value;

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("context_items")
    .update({
      ...(v.category !== undefined && { category: v.category }),
      ...(v.title !== undefined && { title: v.title }),
      ...(v.details !== undefined && { details: v.details }),
      ...(v.area !== undefined && { area: v.area }),
      ...(v.attributes !== undefined && { attributes: v.attributes }),
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Item");
  return toContextItem(data);
}

export async function deleteContextItem(userId: string, id: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("context_items").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}
