import "server-only";

import { cache } from "react";

import { isAiConfigured } from "@/lib/ai/config";
import { getSessionUser } from "@/lib/auth/session";
import { getConversation, getLatestConversation, listConversations } from "@/lib/db/conversations";
import { listMessages } from "@/lib/db/messages";
import { listPlansForConversation, toPlanView } from "@/lib/db/plans";
import type { Conversation } from "@/lib/domain/types";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { ConversationSummary } from "../history";
import { toChatMessage, type ChatMessage } from "../types";
import { loadChatContext, type ChatContext } from "./context";

/**
 * Page data for the assistant and onboarding screens. Reads cookies, so
 * callers render inside <Suspense>.
 */

export type ChatPageData =
  | { state: "no_storage" }
  | { state: "signed_out" }
  | { state: "not_found" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      aiConfigured: boolean;
      conversation: Conversation | null;
      messages: ChatMessage[];
      conversations: ConversationSummary[];
      context: ChatContext;
    };

const MESSAGE_PAGE = 200;

async function base() {
  if (!isSupabaseConfigured()) return { state: "no_storage" as const };
  const user = await getSessionUser();
  if (!user) return { state: "signed_out" as const };
  return { state: "ok" as const, user };
}

function summarize(c: Conversation): ConversationSummary {
  return { id: c.id, kind: c.kind, title: c.title, lastMessageAt: c.lastMessageAt };
}

export const loadAssistantPage = cache(async (conversationId: string | null): Promise<ChatPageData> => {
  const b = await base();
  if (b.state !== "ok") return b;
  try {
    const [conversation, conversations] = await Promise.all([
      conversationId ? getConversation(b.user.id, conversationId) : Promise.resolve(null),
      listConversations(b.user.id, { limit: 50 }),
    ]);
    if (conversationId && (!conversation || conversation.kind !== "assistant")) return { state: "not_found" };
    const [messages, context, plans] = await Promise.all([
      conversation ? listMessages(b.user.id, conversation.id, { limit: MESSAGE_PAGE }) : Promise.resolve([]),
      loadChatContext(b.user.id, { conversationId: conversation?.id }),
      conversation ? listPlansForConversation(b.user.id, conversation.id) : Promise.resolve(new Map()),
    ]);
    return {
      state: "ready",
      aiConfigured: isAiConfigured(),
      conversation,
      messages: messages.map((m) => {
        const plan = plans.get(m.id);
        return toChatMessage(m, plan ? toPlanView(plan) : null);
      }),
      conversations: conversations.map(summarize),
      context,
    };
  } catch (error) {
    console.error("[assistant] page load failed", error);
    return { state: "error", message: "Couldn't load your conversations. Refresh to try again." };
  }
});

export const loadOnboardingPage = cache(async (): Promise<ChatPageData> => {
  const b = await base();
  if (b.state !== "ok") return b;
  try {
    const conversation = await getLatestConversation(b.user.id, "onboarding");
    const [messages, context] = await Promise.all([
      conversation ? listMessages(b.user.id, conversation.id, { limit: MESSAGE_PAGE }) : Promise.resolve([]),
      loadChatContext(b.user.id, { conversationId: conversation?.id }),
    ]);
    return {
      state: "ready",
      aiConfigured: isAiConfigured(),
      conversation,
      messages: messages.map((m) => toChatMessage(m)),
      conversations: [],
      context,
    };
  } catch (error) {
    console.error("[onboarding] page load failed", error);
    return { state: "error", message: "Couldn't load setup. Refresh to try again." };
  }
});
