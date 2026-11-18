import "server-only";

/**
 * AI configuration. Server only.
 *
 * ANTHROPIC_API_KEY    required for any AI feature. Never prefix it with NEXT_PUBLIC_.
 * WHITESPACE_AI_MODEL  optional model override. Defaults to DEFAULT_AI_MODEL.
 *
 * When the key is missing the app must show a clear "AI not configured"
 * state. It must never fake a reply.
 */

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

export type AiConfig = {
  apiKey: string;
  model: string;
};

export type AiStatus =
  | { configured: true; model: string }
  | { configured: false; reason: "missing_api_key" };

export function getAiConfig(): AiConfig | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.WHITESPACE_AI_MODEL?.trim() || DEFAULT_AI_MODEL;
  return { apiKey, model };
}

export function isAiConfigured(): boolean {
  return getAiConfig() !== null;
}

/**
 * Safe to pass to client components: it never contains the key.
 */
export function getAiStatus(): AiStatus {
  const config = getAiConfig();
  if (!config) return { configured: false, reason: "missing_api_key" };
  return { configured: true, model: config.model };
}
