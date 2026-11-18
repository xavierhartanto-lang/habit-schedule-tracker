import { describe, expect, it } from "vitest";

import { NOW, PREFS, TZ, event, task, weekCalendar } from "@/lib/assistant/__tests__/fixtures";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import { buildCheckIn } from "../server/checkin-build";

describe("check-ins use real data only", () => {
  it("daily: today's events, near deadlines, free time and starters from the data", () => {
    const exam = task({ title: "Chemistry exam prep", dueAt: zonedToUtc("2026-11-19", "23:59", TZ).toISOString(), priority: "high", estimatedMinutes: 120 });
    const later = task({ title: "Essay", dueAt: zonedToUtc("2026-12-10", "23:59", TZ).toISOString() });
    const c = buildCheckIn({
      kind: "daily",
      now: NOW,
      timeZone: TZ,
      from: "2026-11-18",
      to: "2026-11-18",
      events: [...weekCalendar(), event({ title: "Dentist", date: "2026-11-18", start: "17:00", end: "18:00" })],
      openTasks: [exam, later],
      habits: [],
      preferences: PREFS,
    });
    expect(c.events.map((e) => e.title)).toEqual(["School", "Dentist"]);
    expect(c.deadlines.map((d) => d.title)).toEqual(["Chemistry exam prep"]);
    expect(c.unscheduledTasks.map((t) => t.title)).toEqual(["Chemistry exam prep"]);
    expect(c.freeMinutes).toBeGreaterThan(0);
    expect(c.starters[0]).toBe("Help me plan time for Chemistry exam prep");
  });

  it("weekly: recurring commitments are summarized; an empty week stays empty", () => {
    const week = buildCheckIn({ kind: "weekly", now: NOW, timeZone: TZ, from: "2026-11-18", to: "2026-11-22", events: weekCalendar(), openTasks: [], habits: [], preferences: PREFS });
    expect(week.recurring.map((r) => r.title)).toEqual(["School", "Volleyball"]);
    expect(week.recurring[1].when).toContain("Thu");

    const empty = buildCheckIn({ kind: "weekly", now: NOW, timeZone: TZ, from: "2026-11-18", to: "2026-11-22", events: [], openTasks: [], habits: [], preferences: PREFS });
    expect(empty.events).toEqual([]);
    expect(empty.deadlines).toEqual([]);
    expect(empty.recurring).toEqual([]);
  });
});
