import { describe, expect, it } from "vitest";
import { buildOpening, partOfDay, pickFocus, whenPhrase, type OpeningDeadline, type OpeningInput } from "../opening";

const base: OpeningInput = {
  firstName: "Maya",
  hour: 9,
  isoWeekday: 3, // Wednesday
  remainingToday: [],
  deadlines: [],
  empty: false,
};

const d = (over: Partial<OpeningDeadline>): OpeningDeadline => ({
  title: "Essay",
  kind: "task",
  days: 2,
  weekday: "Friday",
  date: "Nov 27",
  priority: "medium",
  ...over,
});

describe("partOfDay", () => {
  it("covers the day", () => {
    expect(partOfDay(3)).toBe("Late night");
    expect(partOfDay(8)).toBe("Good morning");
    expect(partOfDay(13)).toBe("Good afternoon");
    expect(partOfDay(20)).toBe("Good evening");
  });
});

describe("whenPhrase", () => {
  it("uses relative words close by and dates further out", () => {
    expect(whenPhrase(d({ days: 0 }))).toBe("today");
    expect(whenPhrase(d({ days: 1 }))).toBe("tomorrow");
    expect(whenPhrase(d({ days: 3 }))).toBe("on Friday");
    expect(whenPhrase(d({ days: 9 }))).toBe("on Friday, Nov 27");
  });
});

describe("buildOpening", () => {
  it("greets by first name", () => {
    expect(buildOpening(base).greeting).toBe("Good morning, Maya");
    expect(buildOpening({ ...base, firstName: null }).greeting).toBe("Good morning");
  });

  it("asks about the week on an empty calendar instead of inventing anything", () => {
    const o = buildOpening({ ...base, empty: true });
    expect(o.message).toMatch(/^Blank calendar\./);
    expect(o.starters.length).toBeGreaterThan(0);
  });

  it("offers study time for an upcoming exam, by name", () => {
    const o = buildOpening({
      ...base,
      deadlines: [d({ title: "Chemistry exam", kind: "event", days: 9, priority: undefined })],
    });
    expect(o.message).toBe("Chemistry exam is on Friday, Nov 27. Want me to plan study time?");
    expect(o.starters[0].prompt).toContain("Chemistry exam");
  });

  it("raises overdue tasks first", () => {
    const o = buildOpening({
      ...base,
      deadlines: [d({ title: "Bio quiz", days: 1 }), d({ title: "Lab report", days: -2 })],
    });
    expect(o.message).toContain("“Lab report” was due 2 days ago");
  });

  it("ignores routine events and far-off low-stakes tasks", () => {
    const o = buildOpening({
      ...base,
      deadlines: [d({ title: "Dentist", kind: "event", days: 1 }), d({ title: "Return book", days: 6, priority: "low" })],
      remainingToday: [{ title: "Volleyball", start: "", end: "", allDay: false, time: "6 PM" }],
    });
    expect(o.message).toBe("Next up: “Volleyball” at 6 PM. What else needs doing today?");
  });

  it("mentions high-priority tasks due soon", () => {
    const o = buildOpening({ ...base, deadlines: [d({ title: "College essay", days: 2, priority: "high" })] });
    expect(o.message).toBe("“College essay” is due on Friday. Want me to block out time?");
  });

  it("opens the week on Monday mornings", () => {
    const o = buildOpening({ ...base, isoWeekday: 1 });
    expect(o.message).toBe("New week. What's the big thing coming up?");
    expect(o.starters[0].checkIn).toBe("weekly");
  });

  it("looks ahead to tomorrow in the evening", () => {
    const o = buildOpening({ ...base, hour: 20 });
    expect(o.message).toMatch(/head start on tomorrow/);
    expect(o.starters.find((s) => s.checkIn === "daily")?.label).toBe("Plan tomorrow");
  });

  it("always offers both check-ins", () => {
    const o = buildOpening(base);
    expect(o.starters.map((s) => s.checkIn).filter(Boolean).sort()).toEqual(["daily", "weekly"]);
    expect(o.starters.length).toBeLessThanOrEqual(4);
  });
});

describe("pickFocus", () => {
  it("returns null when nothing is worth raising", () => {
    expect(pickFocus([])).toBeNull();
    expect(pickFocus([d({ days: 10, priority: "medium" })])).toBeNull();
  });
});
