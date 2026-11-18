import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiError, toAiError } from "../errors";
import type { ExtractionWire } from "../extraction";
import type { PromptContext } from "../prompts";

// Mock the provider client: no network in tests.
const parse = vi.fn();
const stream = vi.fn();
vi.mock("../client", () => ({
  getAiClient: () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new AiError("not_configured");
    return { client: { beta: { messages: { parse, stream } } }, model: "claude-opus-5-5" };
  },
  fallbackParams: () => ({}),
}));

const { extractFacts, streamReply } = await import("../service");
const { getAiStatus, isAiConfigured, DEFAULT_AI_MODEL } = await import("../config");

const today = { date: "2026-11-18", weekday: "Wednesday" };
const ctx: PromptContext = {
  profile: { displayName: null, gradeLevel: null, school: null, timezone: "UTC" },
  facts: [],
  personalizationEnabled: true,
  today,
};

function fakeStream(deltas: string[], stopReason: string = "end_turn", failAfter?: number) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const [i, text] of deltas.entries()) {
        if (failAfter !== undefined && i === failAfter) {
          throw Anthropic.APIError.generate(529, { type: "overloaded_error" }, "Overloaded", new Headers());
        }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
      }
    },
    finalMessage: async () => ({ stop_reason: stopReason, model: "claude-opus-5-5", content: [] }),
  };
}

async function collect(gen: AsyncGenerator<string, unknown, void>) {
  const chunks: string[] = [];
  let result = await gen.next();
  while (!result.done) {
    chunks.push(result.value);
    result = await gen.next();
  }
  return { chunks, final: result.value };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  parse.mockReset();
  stream.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("configuration", () => {
  it("reports not configured without a key and never exposes the key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(isAiConfigured()).toBe(false);
    expect(getAiStatus()).toEqual({ configured: false, reason: "missing_api_key" });
  });

  it("uses the default model unless overridden", () => {
    expect(getAiStatus()).toEqual({ configured: true, model: DEFAULT_AI_MODEL });
    vi.stubEnv("WHITESPACE_AI_MODEL", "claude-sonnet-5-5");
    expect(getAiStatus()).toEqual({ configured: true, model: "claude-sonnet-5-5" });
    expect(JSON.stringify(getAiStatus())).not.toContain("test-key");
  });

  it("fails with not_configured instead of faking a reply", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(collect(streamReply({ mode: "onboarding", context: ctx, history: [] }))).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(extractFacts({ userMessage: "I swim", history: [], known: [], today })).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(stream).not.toHaveBeenCalled();
  });
});

describe("streamReply", () => {
  it("streams text and starts with a user turn", async () => {
    stream.mockReturnValue(fakeStream(["Hi. ", "What does school look like?"]));
    const { chunks, final } = await collect(streamReply({ mode: "onboarding", context: ctx, history: [] }));
    expect(chunks.join("")).toBe("Hi. What does school look like?");
    expect(final).toEqual({ text: "Hi. What does school look like?", model: "claude-opus-5-5" });
    const params = stream.mock.calls[0][0];
    expect(params.messages[0].role).toBe("user");
    expect(params.system).toHaveLength(2);
  });

  it("maps refusals and mid-stream provider failures to typed errors", async () => {
    stream.mockReturnValue(fakeStream(["Sorry"], "refusal"));
    await expect(collect(streamReply({ mode: "assistant", context: ctx, history: [] }))).rejects.toMatchObject({
      code: "refused",
    });

    stream.mockReturnValue(fakeStream(["a", "b"], "end_turn", 1));
    await expect(collect(streamReply({ mode: "assistant", context: ctx, history: [] }))).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("treats an empty reply as invalid output", async () => {
    stream.mockReturnValue(fakeStream([]));
    await expect(collect(streamReply({ mode: "assistant", context: ctx, history: [] }))).rejects.toMatchObject({
      code: "invalid_output",
    });
  });
});

describe("extractFacts", () => {
  const userMessage = "I swim every Monday and Wednesday from 6 to 7:30 in the morning.";
  const output: ExtractionWire = {
    items: [
      {
        category: "commitment",
        title: "Swim practice",
        area: "athletics",
        evidence: "I swim every Monday and Wednesday from 6 to 7:30 in the morning",
        details: null,
        schedule: { days: ["mon", "wed"], start_time: "06:00", end_time: "07:30" },
        commitment_kind: "fixed",
        location: null,
        goal_horizon: null,
        target_date: null,
        supersedes: null,
      },
      {
        category: "goal",
        title: "Qualify for state",
        area: "athletics",
        evidence: "I want to qualify for state",
        details: null,
        schedule: null,
        commitment_kind: null,
        location: null,
        goal_horizon: "long_term",
        target_date: null,
        supersedes: null,
      },
    ],
    clarifications: [],
  };

  it("returns validated items and drops what the user did not say", async () => {
    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: output });
    const result = await extractFacts({ userMessage, history: [], known: [], today });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: "Swim practice", kind: "fixed" });
    expect(result.dropped).toEqual([{ title: "Qualify for state", reason: "ungrounded" }]);
  });

  it("skips the call for trivial messages", async () => {
    const result = await extractFacts({ userMessage: "ok", history: [], known: [], today });
    expect(result.items).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("maps unusable output to invalid_output", async () => {
    parse.mockResolvedValue({ stop_reason: "max_tokens", parsed_output: null });
    await expect(extractFacts({ userMessage, history: [], known: [], today })).rejects.toMatchObject({
      code: "invalid_output",
    });

    parse.mockRejectedValue(new Anthropic.AnthropicError("Failed to parse structured output: bad"));
    await expect(extractFacts({ userMessage, history: [], known: [], today })).rejects.toMatchObject({
      code: "invalid_output",
    });

    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { items: [{ nope: true }] } });
    await expect(extractFacts({ userMessage, history: [], known: [], today })).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("maps provider errors", async () => {
    parse.mockRejectedValue(Anthropic.APIError.generate(429, {}, "slow down", new Headers()));
    await expect(extractFacts({ userMessage, history: [], known: [], today })).rejects.toMatchObject({
      code: "rate_limited",
    });
    parse.mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    await expect(extractFacts({ userMessage, history: [], known: [], today })).rejects.toMatchObject({
      code: "refused",
    });
  });
});

describe("toAiError", () => {
  it("maps SDK errors to codes with safe messages", () => {
    const cases: [unknown, string][] = [
      [Anthropic.APIError.generate(401, {}, "bad key", new Headers()), "auth_failed"],
      [Anthropic.APIError.generate(404, {}, "no model", new Headers()), "bad_request"],
      [Anthropic.APIError.generate(500, {}, "boom", new Headers()), "provider_unavailable"],
      [new Anthropic.APIConnectionError({ message: "down" }), "provider_unavailable"],
      [new Anthropic.APIUserAbortError(), "aborted"],
      [new Error("weird"), "unknown"],
    ];
    for (const [error, code] of cases) {
      const mapped = toAiError(error);
      expect(mapped.code).toBe(code);
      expect(JSON.stringify(mapped)).not.toMatch(/bad key|no model|boom|weird/);
    }
  });
});
