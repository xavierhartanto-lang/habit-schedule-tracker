import { describe, expect, it } from "vitest";

import type { ExtractedItem } from "@/lib/ai/extraction";
import { applyProposalEdit, describeSchedule, needsSchedule, proposalToWrite } from "../proposal-input";

const MSG = "6f1c2b8e-4a3d-4c1b-9e2f-1a2b3c4d5e6f";
// Monday 2026-11-16 12:00 UTC
const NOW = new Date("2026-11-16T12:00:00Z");

const practice: ExtractedItem = {
  category: "commitment",
  kind: "fixed",
  title: "Debate practice",
  area: "extracurricular",
  evidence: "debate practice Tuesdays and Thursdays 3:30 to 5",
  details: null,
  supersedes: null,
  location: "Room 204",
  schedule: { days: ["tue", "thu"], startTime: "15:30", endTime: "17:00" },
};

describe("proposalToWrite", () => {
  it("turns a fixed weekly commitment into a repeating commitment with provenance", () => {
    const result = proposalToWrite(practice, { timezone: "America/New_York", sourceMessageId: MSG, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.table).toBe("commitments");
    expect(result.write.input).toMatchObject({
      title: "Debate practice",
      kind: "fixed",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=TU,TH",
      // Tue Nov 17, 3:30 PM New York = 20:30 UTC
      startsAt: "2026-11-17T20:30:00.000Z",
      endsAt: "2026-11-17T22:00:00.000Z",
      location: "Room 204",
      source: "conversation",
      sourceMessageId: MSG,
    });
  });

  it("refuses a fixed commitment without times instead of guessing", () => {
    const item: ExtractedItem = { ...practice, schedule: { days: ["tue"], startTime: null, endTime: null } };
    expect(needsSchedule(item)).toBe(true);
    const result = proposalToWrite(item, { timezone: "UTC", sourceMessageId: MSG, now: NOW });
    expect(result).toEqual({ ok: false, error: "Add the days and times first." });
  });

  it("saves flexible commitments without times", () => {
    const item: ExtractedItem = { ...practice, kind: "flexible", schedule: null, title: "SAT prep" };
    const result = proposalToWrite(item, { timezone: "UTC", sourceMessageId: MSG });
    expect(result.ok && result.write.input).toMatchObject({ kind: "flexible", title: "SAT prep" });
    expect(result.ok && result.write.input.startsAt).toBeUndefined();
  });

  it("maps routines to context items with two-letter days", () => {
    const item: ExtractedItem = {
      category: "routine",
      title: "Morning run",
      area: "athletics",
      evidence: "I run before school on weekdays at 6",
      details: null,
      supersedes: null,
      schedule: { days: ["mon", "wed", "fri"], startTime: "06:00", endTime: null },
    };
    const result = proposalToWrite(item, { timezone: "UTC", sourceMessageId: MSG });
    expect(result.ok && result.write).toEqual({
      table: "context_items",
      input: {
        category: "routine",
        title: "Morning run",
        details: null,
        area: "athletics",
        attributes: { days: ["mo", "we", "fr"], startTime: "06:00" },
        source: "conversation",
        sourceMessageId: MSG,
      },
    });
  });

  it("maps goals with horizon and date", () => {
    const item: ExtractedItem = {
      category: "goal",
      title: "Make varsity",
      area: "athletics",
      evidence: "I want to make varsity next year",
      details: null,
      supersedes: null,
      horizon: "long_term",
      targetDate: null,
    };
    const result = proposalToWrite(item, { timezone: "UTC", sourceMessageId: MSG });
    expect(result.ok && result.write).toMatchObject({ table: "goals", input: { horizon: "long_term", source: "conversation" } });
  });
});

describe("applyProposalEdit", () => {
  it("fills in missing times so the commitment can be saved", () => {
    const item: ExtractedItem = { ...practice, schedule: null };
    const edited = applyProposalEdit(item, { days: ["mon", "wed"], startTime: "16:00", endTime: "18:00" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(needsSchedule(edited.item)).toBe(false);
    expect(edited.item.evidence).toBe(practice.evidence);
  });

  it("rejects bad edits", () => {
    expect(applyProposalEdit(practice, { title: "   " })).toEqual({ ok: false, error: "Add a name." });
    expect(applyProposalEdit(practice, { startTime: "18:00", endTime: "17:00" }).ok).toBe(false);
    expect(applyProposalEdit(practice, { startTime: "25:00" }).ok).toBe(false);
    expect(applyProposalEdit(practice, { area: "space" as never }).ok).toBe(false);
  });

  it("switching to flexible keeps the item saveable", () => {
    const item: ExtractedItem = { ...practice, schedule: null };
    const edited = applyProposalEdit(item, { kind: "flexible" });
    expect(edited.ok && needsSchedule(edited.item)).toBe(false);
  });

  it("validates goal dates", () => {
    const goal: ExtractedItem = {
      category: "goal",
      title: "Finish college essays",
      area: "academics",
      evidence: "finish my essays",
      details: null,
      supersedes: null,
      horizon: null,
      targetDate: null,
    };
    expect(applyProposalEdit(goal, { targetDate: "2027-02-30" }).ok).toBe(false);
    const ok = applyProposalEdit(goal, { targetDate: "2027-01-01", horizon: "short_term" });
    expect(ok.ok && ok.item).toMatchObject({ targetDate: "2027-01-01", horizon: "short_term" });
  });
});

describe("describeSchedule", () => {
  it("reads naturally", () => {
    expect(describeSchedule(practice.category === "commitment" ? practice.schedule : null)).toBe(
      "Tue, Thu · 3:30 PM to 5 PM",
    );
    expect(describeSchedule({ days: ["mon", "tue", "wed", "thu", "fri"], startTime: "08:00", endTime: null })).toBe(
      "Weekdays · from 8 AM",
    );
    expect(describeSchedule(null)).toBe("");
  });
});
