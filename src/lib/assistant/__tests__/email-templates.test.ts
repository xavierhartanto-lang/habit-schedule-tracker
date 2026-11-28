import { describe, expect, it } from "vitest";

import type { AutomationTemplate } from "@/lib/domain/templates";
import { assessIntent, type World } from "../assess";
import { buildPlan, type BuildInput } from "../build-plan";
import { validatePlannerOutput } from "../intents";
import { NOW, PREFS, emptyRefs, event, intent, uuid, weekCalendar, wire, world } from "./fixtures";

/** A saved email template the assistant fills from calendar event notes. Sending always waits for Send. */

const OFFICE: AutomationTemplate = {
  id: uuid(),
  title: "Office print request",
  templateType: "email_template",
  schedule: { kind: "manual" },
  active: true,
  payload: {
    to: "office@school.edu",
    subject: "Print for {student_name}",
    body: "Hi,\n\nPlease print {materials} for {student_name} (grade {grade}) before {event_title} on {date} at {time}.\n\nThanks!",
    match: "tutoring",
  },
};

function worldWith(notes: string | null, templates: AutomationTemplate[] = [OFFICE]): World {
  const refs = emptyRefs();
  // Thursday after the fixture "now" (Wed Nov 18 2026, 4pm Los Angeles).
  refs.events.set("e1", event({ title: "Math Tutoring", date: "2026-11-19", start: "16:30", end: "17:30", notes }));
  refs.events.set("e2", event({ title: "Volleyball", date: "2026-11-19", start: "18:00", end: "20:00" }));
  return { ...world(refs), nowTime: "16:00", templates };
}

const ask = (overrides: Partial<Parameters<typeof wire>[0]> = {}) =>
  intent({ type: "send_email", title: "Tutoring session", target_name: "Office print request", evidence: "email the office about my tutoring session", ...overrides });

function ready(w: World, i = ask()) {
  const a = assessIntent(i, w);
  if (a.status !== "ready" || a.spec.kind !== "send_email") throw new Error(`not ready: ${JSON.stringify(a)}`);
  return a.spec;
}

function plan(w: World, i = ask()) {
  const input: BuildInput = {
    now: NOW.toISOString(),
    world: w,
    preferences: PREFS,
    events: weekCalendar(),
    openTasks: [],
    busy: [],
    specs: [{ spec: ready(w, i), explicit: true }],
    sourceMessageId: null,
  };
  return buildPlan(input);
}

describe("email templates from chat", () => {
  it("fills the student, grade and materials from the event notes, and the date and time from the event", () => {
    const spec = ready(worldWith("Student: Maya Chen\nGrade: 7\nPrint: worksheet 4, ruler"));
    expect(spec.to).toBe("office@school.edu");
    expect(spec.subject).toBe("Print for Maya Chen");
    expect(spec.body).toContain("Please print worksheet 4, ruler for Maya Chen (grade 7) before Math Tutoring on Thursday, Nov 19 at 4:30 PM.");
    expect(spec.template).toEqual({ title: "Office print request", event: "Math Tutoring, Thursday, Nov 19", missing: [] });
  });

  it("reads several labels on one line", () => {
    const spec = ready(worldWith("Student: Maya, Grade: 7, Materials: fractions packet"));
    expect(spec.body).toContain("print fractions packet for Maya (grade 7)");
  });

  it("never invents a value: anything not in the notes stays blank on the card and blocks Send", () => {
    const spec = ready(worldWith("Student: Maya"));
    expect(spec.body).toContain("Please print {materials} for Maya (grade {grade})");
    expect(spec.template?.missing).toEqual(["materials", "grade"]);
    const item = plan(worldWith("Student: Maya")).items[0];
    expect(item).toMatchObject({ action: "send_email", autoApply: false });
    expect(item.display.reason).toContain("Fill in {materials}, {grade} first.");
  });

  it("uses values the user typed, but only ones that are really in their message", () => {
    const out = validatePlannerOutput(
      {
        intents: [
          wire({
            type: "send_email",
            title: "Tutoring session",
            target_name: "Office print request",
            evidence: "email the office about tutoring, she's in grade 7",
            template_values: ["grade=7", "materials=ruler", "student_name=Priya"],
          }),
        ],
        question: null,
      },
      { userText: "email the office about tutoring, she's in grade 7", drafts: [] },
    );
    expect(out.intents[0].templateValues).toEqual({ grade: "7" });
    const spec = ready(worldWith("Student: Maya"), out.intents[0]);
    expect(spec.body).toContain("for Maya (grade 7)");
    expect(spec.template?.missing).toEqual(["materials"]);
  });

  it("finds the template from the event words when it isn't named, and leaves the user's own email alone", () => {
    const w = worldWith("Student: Maya\nGrade: 7\nMaterials: packet");
    expect(ready(w, ask({ target_name: null })).template?.title).toBe("Office print request");
    const own = ready(w, ask({ target_name: null, email_to: "coach@school.edu", email_body: "I'll be late." }));
    expect(own.template).toBeUndefined();
    expect(own.body).toBe("I'll be late.");
  });

  it("ignores templates that are off, and asks which one when two fit", () => {
    expect(assessIntent(ask(), worldWith(null, [{ ...OFFICE, active: false }])).status).toBe("needs");
    const twin = { ...OFFICE, id: uuid(), title: "Office print request (copies)" };
    const a = assessIntent(ask({ target_name: "office print" }), worldWith(null, [OFFICE, twin]));
    expect(a.status).toBe("needs");
  });

  it("with no matching event, still stages a card with every blank showing", () => {
    const w: World = { ...world(emptyRefs()), nowTime: "16:00", templates: [OFFICE] };
    const spec = ready(w);
    expect(spec.template).toMatchObject({ event: null });
    expect(spec.template?.missing).toEqual(["student_name", "materials", "grade", "event_title", "date", "time"]);
  });
});
