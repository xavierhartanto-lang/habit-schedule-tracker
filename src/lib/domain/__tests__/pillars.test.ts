import { describe, expect, it } from "vitest";

import { isPillarCommitment } from "../commitments";

const at = "2026-11-24T20:00:00.000Z";

describe("isPillarCommitment (what belongs in \"What Whitespace knows\")", () => {
  it("keeps the structure of the week", () => {
    expect(isPillarCommitment({ kind: "fixed", startsAt: at, recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE" })).toBe(true);
    // A recurring commitment added through chat keeps its plan link and still counts.
    expect(isPillarCommitment({ kind: "fixed", startsAt: at, recurrenceRule: "FREQ=WEEKLY;BYDAY=TU", planItemId: "p" })).toBe(true);
    // A standing weekly time budget ("5 hours of SAT prep a week").
    expect(isPillarCommitment({ kind: "flexible", startsAt: null, dueAt: null })).toBe(true);
  });

  it("leaves out tasks, essay steps, AI-scheduled items and one-offs", () => {
    expect(isPillarCommitment({ kind: "flexible", startsAt: at, taskId: "t", planItemId: "p" })).toBe(false); // essay step session
    expect(isPillarCommitment({ kind: "fixed", startsAt: at, planItemId: "p" })).toBe(false); // AI-scheduled one-off
    expect(isPillarCommitment({ kind: "fixed", startsAt: at, recurrenceRule: null })).toBe(false); // dentist on Thursday
    expect(isPillarCommitment({ kind: "flexible", startsAt: null, dueAt: at })).toBe(false); // a to-do with a due date
  });
});
