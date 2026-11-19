import { describe, expect, it } from "vitest";
import {
  bellScheduleSchema,
  defaultBellSchedule,
  deriveQuick,
  generatePeriods,
  matchesQuick,
  summarizeBellSchedule,
  toSchoolBlocks,
  type BellSchedule,
} from "../school-schedule";

describe("generatePeriods", () => {
  it("builds classes, passing time and lunch in order", () => {
    const p = generatePeriods({ firstBell: "08:00", classes: 4, classMinutes: 50, passingMinutes: 10, lunchAfter: 2, lunchMinutes: 30 });
    expect(p.map((x) => `${x.label} ${x.start}-${x.end}`)).toEqual([
      "Period 1 08:00-08:50",
      "Period 2 09:00-09:50",
      "Lunch 10:00-10:30",
      "Period 3 10:40-11:30",
      "Period 4 11:40-12:30",
    ]);
  });

  it("round-trips through deriveQuick", () => {
    const q = { firstBell: "07:45", classes: 7, classMinutes: 48, passingMinutes: 6, lunchAfter: 4, lunchMinutes: 30 };
    const periods = generatePeriods(q);
    expect(deriveQuick(periods)).toEqual(q);
    expect(matchesQuick(periods, q)).toBe(true);
  });
});

describe("bellScheduleSchema", () => {
  it("accepts the default", () => {
    expect(bellScheduleSchema.safeParse(defaultBellSchedule()).success).toBe(true);
  });

  it("rejects a weekday in two day types", () => {
    const s = defaultBellSchedule();
    s.dayTypes.push({ ...s.dayTypes[0], id: "late", label: "Late start", days: ["we"] });
    const r = bellScheduleSchema.safeParse(s);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/Wednesday/);
  });

  it("rejects overlapping periods", () => {
    const s = defaultBellSchedule();
    s.dayTypes[0].periods = [
      { label: "A", start: "08:00", end: "09:00", kind: "class" },
      { label: "B", start: "08:30", end: "09:30", kind: "class" },
    ];
    expect(bellScheduleSchema.safeParse(s).success).toBe(false);
  });
});

describe("toSchoolBlocks", () => {
  const schedule: BellSchedule = {
    rotation: "ab",
    source: "manual",
    sourceUrls: [],
    dayTypes: [
      { id: "regular", label: "Regular day", days: ["mo", "tu", "th", "fr"], periods: generatePeriods({ firstBell: "08:00", classes: 6, classMinutes: 55, passingMinutes: 5, lunchAfter: 3, lunchMinutes: 35 }) },
      { id: "late", label: "Late start", days: ["we"], periods: generatePeriods({ firstBell: "09:30", classes: 6, classMinutes: 40, passingMinutes: 5, lunchAfter: 3, lunchMinutes: 30 }) },
    ],
  };

  it("makes one weekly block per day type, first bell to last bell", () => {
    const now = new Date("2026-11-19T12:00:00Z"); // Thu
    const r = toSchoolBlocks(schedule, "America/Los_Angeles", now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].title).toBe("School · Regular day");
    expect(r.blocks[0].recurrence_rule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,TH,FR");
    expect(r.blocks[1].recurrence_rule).toBe("FREQ=WEEKLY;BYDAY=WE");
    // 09:30 PST = 17:30 UTC on Wed 2026-11-25
    expect(r.blocks[1].starts_at).toBe("2026-11-25T17:30:00.000Z");
    expect(r.blocks[0].notes).toMatch(/A\/B rotation/);
    expect(r.blocks[0].timezone).toBe("America/Los_Angeles");
  });

  it("uses a plain title with one day type", () => {
    const r = toSchoolBlocks(defaultBellSchedule(), "UTC", new Date("2026-11-19T12:00:00Z"));
    expect(r.ok && r.blocks[0].title).toBe("School");
  });

  it("summarizes", () => {
    expect(summarizeBellSchedule(schedule)[0]).toBe("Regular day (Mon, Tue, Thu, Fri): 8:00 AM–2:35 PM, 6 classes");
  });
});
