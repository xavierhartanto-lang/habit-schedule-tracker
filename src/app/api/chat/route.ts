import { randomUUID } from "node:crypto";

import { isAiConfigured } from "@/lib/ai/config";
import { AiError, toAiError, type AiErrorCode } from "@/lib/ai/errors";
import type { Clarification, KnownFactRef } from "@/lib/ai/extraction";
import type { ChatTurn } from "@/lib/ai/prompts";
import { extractFacts, streamReply } from "@/lib/ai/service";
import { getSessionUser } from "@/lib/auth/session";
import { createConversation, getConversation, updateConversation } from "@/lib/db/conversations";
import { appendMessage, listMessages, updateMessageMetadata } from "@/lib/db/messages";
import type { Conversation, Message, MessageMetadata } from "@/lib/domain/types";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { loadChatContext } from "@/features/assistant/server/context";
import {
  CHAT_MESSAGE_MAX,
  readUserMessageMeta,
  toChatMessage,
  type ChatRequestBody,
  type ChatStreamEvent,
  type ClientAiError,
  type Proposal,
} from "@/features/assistant/types";

/**
 * POST /api/chat
 *
 * Saves the user's message, streams the assistant's reply as NDJSON, saves
 * the reply, and attaches any facts the AI noticed to the user's message as
 * *proposals*. Proposals are never written to the user's context here:
 * that only happens when the user taps Save (see features/assistant/actions.ts).
 *
 * Without ANTHROPIC_API_KEY it refuses before saving anything, so the UI
 * can show the configuration state instead of a fake reply.
 */

const HISTORY_LIMIT = 60;
const ONBOARDING_TITLE = "Getting to know you";

function jsonError(status: number, error: ClientAiError) {
  return Response.json({ error }, { status });
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine;
}

function parseBody(raw: unknown): ChatRequestBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (b.mode !== "onboarding" && b.mode !== "assistant") return null;
  if (b.conversationId != null && typeof b.conversationId !== "string") return null;
  if (b.message != null && typeof b.message !== "string") return null;
  return {
    mode: b.mode,
    conversationId: (b.conversationId as string | null | undefined) ?? null,
    message: typeof b.message === "string" ? b.message.trim() : undefined,
    retry: b.retry === true,
  };
}

const toTurn = (m: Message): ChatTurn => ({ role: m.role, content: m.content });

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return jsonError(503, {
      code: "storage_unavailable",
      message: "Whitespace can't save conversations until Supabase is configured.",
      retryable: false,
    });
  }
  const user = await getSessionUser();
  if (!user) return jsonError(401, { code: "not_signed_in", message: "Sign in to talk to the assistant.", retryable: false });

  const body = parseBody(await request.json().catch(() => null));
  if (!body) return jsonError(400, { code: "bad_input", message: "That request didn't look right.", retryable: false });
  if (body.message && body.message.length > CHAT_MESSAGE_MAX) {
    return jsonError(400, {
      code: "bad_input",
      message: `Keep messages under ${CHAT_MESSAGE_MAX.toLocaleString()} characters.`,
      retryable: false,
    });
  }

  // No key: refuse before saving anything. Never fake a reply.
  if (!isAiConfigured()) {
    return jsonError(503, new AiError("not_configured").toJSON());
  }

  // ---- Load or create the conversation, save the user's message ----
  let conversation: Conversation;
  let history: Message[] = [];
  let userMessage: Message | null = null;
  let createdUserMessage = false;
  let created = false;

  try {
    if (body.conversationId) {
      const found = await getConversation(user.id, body.conversationId);
      if (!found) return jsonError(404, { code: "bad_input", message: "That conversation wasn't found.", retryable: false });
      if (found.kind !== body.mode) return jsonError(400, { code: "bad_input", message: "Wrong conversation type.", retryable: false });
      conversation = found;
      history = await listMessages(user.id, conversation.id, { limit: HISTORY_LIMIT });
    } else {
      if (body.mode === "assistant" && !body.message) {
        return jsonError(400, { code: "bad_input", message: "Type a message first.", retryable: false });
      }
      conversation = await createConversation(user.id, {
        kind: body.mode,
        title: body.mode === "onboarding" ? ONBOARDING_TITLE : titleFrom(body.message ?? ""),
      });
      created = true;
    }

    if (body.retry) {
      const last = history.at(-1);
      if (!last || last.role !== "user") {
        return jsonError(409, { code: "bad_input", message: "There's nothing to retry.", retryable: false });
      }
      userMessage = last;
    } else if (body.message) {
      userMessage = await appendMessage(user.id, {
        conversationId: conversation.id,
        role: "user",
        content: body.message,
      });
      createdUserMessage = true;
      history.push(userMessage);
      if (!conversation.title && body.mode === "assistant") {
        conversation = await updateConversation(user.id, conversation.id, { title: titleFrom(body.message) });
      }
    } else if (history.length > 0) {
      // Opening turn (onboarding greeting) only applies to an empty conversation.
      return jsonError(409, { code: "bad_input", message: "This conversation already started.", retryable: false });
    }
  } catch (error) {
    console.error("[chat] could not save message", error);
    return jsonError(500, {
      code: "storage_unavailable",
      message: "Your message couldn't be saved. Check your connection and try again.",
      retryable: true,
    });
  }

  // ---- Stream the reply ----
  const encoder = new TextEncoder();
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: ChatStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      send({
        type: "conversation",
        conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
      });
      if (createdUserMessage && userMessage) send({ type: "user_message", message: toChatMessage(userMessage) });

      try {
        const chatContext = await loadChatContext(user.id, { conversationId: conversation.id }).catch((error) => {
          console.error("[chat] could not load user context", error);
          return null;
        });
        if (!chatContext) {
          send({
            type: "error",
            error: { code: "storage_unavailable", message: "Couldn't load what Whitespace knows about you. Try again.", retryable: true },
          });
          return;
        }

        const turns = history.map(toTurn);

        // Fact extraction runs alongside the reply. It only proposes; it never saves.
        const existingMeta = userMessage ? readUserMessageMeta(userMessage.metadata) : null;
        const shouldExtract =
          userMessage !== null && (createdUserMessage || (existingMeta?.proposals.length === 0 && !existingMeta.clarifications.length));

        let extraction: Promise<{
          proposals: Proposal[];
          clarifications: Clarification[];
          extractionError: AiErrorCode | null;
        }> | null = null;

        if (shouldExtract && userMessage) {
          const alreadyProposed: KnownFactRef[] = history.flatMap((m) =>
            m.role === "user" && m.id !== userMessage!.id
              ? readUserMessageMeta(m.metadata).proposals.map((p) => ({ category: p.item.category, title: p.item.title }))
              : [],
          );
          extraction = extractFacts({
            userMessage: userMessage.content,
            history: turns.slice(0, -1),
            known: [...chatContext.known, ...alreadyProposed],
            today: chatContext.today,
            signal,
          })
            .then((result) => {
              if (result.dropped.length) console.info("[chat] extraction dropped", result.dropped);
              return {
                proposals: result.items.map((item) => ({ id: randomUUID(), status: "pending" as const, item })),
                clarifications: result.clarifications,
                extractionError: null,
              };
            })
            .catch((error) => {
              const aiError = toAiError(error);
              if (aiError.code !== "aborted") console.error("[chat] extraction failed", aiError.code, aiError.cause);
              return { proposals: [], clarifications: [], extractionError: aiError.code };
            });
        }

        // Reply
        try {
          const reply = streamReply({ mode: body.mode, context: chatContext.prompt, history: turns, signal });
          let result = await reply.next();
          while (!result.done) {
            send({ type: "delta", text: result.value });
            result = await reply.next();
          }
          const saved = await appendMessage(user.id, {
            conversationId: conversation.id,
            role: "assistant",
            content: result.value.text,
            metadata: { model: result.value.model },
          });
          send({ type: "assistant_message", message: toChatMessage(saved) });
        } catch (error) {
          const aiError = toAiError(error);
          if (aiError.code !== "aborted") console.error("[chat] reply failed", aiError.code, aiError.cause ?? error);
          send({
            type: "error",
            error:
              error instanceof Error && error.name === "DatabaseError"
                ? { code: "storage_unavailable", message: "The reply couldn't be saved. Try again.", retryable: true }
                : aiError.toJSON(),
          });
        }

        // Proposals: stored on the user's message so their source is clear.
        if (extraction && userMessage) {
          const result = await extraction;
          if (result.extractionError !== "aborted") {
            const metadata = {
              ...userMessage.metadata,
              proposals: result.proposals,
              clarifications: result.clarifications,
              ...(result.extractionError ? { extractionError: result.extractionError } : {}),
            } as unknown as MessageMetadata;
            try {
              await updateMessageMetadata(user.id, userMessage.id, metadata);
              send({ type: "proposals", messageId: userMessage.id, ...result });
            } catch (error) {
              console.error("[chat] could not store proposals", error);
            }
          }
        }
      } finally {
        send({ type: "done" });
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a disconnect.
        }
      }
    },
  });

  return new Response(stream, {
    status: created ? 201 : 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
