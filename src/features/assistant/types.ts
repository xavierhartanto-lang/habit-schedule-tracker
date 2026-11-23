import type { Clarification, ExtractedItem } from "@/lib/ai/extraction";
import type { AiErrorCode } from "@/lib/ai/errors";
import type { ConversationKind, Message, MessageMetadata } from "@/lib/domain/types";
import type { CheckInKind, Clarify, ClarifyField, PlanView } from "./plan-types";

/**
 * Client-safe types for the conversation UI and the /api/chat stream.
 * No server imports here: only types.
 */

export type ProposalStatus = "pending" | "saved" | "dismissed";

/** A fact the AI noticed in one user message. Nothing is saved until the user taps Save. */
export type Proposal = {
  id: string;
  status: ProposalStatus;
  item: ExtractedItem;
  /** Set once saved: where the confirmed fact now lives. */
  saved?: { table: "commitments" | "goals" | "context_items"; id: string; updated: boolean } | null;
};

/** What a user message stores in `messages.metadata`. */
export type UserMessageMeta = {
  proposals?: Proposal[];
  clarifications?: Clarification[];
  /** Set when fact extraction failed for this message. The reply may still exist. */
  extractionError?: AiErrorCode;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  proposals: Proposal[];
  clarifications: Clarification[];
  extractionError: AiErrorCode | null;
  /** Phase 4: the plan this assistant message presented (filled by the page loader). */
  plan: PlanView | null;
  /** Phase 4: the follow-up question this assistant message asked. */
  clarify: Clarify | null;
};

export type ClientAiError = { code: AiErrorCode | "not_signed_in" | "storage_unavailable" | "bad_input"; message: string; retryable: boolean };

/** One line of the NDJSON stream from POST /api/chat. */
export type ChatStreamEvent =
  | { type: "conversation"; conversation: { id: string; kind: ConversationKind; title: string | null } }
  | { type: "user_message"; message: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "assistant_message"; message: ChatMessage }
  | {
      type: "proposals";
      messageId: string;
      proposals: Proposal[];
      clarifications: Clarification[];
      extractionError: AiErrorCode | null;
    }
  | { type: "plan"; messageId: string; plan: PlanView }
  | { type: "clarify"; messageId: string; clarify: Clarify }
  | { type: "error"; error: ClientAiError }
  | { type: "done" };

export type ChatRequestBody = {
  mode: ConversationKind;
  /** This device's time zone. Adopted only while the profile is still on the UTC default. */
  timeZone?: string;
  conversationId?: string | null;
  /** The user's new message. Omit to let the assistant open (onboarding) or with `retry`. */
  message?: string;
  /** Regenerate the reply to the last user message (after an error). */
  retry?: boolean;
  /** Phase 4: open a planning check-in. Send with no message and no conversationId. */
  checkIn?: CheckInKind;
  /**
   * Phase 4: the opening line Home showed (built from real data). Saved as the
   * first assistant message of a new conversation so the model sees it.
   * Only honored with a message and no conversationId. Max 300 characters.
   */
  opening?: string;
  /**
   * Phase 5: the user tapped a proactive button. The server builds the plan
   * deterministically (no planner model), so this works without the AI.
   * `message` carries the button label.
   */
  proactive?: ChatProactive;
  /**
   * Phase 5: the suggestion line the user is answering. Saved as an assistant
   * message right before theirs, also in an existing conversation. Max 300 characters.
   */
  nudge?: string;
};

export type ChatProactive = { kind: "daily_plan" } | { kind: "catch_up" } | { kind: "recommendation"; id: string; actionId: string };

export const OPENING_MAX = 300;

const CLARIFY_FIELDS: readonly ClarifyField[] = ["date", "time", "duration", "recurrence", "days", "deadline", "amount", "target", "recipient", "message", "other"];

/** Reads the follow-up question stored on an assistant message. */
export function readClarify(metadata: MessageMetadata | unknown): Clarify | null {
  const meta = isRecord(metadata) ? metadata : {};
  const c = meta.clarify;
  if (!isRecord(c) || typeof c.question !== "string" || typeof c.about !== "string") return null;
  return {
    question: c.question,
    about: c.about,
    field: CLARIFY_FIELDS.includes(c.field as ClarifyField) ? (c.field as ClarifyField) : "other",
    choices: Array.isArray(c.choices) ? c.choices.filter((x): x is string => typeof x === "string").slice(0, 4) : [],
  };
}

export const CHAT_MESSAGE_MAX = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads proposal metadata defensively: stored JSON is never trusted blindly. */
export function readUserMessageMeta(metadata: MessageMetadata | unknown): Required<Omit<UserMessageMeta, "extractionError">> & {
  extractionError: AiErrorCode | null;
} {
  const meta = isRecord(metadata) ? metadata : {};
  const proposals = Array.isArray(meta.proposals)
    ? (meta.proposals as unknown[]).filter(
        (p): p is Proposal =>
          isRecord(p) &&
          typeof p.id === "string" &&
          (p.status === "pending" || p.status === "saved" || p.status === "dismissed") &&
          isRecord(p.item) &&
          typeof (p.item as Record<string, unknown>).title === "string" &&
          typeof (p.item as Record<string, unknown>).category === "string",
      )
    : [];
  const clarifications = Array.isArray(meta.clarifications)
    ? (meta.clarifications as unknown[]).filter(
        (c): c is Clarification => isRecord(c) && typeof c.question === "string",
      )
    : [];
  const extractionError = typeof meta.extractionError === "string" ? (meta.extractionError as AiErrorCode) : null;
  return { proposals, clarifications, extractionError };
}

export function toChatMessage(message: Message, plan: PlanView | null = null): ChatMessage {
  const meta = message.role === "user" ? readUserMessageMeta(message.metadata) : null;
  return {
    plan: message.role === "assistant" ? plan : null,
    clarify: message.role === "assistant" ? readClarify(message.metadata) : null,
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    proposals: meta?.proposals ?? [],
    clarifications: meta?.clarifications ?? [],
    extractionError: meta?.extractionError ?? null,
  };
}
