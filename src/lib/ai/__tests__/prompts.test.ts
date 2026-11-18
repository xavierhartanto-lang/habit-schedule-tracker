import { describe, expect, it } from "vitest";

import { buildSystemPrompt, onboardingCoverage, toApiTurns, type PromptContext } from "../prompts";

const ctx: PromptContext = {
  profile: { displayName: "Maya", gradeLevel: 11, school: null, timezone: "America/Los_Angeles" },
  preferences: { dayStartTime: "07:00", dayEndTime: "22:30" },
  facts: [
    { category: "commitment", title: "School", area: "academics", detail: "Mon-Fri 08:00-15:00" },
    { category: "goal", title: "Make varsity", area: "athletics" },
  ],
  personalizationEnabled: true,
  today: { date: "2026-11-18", weekday: "Wednesday" },
};

describe("buildSystemPrompt", () => {
  it("includes known facts and open onboarding topics", () => {
    const [stable, user] = buildSystemPrompt("onboarding", ctx);
    expect(stable).toContain("Never invent");
    expect(stable).toContain("not a questionnaire");
    expect(user).toContain("School [academics]: Mon-Fri 08:00-15:00");
    expect(user).toContain("Make varsity");
    expect(user).toContain("Hobbies and interests");
    expect(user).not.toMatch(/nothing saved yet: [^\n]*School and fixed commitments/);
  });

  it("keeps the stable block identical across users (cacheable)", () => {
    const [a] = buildSystemPrompt("assistant", ctx);
    const [b] = buildSystemPrompt("assistant", { ...ctx, facts: [], profile: { ...ctx.profile, displayName: "Sam" } });
    expect(a).toBe(b);
  });

  it("hides saved facts when personalization is off", () => {
    const [, user] = buildSystemPrompt("assistant", { ...ctx, personalizationEnabled: false });
    expect(user).not.toContain("Make varsity");
    expect(user).toContain("turned off personalization");
  });
});

describe("onboardingCoverage", () => {
  it("marks topics covered by saved facts", () => {
    const coverage = onboardingCoverage(ctx.facts);
    expect(coverage.coveredCount).toBe(2);
    expect(coverage.complete).toBe(false);
    expect(coverage.topics.find((t) => t.id === "fixed")?.covered).toBe(true);
    expect(coverage.topics.find((t) => t.id === "activities")?.covered).toBe(false);
    expect(coverage.topics.find((t) => t.id === "goals")?.covered).toBe(true);
  });

  it("counts working times toward preferences", () => {
    const coverage = onboardingCoverage([{ category: "working_time", area: "academics" }]);
    expect(coverage.topics.find((t) => t.id === "preferences")?.covered).toBe(true);
  });
});

describe("toApiTurns", () => {
  it("starts with a user turn when the assistant spoke first", () => {
    const turns = toApiTurns([{ role: "assistant", content: "Hi! What does school look like?" }], "onboarding");
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
  });

  it("merges consecutive same-role turns and drops empty ones", () => {
    const turns = toApiTurns(
      [
        { role: "user", content: "hi" },
        { role: "user", content: "  " },
        { role: "user", content: "I play cello" },
        { role: "assistant", content: "Nice." },
      ],
      "assistant",
    );
    expect(turns).toEqual([
      { role: "user", content: "hi\n\nI play cello" },
      { role: "assistant", content: "Nice." },
    ]);
  });
});
