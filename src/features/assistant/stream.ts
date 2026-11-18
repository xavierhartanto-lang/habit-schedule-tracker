import type { ChatRequestBody, ChatStreamEvent, ClientAiError } from "./types";

/**
 * Client helper for POST /api/chat. Yields parsed NDJSON events.
 * A non-2xx response becomes a single "error" event, so callers handle
 * every failure in one place.
 */

const NETWORK_ERROR: ClientAiError = {
  code: "provider_unavailable",
  message: "Couldn't reach Whitespace. Check your connection and try again.",
  retryable: true,
};

export function parseNdjsonLines(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: ChatStreamEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ChatStreamEvent);
    } catch {
      // A malformed line is skipped rather than breaking the whole reply.
    }
  }
  return { events, rest };
}

/** Fields the Home screen may add. The server ignores what it doesn't support. */
type ChatRequestExtras = { opening?: string; checkIn?: "daily" | "weekly" };

export async function* streamChat(
  body: ChatRequestBody & ChatRequestExtras,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent | { type: "http_error"; status: number; error: ClientAiError }> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return;
    yield { type: "http_error", status: 0, error: NETWORK_ERROR };
    return;
  }

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as { error?: ClientAiError } | null;
    yield { type: "http_error", status: response.status, error: payload?.error ?? NETWORK_ERROR };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseNdjsonLines(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === "done") sawDone = true;
        yield event;
      }
    }
    const tail = parseNdjsonLines(`${buffer}\n`);
    for (const event of tail.events) {
      if (event.type === "done") sawDone = true;
      yield event;
    }
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return;
    yield { type: "error", error: NETWORK_ERROR };
    return;
  }
  if (!sawDone) yield { type: "error", error: NETWORK_ERROR };
}
