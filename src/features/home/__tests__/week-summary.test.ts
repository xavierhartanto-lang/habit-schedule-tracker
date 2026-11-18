import { describe, expect, it } from "vitest";
import { summarizeWeek } from "../week-summary";

const days = ["2026-11-18", "2026-11-19", "2026-11-20"];

describe("summarizeWeek", () => {
  it("counts commitments, time, deadlines and the busiest day", () => {
    const s = summarizeWeek(
      days,
      [
        { dateKey: "2026-11-18", minutes: 60, kind: "fixed", allDay: false },
        { dateKey: "2026-11-19", minutes: 120, kind: "fixed", allDay: false },
        { dateKey: "2026-11-19", minutes: 45, kind: "flexible", allDay: false },
        { dateKey: "2026-11-25", minutes: 300, kind: "fixed", allDay: false }, // outside range
      ],
      [{ dateKey: "2026-11-20" }, { dateKey: "2026-12-01" }],
    );
    expect(s).toEqual({ commitments: 2, scheduledMinutes: 225, deadlines: 1, busiestDay: "2026-11-19", openDays: 1 });
  });

  it("doesn't count all-day events as scheduled time or call a light day busy", () => {
    const s = summarizeWeek(days, [{ dateKey: "2026-11-18", minutes: 1440, kind: "fixed", allDay: true }], []);
    expect(s.scheduledMinutes).toBe(0);
    expect(s.busiestDay).toBeNull();
    expect(s.commitments).toBe(1);
  });
});
