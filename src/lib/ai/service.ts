import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { fallbackParams, getAiClient } from "./client";
import { AiError, toAiError } from "./errors";
import {
  ExtractionWireSchema,
  validateExtraction,
  type ExtractionResult,
  type KnownFactRef,
} from "./extraction";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  buildSystemPrompt,
  toApiTurns,
  type ChatTurn,
  type ConversationMode,
  type PromptContext,
  type ReplyExtras,
} from "./prompts";
import { PlannerApiSchema, fromApiWire, validatePlannerOutput, type Draft, type PlannerResult } from "@/lib/assistant/intents";
import { formatFactTitle, type NamingContext } from "@/lib/assistant/naming";
import { PLANNER_SYSTEM_PROMPT } from "@/lib/assistant/planner-prompt";

/**
 * Entry points Chunk C calls from route handlers / server actions.
 *
 *   streamReply   -> async iterable of text chunks for the chat bubble.
 *   extractFacts  -> validated proposals (never saved here).
 *
 * Both throw AiError. Use `error.toJSON()` to send a safe error to the client.
 */

/** How many recent turns to send. Older turns are dropped, never summarized silently. */
export const MAX_HISTORY_TURNS = 40;
const EXTRACTION_HISTORY_TURNS = 6;

export type StreamReplyInput = {
  mode: ConversationMode;
  context: PromptContext;
  history: ChatTurn[];
  /** Phase 4 extras: server actions summary and check-in data. */
  extras?: ReplyExtras;
  signal?: AbortSignal;
};

export type ReplyStream = AsyncGenerator<string, { text: string; model: string }, void>;

/**
 * Stream the assistant's reply. Yields text deltas, returns the full text.
 * If the stream fails midway, it throws after the partial text was yielded:
 * the caller should keep or discard the partial explicitly, not save it as complete.
 */
export async function* streamReply(input: StreamReplyInput): ReplyStream {
  const { client, model } = getAiClient();
  const [stable, userSpecific] = buildSystemPrompt(input.mode, input.context, input.extras);
  const turns = toApiTurns(input.history.slice(-MAX_HISTORY_TURNS), input.mode, input.extras?.checkIn?.kind ?? null);

  let text = "";
  try {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 16_000,
        output_config: { effort: "low" },
        system: [
          { type: "text", text: stable, cache_control: { type: "ephemeral" } },
          { type: "text", text: userSpecific },
        ],
        messages: turns,
        ...fallbackParams(model),
      },
      { signal: input.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        yield event.delta.text;
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new AiError("refused");
    if (!text.trim()) throw new AiError("invalid_output", { message: "Empty reply" });
    return { text, model: final.model };
  } catch (error) {
    throw toAiError(error);
  }
}

export type ExtractFactsInput = {
  /** The user's latest message. Evidence is checked against this text. */
  userMessage: string;
  /** Conversation so far (excluding userMessage), for resolving references. */
  history: ChatTurn[];
  known: KnownFactRef[];
  today: { date: string; weekday: string };
  signal?: AbortSignal;
};

/**
 * Extract structured facts from the user's latest message.
 * Returns validated proposals. Ungrounded or malformed items are dropped
 * and listed in `dropped` for logging.
 */
export async function extractFacts(input: ExtractFactsInput): Promise<ExtractionResult> {
  const empty: ExtractionResult = { items: [], clarifications: [], dropped: [] };
  if (input.userMessage.trim().length < 3) return empty;

  const { client, model } = getAiClient();

  let response;
  try {
    response = await client.beta.messages.parse(
      {
        model,
        max_tokens: 16_000,
        output_config: { effort: "medium", format: zodOutputFormat(ExtractionWireSchema) },
        system: [{ type: "text", text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: buildExtractionUserPrompt({
              newUserText: input.userMessage,
              recentHistory: input.history.slice(-EXTRACTION_HISTORY_TURNS),
              known: input.known,
              today: input.today,
            }),
          },
        ],
        ...fallbackParams(model),
      },
      { signal: input.signal },
    );
  } catch (error) {
    // The SDK throws a plain AnthropicError (not an APIError) when the output
    // is not valid JSON or does not match the schema.
    if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
      throw new AiError("invalid_output", { cause: error });
    }
    throw toAiError(error);
  }

  if (response.stop_reason === "refusal") throw new AiError("refused");
  if (response.stop_reason === "max_tokens" || response.parsed_output == null) {
    throw new AiError("invalid_output", { message: `Extraction unusable (stop_reason=${response.stop_reason})` });
  }

  try {
    const result = validateExtraction(response.parsed_output, { userText: input.userMessage, known: input.known });
    const sources = [input.userMessage, ...input.history.map((t) => t.content)];
    return { ...result, items: result.items.map((item) => ({ ...item, title: formatFactTitle(item.category, item.title, sources) })) };
  } catch (error) {
    throw new AiError("invalid_output", { cause: error });
  }
}

export type InterpretInput = {
  /** The user's latest message. Evidence is checked against this text. */
  userMessage: string;
  /** Built by buildPlannerUserPrompt (context, refs, drafts, recent turns). */
  prompt: string;
  drafts: Draft[];
  /** What new titles may draw on beyond the user's message (see lib/assistant/naming). */
  naming?: NamingContext;
  signal?: AbortSignal;
};

/**
 * Phase 4: turn the user's message into validated intents (structured
 * outputs). Never writes anything: the plan service validates, asks
 * follow-ups and builds proposals from the result.
 */
export async function interpretMessage(input: InterpretInput): Promise<PlannerResult> {
  const empty: PlannerResult = { intents: [], consumedDrafts: [], confirmed: [], cancelled: [], question: null, dropped: [], retitled: [] };
  if (!input.userMessage.trim()) return empty;
  const { client, model } = getAiClient();

  let response;
  try {
    response = await client.beta.messages.parse(
      {
        model,
        max_tokens: 16_000,
        output_config: { effort: "medium", format: zodOutputFormat(PlannerApiSchema) },
        system: [{ type: "text", text: PLANNER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: input.prompt }],
        ...fallbackParams(model),
      },
      { signal: input.signal },
    );
  } catch (error) {
    if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
      throw new AiError("invalid_output", { cause: error });
    }
    throw toAiError(error);
  }

  if (response.stop_reason === "refusal") throw new AiError("refused");
  if (response.stop_reason === "max_tokens" || response.parsed_output == null) {
    throw new AiError("invalid_output", { message: `Planner unusable (stop_reason=${response.stop_reason})` });
  }
  try {
    return validatePlannerOutput(fromApiWire(response.parsed_output), {
      userText: input.userMessage,
      drafts: input.drafts,
      naming: input.naming,
    });
  } catch (error) {
    throw new AiError("invalid_output", { cause: error });
  }
}
