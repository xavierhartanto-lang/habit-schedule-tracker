import "server-only";

import type { Conversation, ConversationKind } from "@/lib/domain/types";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { ConversationRow } from "./database.types";

/**
 * Conversations with the assistant, including the onboarding conversation.
 * Every query runs as the signed-in user, so RLS limits it to their own rows.
 */

const TITLE_MAX = 120;
const SUMMARY_MAX = 2000;

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

function cleanTitle(title: string | null | undefined): string | null {
  const t = title?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, TITLE_MAX) : null;
}

export async function listConversations(
  userId: string,
  options: { kind?: ConversationKind; limit?: number } = {},
): Promise<Conversation[]> {
  const supabase = await requireDb();
  let query = supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(options.limit ?? 50);
  if (options.kind) query = query.eq("kind", options.kind);
  const { data, error } = await query;
  if (error) throw dbError(error);
  return data.map(toConversation);
}

export async function getConversation(userId: string, id: string): Promise<Conversation | null> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw dbError(error);
  return data ? toConversation(data) : null;
}

/** The most recent conversation of a kind, e.g. to resume onboarding. */
export async function getLatestConversation(
  userId: string,
  kind: ConversationKind,
): Promise<Conversation | null> {
  const [latest] = await listConversations(userId, { kind, limit: 1 });
  return latest ?? null;
}

export async function createConversation(
  userId: string,
  input: { kind: ConversationKind; title?: string | null },
): Promise<Conversation> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, kind: input.kind, title: cleanTitle(input.title) })
    .select("*")
    .single();
  if (error) throw dbError(error);
  return toConversation(data);
}

export async function updateConversation(
  userId: string,
  id: string,
  input: { title?: string | null; summary?: string | null },
): Promise<Conversation> {
  const patch: { title?: string | null; summary?: string | null } = {};
  if ("title" in input) patch.title = cleanTitle(input.title);
  if ("summary" in input) {
    const summary = input.summary?.trim() || null;
    if (summary && summary.length > SUMMARY_MAX) {
      throw new DataValidationError(`Summary must be ${SUMMARY_MAX} characters or fewer.`);
    }
    patch.summary = summary;
  }

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("conversations")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Conversation");
  return toConversation(data);
}

/** Deletes the conversation and its messages. Saved facts are kept. */
export async function deleteConversation(userId: string, id: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("conversations").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}
