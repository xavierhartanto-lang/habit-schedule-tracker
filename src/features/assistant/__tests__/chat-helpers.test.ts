import { describe, expect, it } from "vitest";

import { parseBlocks } from "../rich-text";
import { parseNdjsonLines } from "../stream";
import { readUserMessageMeta, toChatMessage } from "../types";

describe("parseNdjsonLines", () => {
  it("parses complete lines and keeps the partial tail", () => {
    const { events, rest } = parseNdjsonLines('{"type":"delta","text":"Hi"}\n{"type":"done"}\n{"type":"del');
    expect(events).toEqual([{ type: "delta", text: "Hi" }, { type: "done" }]);
    expect(rest).toBe('{"type":"del');
  });

  it("skips malformed lines", () => {
    expect(parseNdjsonLines('not json\n{"type":"done"}\n').events).toEqual([{ type: "done" }]);
  });
});

describe("parseBlocks", () => {
  it("splits paragraphs and lists", () => {
    expect(parseBlocks("Here is a plan:\n\n- Mon: chem\n- Tue: essay\n\n1. First\n2. Second\nDone.")).toEqual([
      { type: "p", text: "Here is a plan:" },
      { type: "ul", items: ["Mon: chem", "Tue: essay"] },
      { type: "ol", items: ["First", "Second"] },
      { type: "p", text: "Done." },
    ]);
  });
});

describe("readUserMessageMeta", () => {
  it("ignores malformed stored proposals", () => {
    const meta = readUserMessageMeta({
      proposals: [
        { id: "a", status: "pending", item: { title: "Debate", category: "activity" } },
        { id: "b", status: "weird", item: { title: "X", category: "goal" } },
        "junk",
      ],
      clarifications: [{ question: "Which days?", about: "Debate" }, { nope: true }],
      extractionError: "rate_limited",
    });
    expect(meta.proposals.map((p) => p.id)).toEqual(["a"]);
    expect(meta.clarifications).toHaveLength(1);
    expect(meta.extractionError).toBe("rate_limited");
  });

  it("only reads proposals from user messages", () => {
    const msg = toChatMessage({
      id: "m1",
      conversationId: "c1",
      role: "assistant",
      content: "Hello",
      metadata: { proposals: [{ id: "a", status: "pending", item: { title: "x", category: "goal" } }] },
      createdAt: "2026-11-18T00:00:00Z",
    });
    expect(msg.proposals).toEqual([]);
  });
});
