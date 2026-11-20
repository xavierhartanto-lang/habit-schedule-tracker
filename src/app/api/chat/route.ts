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
import { checkInText, loadCheckIn } from "@/features/assistant/server/checkin";
import { planTurn } from "@/features/assistant/server/plan-service";
import type { Clarify, PlanView } from "@/features/assistant/plan-types";
import { plannerResultBlock, type PlannerKnowledge } from "@/lib/assistant/planner-prompt";
import { getPlan, setPlanMessage, toPlanView } from "@/lib/db/plans";
import { NotFoundError } from "@/lib/db/client";
import { isUuid } from "@/lib/domain/context-items";
import { fallbackReply } from "@/features/assistant/fallback-reply";
import { proposeDailyPlanFor, proposeFromRecommendationFor } from "@/features/proactive/server/service";
import {
  CHAT_MESSAGE_MAX,
  OPENING_MAX,
  readUserMessageMeta,
  toChatMessage,
  type ChatProactive,
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
 *
 * Phase 4 (assistant mode): before replying, the planner turns the message
 * into validated intents. The server asks one follow-up at a time, builds a
 * plan with the scheduling engine and stores it (calendar items wait for
 * approval). The reply model is told exactly what happened. The plan and
 * the follow-up question are streamed as "plan" / "clarify" events.
 * Onboarding keeps the Phase 2 fact extraction.
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
  const checkIn = b.checkIn === "daily" || b.checkIn === "weekly" ? b.checkIn : undefined;
  const line = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, OPENING_MAX) : undefined);
  const opening = line(b.opening);
  const proactive = b.mode === "assistant" ? parseProactive(b.proactive) : undefined;
  if (b.proactive != null && !proactive) return null;
  return {
    mode: b.mode,
    conversationId: (b.conversationId as string | null | undefined) ?? null,
    message: typeof b.message === "string" ? b.message.trim() : undefined,
    retry: b.retry === true,
    checkIn: b.mode === "assistant" ? checkIn : undefined,
    opening: b.mode === "assistant" ? opening : undefined,
    proactive,
    nudge: b.mode === "assistant" ? line(b.nudge) : undefined,
  };
}

function parseProactive(raw: unknown): ChatProactive | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (p.kind === "daily_plan") return { kind: "daily_plan" };
  if (p.kind === "recommendation" && isUuid(p.id) && typeof p.actionId === "string" && /^[\w-]{1,60}$/.test(p.actionId)) {
    return { kind: "recommendation", id: p.id, actionId: p.actionId };
  }
  return undefined;
}

const CHECKIN_TITLE = { daily: "Daily check-in", weekly: "Weekly check-in" } as const;

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
  if (body.proactive && !body.message) {
    return jsonError(400, { code: "bad_input", message: "That request didn't look right.", retryable: false });
  }
  if (body.message && body.message.length > CHAT_MESSAGE_MAX) {
    return jsonError(400, {
      code: "bad_input",
      message: `Keep messages under ${CHAT_MESSAGE_MAX.toLocaleString()} characters.`,
      retryable: false,
    });
  }

  // No key: refuse before saving anything. Never fake a reply. Proactive
  // buttons are the exception: their plan is built without the AI, and the
  // reply is a plain description of that plan.
  const aiConfigured = isAiConfigured();
  if (!aiConfigured && !body.proactive) {
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
      if (body.mode === "assistant" && !body.message && !body.checkIn) {
        return jsonError(400, { code: "bad_input", message: "Type a message first.", retryable: false });
      }
      conversation = await createConversation(user.id, {
        kind: body.mode,
        title:
          body.mode === "onboarding"
            ? ONBOARDING_TITLE
            : body.message
              ? titleFrom(body.message)
              : CHECKIN_TITLE[body.checkIn ?? "daily"],
      });
      created = true;
      // Home's opening line (built from real data) becomes the first assistant
      // message, so a reply like "yes" has context.
      if (body.opening && body.message) {
        history.push(
          await appendMessage(user.id, {
            conversationId: conversation.id,
            role: "assistant",
            content: body.opening,
            metadata: { source: "home_opening" },
          }),
        );
      }
    }

    // Phase 5: the suggestion line the user is answering, so the reply has context.
    if (body.nudge && body.message && !body.retry && history.at(-1)?.content !== body.nudge) {
      history.push(
        await appendMessage(user.id, {
          conversationId: conversation.id,
          role: "assistant",
          content: body.nudge,
          metadata: { source: "proactive_nudge" },
        }),
      );
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
    } else if (history.length > 0 || (body.mode === "assistant" && !body.checkIn)) {
      // Opening turn (onboarding greeting, check-in) only applies to an empty conversation.
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
          body.mode === "onboarding" &&
          userMessage !== null &&
          (createdUserMessage || (existingMeta?.proposals.length === 0 && !existingMeta.clarifications.length));

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

        // Phase 4: plan before replying, so the reply describes real results.
        let plan: PlanView | null = null;
        let clarify: Clarify | null = null;
        let extras: Parameters<typeof streamReply>[0]["extras"];
        let proactiveFailed: string | null = null;
        if (body.mode === "assistant") {
          const phase4 =
            body.proactive && userMessage
              ? await runProactive(user.id, conversation.id, userMessage, body.proactive, createdUserMessage)
              : await runPhase4(user.id, conversation.id, userMessage, turns, body, createdUserMessage, signal, {
                  personalizationEnabled: chatContext.prompt.personalizationEnabled,
                  profile: chatContext.prompt.profile,
                  facts: chatContext.prompt.facts,
                  recaps: chatContext.recaps,
                });
          plan = phase4.plan;
          clarify = phase4.clarify;
          extras = phase4.extras;
          proactiveFailed = (phase4 as { failed?: string | null }).failed ?? null;
        }

        const finish = async (content: string, metadata: MessageMetadata) => {
          const saved = await appendMessage(user.id, {
            conversationId: conversation.id,
            role: "assistant",
            content,
            metadata: {
              ...metadata,
              ...(plan ? { planId: plan.id } : {}),
              ...(clarify ? { clarify: clarify as unknown as MessageMetadata[string] } : {}),
            },
          });
          if (plan) {
            await setPlanMessage(user.id, plan.id, saved.id).catch((error) => console.error("[chat] could not link plan", error));
            plan = { ...plan, messageId: saved.id };
          }
          send({ type: "assistant_message", message: toChatMessage(saved, plan) });
          if (plan) send({ type: "plan", messageId: saved.id, plan });
          if (clarify) send({ type: "clarify", messageId: saved.id, clarify });
        };

        // Reply
        let streamed = false;
        try {
          if (!aiConfigured) {
            // Only proactive requests get here (see above): describe the plan plainly.
            await finish(fallbackReply({ plan, failed: proactiveFailed }), { source: "fallback" });
          } else {
            const reply = streamReply({ mode: body.mode, context: chatContext.prompt, history: turns, extras, signal });
            let result = await reply.next();
            while (!result.done) {
              streamed = true;
              send({ type: "delta", text: result.value });
              result = await reply.next();
            }
            await finish(result.value.text, { model: result.value.model });
          }
        } catch (error) {
          const aiError = toAiError(error);
          if (aiError.code !== "aborted") console.error("[chat] reply failed", aiError.code, aiError.cause ?? error);
          const storage = error instanceof Error && error.name === "DatabaseError";
          // A proactive plan is already built: still show it, with a plain reply.
          let recovered = false;
          if (body.proactive && !storage && aiError.code !== "aborted" && !streamed) {
            recovered = await finish(fallbackReply({ plan, failed: proactiveFailed }), { source: "fallback" }).then(
              () => true,
              () => false,
            );
          }
          if (!recovered) {
            send({
              type: "error",
              error: storage
                ? { code: "storage_unavailable", message: "The reply couldn't be saved. Try again.", retryable: true }
                : aiError.toJSON(),
            });
          }
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

/**
 * Runs the planner for a new user message (or reuses the plan already made
 * for it on retry), and builds the reply extras. Planner failures never
 * block the reply: the model is told nothing was changed.
 */
async function runPhase4(
  userId: string,
  conversationId: string,
  userMessage: Message | null,
  turns: ChatTurn[],
  body: ChatRequestBody,
  isNew: boolean,
  signal: AbortSignal,
  knowledge: PlannerKnowledge,
): Promise<{ plan: PlanView | null; clarify: Clarify | null; extras: Parameters<typeof streamReply>[0]["extras"] }> {
  if (!userMessage) {
    if (!body.checkIn) return { plan: null, clarify: null, extras: undefined };
    try {
      const checkIn = await loadCheckIn(userId, body.checkIn);
      return { plan: null, clarify: null, extras: { checkIn: { kind: body.checkIn, data: checkInText(checkIn) }, actions: null } };
    } catch (error) {
      console.error("[chat] check-in data failed", error);
      return {
        plan: null,
        clarify: null,
        extras: { checkIn: { kind: body.checkIn, data: "Could not load the user's schedule right now. Say so briefly and ask what they want to plan." }, actions: null },
      };
    }
  }

  const meta = userMessage.metadata as Record<string, unknown>;
  if (!isNew && typeof meta.planId === "string") {
    // Retry: never plan the same message twice.
    try {
      const view = toPlanView(await getPlan(userId, meta.planId));
      return { plan: view, clarify: null, extras: { actions: plannerResultBlock({ plan: view, question: null, notes: [], failed: null }) } };
    } catch {
      return { plan: null, clarify: null, extras: { actions: null } };
    }
  }
  if (!isNew && meta.planned === true) return { plan: null, clarify: null, extras: { actions: null } };

  try {
    const result = await planTurn({
      userId,
      conversationId,
      userMessageId: userMessage.id,
      userText: userMessage.content,
      history: turns.slice(0, -1),
      knowledge,
      signal,
    });
    await updateMessageMetadata(userId, userMessage.id, {
      ...userMessage.metadata,
      planned: true,
      ...(result.plan ? { planId: result.plan.id } : {}),
    }).catch((error) => console.error("[chat] could not mark message planned", error));
    return { plan: result.plan, clarify: result.clarify, extras: { actions: result.actions } };
  } catch (error) {
    const aiError = toAiError(error);
    if (aiError.code !== "aborted") console.error("[chat] planning failed", aiError.code, aiError.cause ?? error);
    const failed = error instanceof Error && error.name === "DatabaseError" ? "a storage error" : aiError.userMessage;
    return { plan: null, clarify: null, extras: { actions: plannerResultBlock({ plan: null, question: null, notes: [], failed }) } };
  }
}

/**
 * Phase 5: a proactive button. The proactive engine builds the plan from its
 * own stored recommendation (or recomputes today's brief), so nothing the
 * client sends beyond ids is trusted and no planner model runs. The plan is
 * an ordinary Phase 4 plan: pending until the user approves it.
 */
async function runProactive(
  userId: string,
  conversationId: string,
  userMessage: Message,
  proactive: ChatProactive,
  isNew: boolean,
): Promise<{ plan: PlanView | null; clarify: Clarify | null; extras: Parameters<typeof streamReply>[0]["extras"]; failed?: string | null }> {
  const meta = userMessage.metadata as Record<string, unknown>;
  if (!isNew && typeof meta.planId === "string") {
    try {
      const view = toPlanView(await getPlan(userId, meta.planId));
      return { plan: view, clarify: null, extras: { actions: plannerResultBlock({ plan: view, question: null, notes: [], failed: null }) } };
    } catch {
      return { plan: null, clarify: null, extras: { actions: null } };
    }
  }

  try {
    let plan: PlanView | null;
    let note: string;
    if (proactive.kind === "daily_plan") {
      const result = await proposeDailyPlanFor(userId, { conversationId, sourceMessageId: userMessage.id });
      plan = result.plan;
      note = `The user tapped "${userMessage.content}" on today's brief, which said: ${result.brief.message} Explain the plan for today briefly.`;
    } else {
      const result = await proposeFromRecommendationFor(userId, {
        id: proactive.id,
        actionId: proactive.actionId,
        conversationId,
        sourceMessageId: userMessage.id,
      });
      plan = result.plan;
      const r = result.recommendation;
      note = `The user tapped "${userMessage.content}" on a suggestion Whitespace raised: ${r.message} Facts: ${r.facts.join("; ") || "none"}. Explain the suggested change briefly, using only these facts and the plan.`;
    }
    await updateMessageMetadata(userId, userMessage.id, {
      ...userMessage.metadata,
      planned: true,
      ...(plan ? { planId: plan.id } : {}),
    }).catch((error) => console.error("[chat] could not mark message planned", error));
    return {
      plan,
      clarify: null,
      extras: { actions: plannerResultBlock({ plan, question: null, notes: [note], failed: null }) },
    };
  } catch (error) {
    const failed =
      error instanceof NotFoundError
        ? "That suggestion is no longer available."
        : error instanceof Error && error.name === "DatabaseError"
          ? "Couldn't load your schedule right now."
          : "Couldn't put that plan together right now.";
    if (!(error instanceof NotFoundError)) console.error("[chat] proactive plan failed", error);
    return {
      plan: null,
      clarify: null,
      failed,
      extras: { actions: plannerResultBlock({ plan: null, question: null, notes: [], failed }) },
    };
  }
}
