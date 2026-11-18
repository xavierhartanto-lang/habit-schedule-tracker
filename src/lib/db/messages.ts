import "server-only";

import type { Message, MessageMetadata, MessageRole } from "@/lib/domain/types";
import { DataValidationError, NotFoundError, dbError, requireDb } from "./client";
import type { Json, MessageRow } from "./database.types";

/**
 * Messages inside a conversation. Ownership of the parent conversation is
 * enforced by RLS plus a same-owner trigger in the database.
 */

export const MESSAGE_MAX_LENGTH = 20000;

function toMetadata(value: Json): MessageMetadata {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: toMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

/**
 * Messages in chronological order. With `limit`, returns the latest N.
 * Pass `before` (an ISO timestamp) to page further back.
 */
export async function listMessages(
  userId: string,
  conversationId: string,
  options: { limit?: number; before?: string } = {},
): Promise<Message[]> {
  const supabase = await requireDb();
  let query = supabase
    .from("messages")
    .select("*")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 200);
  if (options.before) query = query.lt("created_at", options.before);
  const { data, error } = await query;
  if (error) throw dbError(error);
  return data.map(toMessage).reverse();
}

export async function getMessage(userId: string, id: string): Promise<Message | null> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw dbError(error);
  return data ? toMessage(data) : null;
}

export async function appendMessage(
  userId: string,
  input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    metadata?: MessageMetadata;
  },
): Promise<Message> {
  const content = input.content.trim();
  if (!content) throw new DataValidationError("Message is empty.");
  if (content.length > MESSAGE_MAX_LENGTH) {
    throw new DataValidationError(`Message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`);
  }

  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("messages")
    .insert({
      user_id: userId,
      conversation_id: input.conversationId,
      role: input.role,
      content,
      metadata: input.metadata ?? {},
    })
    .select("*")
    .single();
  if (error) throw dbError(error);
  return toMessage(data);
}

/** Replaces a message's metadata, e.g. to mark a proposed fact as saved. */
export async function updateMessageMetadata(
  userId: string,
  id: string,
  metadata: MessageMetadata,
): Promise<Message> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("messages")
    .update({ metadata })
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Message");
  return toMessage(data);
}
