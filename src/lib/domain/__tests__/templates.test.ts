import { describe, expect, it } from "vitest";

import { draftForTemplate, dueOccurrenceKey, eventMatches, fillTemplate, validateTemplate, type WeeklySchedule } from "../templates";

const TZ = "America/Los_Angeles";
const friday: WeeklySchedule = { kind: "weekly", weekday: "fr", time: "18:00" };

function due(at: string) {
  return dueOccurrenceKey(friday, new Date(at), TZ);
}

describe("weekly automation schedule", () => {
  it("is due on Friday once 6pm has passed, and stays due through the next week", () => {
    // Friday 6:30pm Pacific, and Sunday noon.
    expect(due("2026-11-21T02:30:00Z")).toBe("2026-11-20");
    expect(due("2026-11-22T20:00:00Z")).toBe("2026-11-20");
  });

  it("waits on Friday until the chosen time", () => {
    expect(due("2026-11-21T01:00:00Z")).toBeNull();
  });
});

describe("event triggers", () => {
  it("matches the watched words and never matches a blank watch", () => {
    expect(eventMatches("tutoring", "Math Tutoring")).toBe(true);
    expect(eventMatches("Science Bowl", "science bowl practice")).toBe(true);
    expect(eventMatches("chess", "Science Bowl")).toBe(false);
    expect(eventMatches("", "Anything")).toBe(false);
    expect(eventMatches(null, "Anything")).toBe(false);
  });
});

describe("template drafts", () => {
  it("fills known facts and leaves unknown placeholders for the user to edit", () => {
    expect(fillTemplate("Hi {student_name}, grade {grade}", { student_name: "Renata", grade: null })).toBe("Hi Renata, grade {grade}");
  });

  it("rejects a weekly email with no day, and an event email that watches nothing", () => {
    expect(
      validateTemplate({
        title: "Science Bowl",
        templateType: "recurring_automation",
        schedule: { kind: "event" },
        payload: { to: "team@school.edu", subject: "Science Bowl", body: "Practice tonight.", match: null },
      }).ok,
    ).toBe(false);
    expect(
      validateTemplate({
        title: "Print materials",
        templateType: "conditional_trigger",
        schedule: { kind: "event" },
        payload: { to: "office@school.edu", subject: "Print", body: "Please print for {event_title}.", match: "  " },
      }).ok,
    ).toBe(false);
  });

  it("builds a draft from a valid template without inventing a missing grade", () => {
    const template = validateTemplate({
      title: "Print materials",
      templateType: "conditional_trigger",
      schedule: { kind: "event" },
      payload: { to: "office@school.edu", subject: "{event_title}", body: "{student_name} is in grade {grade}.", match: "tutoring" },
    });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    expect(draftForTemplate(template.value, { event_title: "Math Tutoring", student_name: "Renata", grade: null })).toEqual({
      to: "office@school.edu",
      subject: "Math Tutoring",
      body: "Renata is in grade {grade}.",
    });
  });
});
