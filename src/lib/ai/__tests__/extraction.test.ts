import { describe, expect, it } from "vitest";

import {
  isGrounded,
  looksLikeTaskTitle,
  isValidIsoDate,
  scheduleToRRule,
  validateExtraction,
  type ExtractionWire,
  type WireItem,
} from "../extraction";

function wireItem(overrides: Partial<WireItem> = {}): WireItem {
  return {
    category: "commitment",
    title: "Debate practice",
    area: "extracurricular",
    evidence: "debate practice on Tuesdays and Thursdays from 3:30 to 5",
    details: null,
    schedule: { days: ["tue", "thu"], start_time: "15:30", end_time: "17:00" },
    commitment_kind: "fixed",
    location: null,
    goal_horizon: null,
    target_date: null,
    supersedes: null,
    ...overrides,
  };
}

function wire(items: WireItem[], clarifications: ExtractionWire["clarifications"] = []): ExtractionWire {
  return { items, clarifications };
}

const USER_TEXT =
  "I have debate practice on Tuesdays and Thursdays from 3:30 to 5. I also really like drawing, and I want to get a 1500 on the SAT by March.";

describe("isGrounded", () => {
  it("accepts verbatim quotes regardless of case, punctuation and spacing", () => {
    expect(isGrounded("Debate practice on  Tuesdays", USER_TEXT)).toBe(true);
    expect(isGrounded("“really like drawing”", USER_TEXT)).toBe(true);
  });

  it("rejects text the user never wrote", () => {
    expect(isGrounded("soccer on Mondays", USER_TEXT)).toBe(false);
    expect(isGrounded("ab", USER_TEXT)).toBe(false);
  });
});

describe("validateExtraction", () => {
  it("returns typed items for grounded, valid output", () => {
    const result = validateExtraction(
      wire([
        wireItem(),
        wireItem({
          category: "interest",
          title: "Drawing",
          area: "creative",
          evidence: "I also really like drawing",
          schedule: null,
          commitment_kind: null,
        }),
        wireItem({
          category: "goal",
          title: "Score 1500 on the SAT",
          area: "academics",
          evidence: "get a 1500 on the SAT by March",
          schedule: null,
          commitment_kind: null,
          goal_horizon: "short_term",
          target_date: null,
        }),
      ]),
      { userText: USER_TEXT, known: [] },
    );

    expect(result.dropped).toEqual([]);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      category: "commitment",
      kind: "fixed",
      schedule: { days: ["tue", "thu"], startTime: "15:30", endTime: "17:00" },
    });
    expect(result.items[1]).toMatchObject({ category: "interest", title: "Drawing", schedule: null });
    expect(result.items[2]).toMatchObject({ category: "goal", horizon: "short_term", targetDate: null });
  });

  it("drops fabricated items whose evidence is not in the user's words", () => {
    const result = validateExtraction(
      wire([wireItem({ title: "Soccer", evidence: "soccer every Monday" })]),
      { userText: USER_TEXT, known: [] },
    );
    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([{ title: "Soccer", reason: "ungrounded" }]);
  });

  it("drops malformed times and impossible ranges instead of guessing", () => {
    const bad = validateExtraction(
      wire([
        wireItem({ schedule: { days: ["tue"], start_time: "3:30pm", end_time: null } }),
        wireItem({ title: "Other", schedule: { days: ["tue"], start_time: "17:00", end_time: "15:30" } }),
      ]),
      { userText: USER_TEXT, known: [] },
    );
    expect(bad.items).toEqual([]);
    expect(bad.dropped.map((d) => d.reason)).toEqual(["invalid", "invalid"]);
  });

  it("drops impossible dates", () => {
    expect(isValidIsoDate("2027-02-30")).toBe(false);
    expect(isValidIsoDate("2027-03-01")).toBe(true);
    const result = validateExtraction(
      wire([
        wireItem({
          category: "goal",
          title: "SAT",
          evidence: "1500 on the SAT",
          schedule: null,
          target_date: "2027-02-30",
        }),
      ]),
      { userText: USER_TEXT, known: [] },
    );
    expect(result.items).toEqual([]);
    expect(result.dropped[0].reason).toBe("invalid");
  });

  it("keeps unknown times as null and dedupes days into canonical order", () => {
    const result = validateExtraction(
      wire([wireItem({ schedule: { days: ["thu", "tue", "thu"], start_time: null, end_time: null } })]),
      { userText: USER_TEXT, known: [] },
    );
    expect(result.items[0]).toMatchObject({
      kind: "fixed",
      schedule: { days: ["tue", "thu"], startTime: null, endTime: null },
    });
  });

  it("defaults commitment kind from timing when the model omits it", () => {
    const result = validateExtraction(
      wire([wireItem({ commitment_kind: null, schedule: null })]),
      { userText: USER_TEXT, known: [] },
    );
    expect(result.items[0]).toMatchObject({ kind: "flexible", schedule: null });
  });

  it("skips facts already known and repeats within a batch", () => {
    const result = validateExtraction(wire([wireItem(), wireItem({ title: "debate  practice" })]), {
      userText: USER_TEXT,
      known: [{ category: "commitment", title: "Debate Practice" }],
    });
    expect(result.items).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["duplicate", "duplicate"]);
  });

  it("allows an update to a known fact via supersedes", () => {
    const result = validateExtraction(wire([wireItem({ supersedes: "Debate practice" })]), {
      userText: USER_TEXT,
      known: [{ category: "commitment", title: "Debate practice" }],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].supersedes).toBe("Debate practice");
  });

  it("clears supersedes that does not name a known fact", () => {
    const result = validateExtraction(wire([wireItem({ supersedes: "Made-up thing" })]), {
      userText: USER_TEXT,
      known: [],
    });
    expect(result.items[0].supersedes).toBeNull();
  });

  it("keeps clarifying questions, capped", () => {
    const q = { question: "What time does robotics meet?", about: "Robotics" };
    const result = validateExtraction(wire([], [q, q, q, q, { question: "  ", about: "x" }]), {
      userText: USER_TEXT,
      known: [],
    });
    expect(result.clarifications).toHaveLength(3);
    expect(result.clarifications[0]).toEqual(q);
  });

  it("throws on output that is not the expected shape", () => {
    expect(() => validateExtraction({ items: "nope" }, { userText: USER_TEXT, known: [] })).toThrow();
    expect(() =>
      validateExtraction(wire([wireItem({ area: "sports" as never })]), { userText: USER_TEXT, known: [] }),
    ).toThrow();
  });
});

describe("scheduleToRRule", () => {
  it("builds a weekly rule", () => {
    expect(scheduleToRRule({ days: ["mon", "wed"], startTime: "15:30", endTime: null })).toBe(
      "FREQ=WEEKLY;BYDAY=MO,WE",
    );
    expect(scheduleToRRule({ days: [], startTime: "15:30", endTime: null })).toBeNull();
    expect(scheduleToRRule(null)).toBeNull();
  });
});

describe("memory hygiene: to-dos never become facts", () => {
  const text = "I have a history essay outline due Friday, chem homework, and I study for my bio test with flashcards. Debate practice on Tuesdays and Thursdays from 3:30 to 5. I do homework right after school.";
  it("drops task-like items but keeps pillars and working times", () => {
    const result = validateExtraction(
      wire([
        wireItem({ title: "History Essay Outline", evidence: "history essay outline due Friday", commitment_kind: "flexible", schedule: null }),
        wireItem({ category: "goal", title: "Chemistry Homework", evidence: "chem homework", schedule: null, commitment_kind: null, goal_horizon: "short_term" }),
        wireItem({ category: "activity", title: "Study for Bio Test", evidence: "study for my bio test", schedule: null, commitment_kind: null }),
        wireItem({ evidence: "Debate practice on Tuesdays and Thursdays from 3:30 to 5" }),
        wireItem({ category: "working_time", title: "Homework right after school", evidence: "I do homework right after school", schedule: null, commitment_kind: null }),
      ]),
      { userText: text, known: [] },
    );
    expect(result.items.map((i) => i.title)).toEqual(["Debate practice", "Homework right after school"]);
    expect(result.dropped.filter((d) => d.reason === "task").map((d) => d.title)).toEqual([
      "History Essay Outline",
      "Chemistry Homework",
      "Study for Bio Test",
    ]);
  });

  it("never flags real classes or activities", () => {
    for (const title of ["AP Chemistry", "Debate", "Model UN", "Varsity Tennis", "Math Tutoring", "SAT Prep", "Robotics Club"]) {
      expect(looksLikeTaskTitle(title)).toBe(false);
    }
  });
});
