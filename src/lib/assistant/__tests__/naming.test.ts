import { describe, expect, it } from "vitest";

import type { KnownFact } from "@/lib/ai/prompts";
import { assessIntent, type ActionSpec } from "../assess";
import { buildPlan } from "../build-plan";
import { validatePlannerOutput } from "../intents";
import { canonicalName, formatFactTitle, formatTitle, groundTitle, nameActivity } from "../naming";
import { buildPlannerUserPrompt, namingContext, PLANNER_SYSTEM_PROMPT, type PlannerKnowledge } from "../planner-prompt";
import { AREAS, NOW, PREFS, TODAY, TZ, date, emptyRefs, event, task, weekCalendar, wire, world } from "./fixtures";

/**
 * Contextual activity naming. The planner model's structured output is
 * simulated with `wire(...)`, including deliberately bad titles, to prove
 * the server-side layer keeps names clean, specific and honest whatever the
 * model returns. Everything after the wire is the real code.
 */

function knowledge(facts: KnownFact[], recaps: string[] = []): PlannerKnowledge {
  return { personalizationEnabled: true, profile: { gradeLevel: 11, school: "Lincoln High" }, facts, recaps };
}

function plan(userText: string, wires: ReturnType<typeof wire>[], k: PlannerKnowledge | null, w = world()) {
  const naming = namingContext({ refs: w.refs, areas: w.areas, recentHistory: [], knowledge: k });
  return validatePlannerOutput({ intents: wires, question: null }, { userText, drafts: [], naming });
}

const titles = (out: ReturnType<typeof plan>) => out.intents.map((i) => i.title);

describe("formatTitle", () => {
  it("turns casual phrasing into a clean calendar name", () => {
    expect(formatTitle("need to finish my chem hw")).toBe("Chemistry Homework");
    expect(formatTitle("I have to tutor a kid tomorrow")).toBe("Tutor a Kid");
    expect(formatTitle("basketball after school")).toBe("Basketball");
    expect(formatTitle("Do some basketball stuff")).toBe("Basketball");
    expect(formatTitle("study session with jack.")).toBe("Study Session with Jack");
  });

  it("keeps acronyms and names as the user writes them", () => {
    expect(formatTitle("deca meeting", { sources: ["Meeting with the DECA people"] })).toBe("DECA Meeting");
    expect(formatTitle("Finish my AP Chemistry lab report")).toBe("AP Chemistry Lab Report");
    expect(formatTitle("hoopvision development", { sources: ["My app is called HoopVision"] })).toBe("HoopVision Development");
  });

  it("removes dates, times, durations and frequency", () => {
    expect(formatTitle("Volleyball practice on Thursday at 6pm")).toBe("Volleyball Practice");
    expect(formatTitle("SAT prep for 2 hours next week")).toBe("SAT Prep");
    expect(formatTitle("piano twice a week")).toBe("Piano");
    expect(formatTitle("Math tutoring tomorrow 4-5pm")).toBe("Math Tutoring");
  });

  it("never turns a title into a paragraph", () => {
    const long = formatTitle("Research and outline the history of the industrial revolution in Europe and its long term effects on labor");
    expect(long!.length).toBeLessThanOrEqual(60);
    expect(long).not.toMatch(/\s(of|the|and|in|on)$/i);
  });

  it("leaves preference-style facts alone and only formats activities", () => {
    expect(formatFactTitle("working_time", "Focus after 8pm")).toBe("Focus after 8pm");
    expect(formatFactTitle("activity", "debate club")).toBe("Debate Club");
    expect(formatFactTitle("goal", "1500 on the SAT by June")).toBe("1500 on the SAT by June");
  });
});

describe("groundTitle: specificity without hallucination", () => {
  it("removes a subject nobody mentioned and falls back to a general title", () => {
    expect(groundTitle("Math Tutoring", ["I have to tutor a kid tomorrow"])).toEqual({ title: "Tutoring Session", removed: ["Math"] });
  });

  it("removes invented people, keeps the activity", () => {
    expect(groundTitle("Study Session with Sarah", ["need to study tonight"]).title).toBe("Study Session");
  });

  it("keeps specifics that context establishes", () => {
    expect(groundTitle("Math Tutoring", ["I have to tutor a kid", "Tutoring: elementary school math, Tue/Thu"]).removed).toEqual([]);
    expect(groundTitle("Chemistry Homework", ["need to finish my chem hw"]).removed).toEqual([]);
  });

  it("accepts rewording and common activity words without stripping real meaning", () => {
    const cases: [string, string, string][] = [
      ["Chemistry Exam", "chem test friday", "Chemistry Exam"],
      ["Dentist Appointment", "dentist on monday at 3", "Dentist Appointment"],
      ["Soccer Match", "soccer game saturday", "Soccer Match"],
      ["SAT Prep", "I want to do sat prep sunday", "SAT Prep"],
      ["Exercise", "start exercising twice a week", "Exercise"],
      ["Family Dinner", "dinner with family", "Family Dinner"],
      ["Chemistry Study Session", "study for chem", "Chemistry Study Session"],
      ["Morning Run", "go running tomorrow", "Run"],
    ];
    for (const [title, said, expected] of cases) {
      expect(nameActivity(title, { sources: [said], knownNames: [] }, { fallback: said }).title).toBe(expected);
    }
  });

  it("reuses an existing name exactly", () => {
    expect(canonicalName("basketball practice", ["Basketball Practice", "DECA"])).toBe("Basketball Practice");
    expect(canonicalName("Basketball Game", ["Basketball Practice"])).toBe("Basketball Game");
  });

  it("falls back to the user's own words when nothing usable is left", () => {
    const out = nameActivity("Hogwarts", { sources: ["going to the thing at the community center"], knownNames: [] }, { fallback: "the thing at the community center" });
    expect(out.title).toBe("Thing at the Community Center");
  });
});

describe("the 8 scenarios", () => {
  const tutorKid = "I have to tutor a kid tomorrow.";

  it("1. established math tutoring: 'tutor a kid' -> Math Tutoring", () => {
    const k = knowledge([{ category: "activity", title: "Tutoring", area: "personal", detail: "tutors elementary-school students in math" }]);
    const out = plan(tutorKid, [wire({ type: "create_event", title: "Math Tutoring", evidence: "tutor a kid tomorrow", date: date({ day_offset: 1 }), details: "Tutoring an elementary-school student in math." })], k);
    expect(titles(out)).toEqual(["Math Tutoring"]);
    expect(out.intents[0].details).toBe("Tutoring an elementary-school student in math.");
    expect(out.retitled).toEqual([]);
  });

  it("2. no known subject: Tutoring Session, even if the model guesses Math", () => {
    const honest = plan(tutorKid, [wire({ type: "create_event", title: "Tutoring Session", evidence: "tutor a kid tomorrow" })], knowledge([]));
    expect(titles(honest)).toEqual(["Tutoring Session"]);
    const guessed = plan(tutorKid, [wire({ type: "create_event", title: "Math Tutoring", evidence: "tutor a kid tomorrow" })], knowledge([]));
    expect(titles(guessed)).toEqual(["Tutoring Session"]);
    expect(guessed.retitled[0].removed).toEqual(["Math"]);
  });

  it("3. regular basketball practice: reuses the existing name", () => {
    const refs = emptyRefs();
    refs.events.set("e1", event({ title: "Basketball Practice", date: "2026-09-01", start: "15:30", end: "17:30", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE" }));
    const out = plan("Basketball after school.", [wire({ type: "create_event", title: "basketball practice", evidence: "Basketball after school" })], knowledge([]), world(refs));
    expect(titles(out)).toEqual(["Basketball Practice"]);
  });

  it("4. established project: 'work on my app' -> HoopVision Development", () => {
    const k = knowledge([{ category: "activity", title: "HoopVision", area: "creative", detail: "basketball training app they are building" }]);
    const out = plan("I need to work on my app.", [wire({ type: "plan_time", title: "HoopVision Development", evidence: "work on my app" })], k);
    expect(titles(out)).toEqual(["HoopVision Development"]);
    // Without that context the project name is not invented.
    const unknown = plan("I need to work on my app.", [wire({ type: "plan_time", title: "HoopVision Development", evidence: "work on my app" })], knowledge([]));
    expect(titles(unknown)).toEqual(["Development Session"]);
  });

  it("5. unfamiliar activity: accurate general title, no invented specifics", () => {
    const out = plan(
      "I have a thing at the community center Saturday",
      [wire({ type: "create_event", title: "Volunteer Shift at Community Center with Maria", evidence: "a thing at the community center Saturday", date: date({ weekday: "sa" }) })],
      knowledge([]),
    );
    expect(titles(out)).toEqual(["Shift at Community Center"]);
    expect(out.retitled[0].removed).toEqual(["Volunteer", "Maria"]);
  });

  it("6. already specific: preserves the user's specificity", () => {
    const text = "Finish my AP Chemistry lab report.";
    const fromModel = plan(text, [wire({ type: "create_task", title: "AP Chemistry Lab Report", evidence: "Finish my AP Chemistry lab report" })], knowledge([]));
    expect(titles(fromModel)).toEqual(["AP Chemistry Lab Report"]);
    // Even a lazy title in the user's words gets the same clean result.
    const lazy = plan(text, [wire({ type: "create_task", title: "finish my AP chemistry lab report", evidence: "Finish my AP Chemistry lab report" })], knowledge([]));
    expect(titles(lazy)).toEqual(["AP Chemistry Lab Report"]);
  });

  it("7. the same activity keeps one name everywhere", () => {
    const refs = emptyRefs();
    refs.tasks.set("t1", task({ title: "Chemistry Homework" }));
    const k = knowledge([{ category: "commitment", title: "DECA Meeting", area: "extracurricular", detail: "Tue 15:30-16:30" }]);
    const out = plan(
      "deca meeting thursday and add chemistry homework",
      [
        wire({ type: "create_event", title: "Deca meeting", evidence: "deca meeting thursday" }),
        wire({ type: "create_task", title: "chemistry homework", evidence: "chemistry homework" }),
      ],
      k,
      world(refs),
    );
    expect(titles(out)).toEqual(["DECA Meeting", "Chemistry Homework"]);
  });

  it("8. sessions for an existing task carry the task's name and link", () => {
    const hw = task({ title: "Chemistry Homework", estimatedMinutes: 90, dueAt: "2026-11-21T07:59:00.000Z" });
    const refs = emptyRefs();
    refs.tasks.set("t1", hw);
    const w = world(refs);

    // By ref, even when the model calls it something else.
    const byRef = plan("find time for my chem hw", [wire({ type: "plan_time", title: "Chem Study Time", evidence: "find time for my chem hw", target_ref: "t1" })], knowledge([]), w);
    // By exact name, without a ref.
    const byName = plan("find time for Chemistry Homework", [wire({ type: "plan_time", title: "chemistry homework", evidence: "find time for Chemistry Homework" })], knowledge([]), w);

    for (const out of [byRef, byName]) {
      const a = assessIntent(out.intents[0], w);
      expect(a.status).toBe("ready");
      const spec = (a as { spec: ActionSpec }).spec;
      expect(spec).toMatchObject({ kind: "plan_time", title: "Chemistry Homework", taskId: hw.id });
      const built = buildPlan({ now: NOW.toISOString(), world: w, preferences: PREFS, events: weekCalendar(), openTasks: [hw], busy: [], specs: [{ spec, explicit: false }], sourceMessageId: null });
      const blocks = built.items.filter((i) => i.action === "schedule_block");
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b.payload).toMatchObject({ title: "Chemistry Homework", taskId: hw.id });
    }
  });
});

describe("what the planner sees", () => {
  it("gets the user's context and the naming rules", () => {
    const k = knowledge([{ category: "activity", title: "Tutoring", area: "personal", detail: "elementary-school math" }], ["Robotics: planned the build season."]);
    const prompt = buildPlannerUserPrompt({
      todayKey: TODAY,
      weekday: "Wednesday",
      timeZone: TZ,
      areas: AREAS,
      refs: emptyRefs(),
      actions: [],
      recentHistory: [],
      newUserText: "I have to tutor a kid tomorrow",
      knowledge: k,
    });
    expect(prompt).toContain("<what_whitespace_knows>");
    expect(prompt).toContain("Tutoring [personal]: elementary-school math");
    expect(prompt).toContain("Robotics: planned the build season.");
    expect(PLANNER_SYSTEM_PROMPT).toContain("Never invent specifics");
    expect(PLANNER_SYSTEM_PROMPT).toContain('"Tutoring Session", not "Math Tutoring"');
  });

  it("personalization off: no facts or recaps in the prompt or the naming sources", () => {
    const k = { ...knowledge([{ category: "activity", title: "HoopVision", area: "creative" as const }], ["secret recap"]), personalizationEnabled: false };
    const prompt = buildPlannerUserPrompt({ todayKey: TODAY, weekday: "Wednesday", timeZone: TZ, areas: AREAS, refs: emptyRefs(), actions: [], recentHistory: [], newUserText: "work on my app", knowledge: k });
    expect(prompt).not.toContain("HoopVision");
    expect(prompt).not.toContain("secret recap");
    const out = plan("work on my app", [wire({ type: "plan_time", title: "HoopVision Development", evidence: "work on my app" })], k);
    expect(titles(out)).toEqual(["Development Session"]);
  });

  it("does not rename things the user is pointing at", () => {
    const refs = emptyRefs();
    refs.tasks.set("t1", task({ title: "history essay" }));
    const out = plan("delete my history essay task", [wire({ type: "remove_task", title: "history essay", evidence: "delete my history essay task", target_ref: "t1" })], knowledge([]), world(refs));
    expect(titles(out)).toEqual(["history essay"]);
  });
});
