import { describe, expect, it } from "vitest";
import type { Commitment } from "@/lib/domain/types";
import { draftToCommitmentInput } from "../drafts";
import {
  commitmentToDraft,
  describeAttributes,
  describeCommitment,
  formatDays,
  formatTimeOfDay,
  fromZoned,
  toZoned,
  weeklyDaysFromRule,
  type CommitmentDraft,
} from "../format";

const TZ = "America/Los_Angeles";

describe("formatting", () => {
  it("formats times and day sets", () => {
    expect(formatTimeOfDay("16:30")).toBe("4:30 PM");
    expect(formatTimeOfDay("00:00")).toBe("12 AM");
    expect(formatDays(["mo", "tu", "we", "th", "fr"])).toBe("Weekdays");
    expect(formatDays(["sa", "su"])).toBe("Weekends");
    expect(formatDays(["we", "mo"])).toBe("Mon, Wed");
  });

  it("describes optional attributes and skips empty ones", () => {
    expect(describeAttributes({})).toBeNull();
    expect(describeAttributes({ days: ["mo", "we"], startTime: "06:00", endTime: "07:00" })).toBe(
      "Mon, Wed · 6 AM – 7 AM",
    );
    expect(describeAttributes({ timesPerWeek: 3, durationMinutes: 90 })).toBe("3× a week · 1 h 30 min");
  });
});

describe("time zones", () => {
  it("round-trips wall-clock time across DST", () => {
    const summer = fromZoned("2026-07-01", "16:00", TZ);
    expect(summer).toBe("2026-07-01T23:00:00.000Z");
    const winter = fromZoned("2026-12-01", "16:00", TZ);
    expect(winter).toBe("2026-12-02T00:00:00.000Z");
    expect(toZoned(winter, TZ)).toEqual({ dateKey: "2026-12-01", time: "16:00" });
  });
});

describe("commitments", () => {
  const weekly: Commitment = {
    id: "c1",
    title: "Swim practice",
    area: "athletics",
    kind: "fixed",
    startsAt: "2026-11-18T23:00:00.000Z",
    endsAt: "2026-11-19T01:00:00.000Z",
    recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE",
    source: "conversation",
  };

  it("reads weekly rules", () => {
    expect(weeklyDaysFromRule("FREQ=WEEKLY;BYDAY=MO,WE")).toEqual(["mo", "we"]);
    expect(weeklyDaysFromRule("FREQ=DAILY")).toBeNull();
    expect(weeklyDaysFromRule(null)).toBeNull();
  });

  it("shows a weekly commitment in the user's time zone", () => {
    expect(describeCommitment(weekly, TZ)).toBe("Mon, Wed · 3 PM – 5 PM");
  });

  it("keeps the original first occurrence when the schedule is unchanged", () => {
    const draft = { ...commitmentToDraft(weekly, TZ), title: "Swim" };
    const r = draftToCommitmentInput(draft, TZ, weekly);
    expect(r.ok && r.value).toMatchObject({
      title: "Swim",
      startsAt: weekly.startsAt,
      endsAt: weekly.endsAt,
      recurrenceRule: weekly.recurrenceRule,
    });
  });

  it("recomputes when the days change", () => {
    const draft: CommitmentDraft = { ...commitmentToDraft(weekly, TZ), days: ["tu", "th"] };
    const r = draftToCommitmentInput(draft, TZ, weekly, new Date("2026-11-18T12:00:00Z"));
    expect(r.ok && r.value.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU,TH");
    expect(r.ok && r.value.startsAt).toBe("2026-11-19T23:00:00.000Z");
  });

  it("asks instead of guessing when a fixed time is missing", () => {
    const draft: CommitmentDraft = { ...commitmentToDraft(weekly, TZ), days: [], date: "" };
    expect(draftToCommitmentInput(draft, TZ, weekly)).toEqual({
      ok: false,
      error: "Pick the days it repeats, or a date for a one-time event.",
    });
    expect(draftToCommitmentInput({ ...draft, startTime: "" }, TZ).ok).toBe(false);
  });

  it("builds one-time and flexible commitments", () => {
    const base = commitmentToDraft(weekly, TZ);
    const once = draftToCommitmentInput({ ...base, days: [], date: "2026-12-05" }, TZ);
    expect(once.ok && once.value).toMatchObject({
      startsAt: "2026-12-05T23:00:00.000Z",
      recurrenceRule: null,
    });
    const flex = draftToCommitmentInput(
      { ...base, kind: "flexible", estimatedMinutes: "120", dueDate: "2026-12-05" },
      TZ,
    );
    expect(flex.ok && flex.value).toMatchObject({ startsAt: null, estimatedMinutes: 120 });
    expect(draftToCommitmentInput({ ...base, kind: "flexible", estimatedMinutes: "1.5" }, TZ).ok).toBe(false);
  });
});
