import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { getAiConfig } from "./config";
import { AiError } from "./errors";

/**
 * Server-side Anthropic client. Never import this from a client component.
 * Throws AiError("not_configured") when ANTHROPIC_API_KEY is missing, so the
 * caller can show the configuration state instead of a fake reply.
 */

let cached: { key: string; client: Anthropic } | null = null;

export function getAiClient(): { client: Anthropic; model: string } {
  const config = getAiConfig();
  if (!config) throw new AiError("not_configured");

  if (!cached || cached.key !== config.apiKey) {
    cached = {
      key: config.apiKey,
      client: new Anthropic({
        apiKey: config.apiKey,
        // SDK retries 408/409/429/5xx and connection errors with backoff.
        maxRetries: 2,
        timeout: 60_000,
      }),
    };
  }
  return { client: cached.client, model: config.model };
}

/**
 * Models that accept server-side refusal fallbacks. When a request on one of
 * them is declined by a safety classifier, the API retries it on a fallback
 * model inside the same call. Other models (set via WHITESPACE_AI_MODEL) run
 * without it.
 */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
]);

export function fallbackParams(
  model: string,
): { betas: ["server-side-fallback-2026-07-01"]; fallbacks: "default" } | Record<string, never> {
  if (!FALLBACK_MODELS.has(model)) return {};
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}
