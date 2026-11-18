import Anthropic from "@anthropic-ai/sdk";

/**
 * Every AI failure the app can show is one of these codes.
 * `userMessage` is safe to show in the UI. `cause` stays on the server.
 */
export type AiErrorCode =
  | "not_configured" // ANTHROPIC_API_KEY missing
  | "auth_failed" // key present but rejected (401/403)
  | "rate_limited" // 429
  | "provider_unavailable" // 5xx, overloaded, network, timeout
  | "invalid_output" // model returned something that failed validation
  | "refused" // model declined (stop_reason "refusal")
  | "bad_request" // 400 / 404 / 413 / 422: usually a bad model id or oversized input
  | "aborted" // caller cancelled the request
  | "unknown";

const USER_MESSAGES: Record<AiErrorCode, string> = {
  not_configured:
    "The assistant isn't set up yet. Add an Anthropic API key on the server to turn it on.",
  auth_failed:
    "The assistant's API key was rejected. Check ANTHROPIC_API_KEY on the server.",
  rate_limited: "The assistant is busy right now. Try again in a minute.",
  provider_unavailable:
    "The assistant couldn't be reached. Your message is saved, so try again shortly.",
  invalid_output:
    "The assistant gave an answer Whitespace couldn't use. Nothing was saved. Try rephrasing.",
  refused: "The assistant can't help with that request.",
  bad_request:
    "The assistant couldn't process that request. Check the AI model setting or shorten the message.",
  aborted: "The request was cancelled.",
  unknown: "Something went wrong with the assistant. Try again.",
};

const RETRYABLE: ReadonlySet<AiErrorCode> = new Set([
  "rate_limited",
  "provider_unavailable",
  "invalid_output",
]);

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly userMessage: string;

  constructor(code: AiErrorCode, options?: { message?: string; cause?: unknown }) {
    super(options?.message ?? USER_MESSAGES[code], { cause: options?.cause });
    this.name = "AiError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.userMessage = USER_MESSAGES[code];
  }

  /** Plain object safe to send to the browser. Never includes the cause. */
  toJSON(): { code: AiErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.userMessage, retryable: this.retryable };
  }
}

/**
 * Map anything thrown by the SDK (or our own code) to an AiError.
 * Most specific class first: every SDK error extends APIError.
 */
export function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  if (error instanceof Anthropic.APIUserAbortError) {
    return new AiError("aborted", { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    // Includes APIConnectionTimeoutError.
    return new AiError("provider_unavailable", { cause: error });
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiError("auth_failed", { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError("rate_limited", { cause: error });
  }
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.ContentTooLargeError ||
    error instanceof Anthropic.UnprocessableEntityError
  ) {
    return new AiError("bad_request", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    if (status === 408 || status >= 500) {
      return new AiError("provider_unavailable", { cause: error });
    }
    return new AiError("unknown", { cause: error });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AiError("aborted", { cause: error });
  }
  return new AiError("unknown", { cause: error });
}
