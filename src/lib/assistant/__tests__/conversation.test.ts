import { describe, expect, it } from "vitest";

import { assessIntent } from "../assess";
import { resolveDateRef } from "../dates";
import { nextDrafts } from "../drafts";
import { validatePlannerOutput, type Draft } from "../intents";
import { NOW, TODAY, date, intent, task, wire, world } from "./fixtures";

/**
 * Natural-language extraction, missing information and follow-ups. The
 * model's structured output is simulated with `wire(...)`; everything after
 * it (validation, merging, questions) is the real code.
 */

describe("relative dates (user's time zone)", () => {
  // TODAY is Wednesday 2026-11-18.
  it("resolves weekdays, next week, tomorrow and explicit dates", () => {
    expect(resolveDateRef({ isoDate: null, weekday: "fr", week: null, dayOffset: null }, TODAY)).toBe("2026-11-20");
    expect(resolveDateRef({ isoDate: null, weekday: "fr", week: "next", dayOffset: null }, TODAY)).toBe("2026-11-27");
    expect(resolveDateRef({ isoDate: null, weekday: "we", week: null, dayOffset: null }, TODAY)).toBe("2026-11-18");
    expect(resolveDateRef({ isoDate: null, weekday: "mo", week: null, dayOffset: null }, TODAY)).toBe("2026-11-23");
    expect(resolveDateRef({ isoDate: null, weekday: null, week: null, dayOffset: 1 }, TODAY)).toBe("2026-11-19");
    expect(resolveDateRef({ isoDate: "2026-12-03", weekday: null, week: null, dayOffset: null }, TODAY)).toBe("2026-12-03");
    expect(resolveDateRef({ isoDate: "2026-02-30", weekday: null, week: null, dayOffset: null }, TODAY)).toBeNull();
  });
});

describe("grounding and validation", () => {
  it("drops intents whose evidence is not in the user's words", () => {
    const out = validatePlannerOutput(
      {
        intents: [
          wire({ type: "create_task", title: "Buy notebook", evidence: "buy a lab notebook" }),
          wire({ type: "create_event", title: "Dentist", evidence: "dentist on monday" }),
        ],
        question: null,
      },
      { userText: "Add a task to buy a lab notebook", drafts: [] },
    );
    expect(out.intents.map((i) => i.title)).toEqual(["Buy notebook"]);
    expect(out.dropped).toEqual([{ title: "Dentist", reason: "ungrounded" }]);
  });

  it("cleans malformed times instead of guessing", () => {
    const i = intent({ type: "create_event", title: "Practice", evidence: "x", start_time: "6pm", end_time: "7:30" });
    expect(i.startTime).toBeNull();
    expect(i.endTime).toBe("07:30");
  });
});

describe("volleyball: one question at a time, nothing asked twice", () => {
  const w = world();
  const userTurn = (text: string, wireIntents: ReturnType<typeof wire>[], drafts: Draft[]) => {
    const out = validatePlannerOutput({ intents: wireIntents, question: null }, { userText: text, drafts });
    const assessments = out.intents.map((i) => assessIntent(i, w));
    return { out, assessments, next: nextDrafts(drafts, out.consumedDrafts, assessments, NOW) };
  };

  it("asks for the day, then repeat, then duration, then proposes the event", () => {
    // 1. "I have volleyball at 6."
    const t1 = userTurn("I have volleyball at 6.", [wire({ type: "create_event", title: "Volleyball", evidence: "volleyball at 6", start_time: "18:00", area: "Sports" })], []);
    expect(t1.next.clarify?.field).toBe("date");
    expect(t1.next.clarify?.question).toBe("What day is volleyball?");
    expect(t1.next.drafts).toHaveLength(1);
    const d1 = t1.next.drafts[0];

    // 2. "Thursday." (a follow-up: grounded through the draft)
    const t2 = userTurn("Thursday.", [wire({ type: "create_event", draft_id: d1.id, evidence: "Thursday", date: date({ weekday: "th" }) })], t1.next.drafts);
    expect(t2.next.clarify?.field).toBe("recurrence");
    expect(t2.next.clarify?.question).toBe("Is that every Thursday or just this Thursday?");
    expect(t2.next.clarify?.choices).toEqual(["Every Thursday", "Just this week"]);
    // The start time from turn 1 is remembered.
    expect(t2.next.drafts[0].intent.startTime).toBe("18:00");

    // 3. "Every Thursday."
    const t3 = userTurn("Every Thursday.", [wire({ type: "create_event", draft_id: d1.id, evidence: "Every Thursday", recurrence: "weekly", days: ["th"] })], t2.next.drafts);
    expect(t3.next.clarify?.field).toBe("duration");
    expect(t3.next.clarify?.question).toBe("How long does volleyball usually last?");

    // 4. "About 2 hours."
    const t4 = userTurn("About 2 hours.", [wire({ type: "create_event", draft_id: d1.id, evidence: "2 hours", duration_minutes: 120 })], t3.next.drafts);
    expect(t4.next.clarify).toBeNull();
    expect(t4.next.drafts).toHaveLength(0);
    const ready = t4.assessments[0];
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready" || ready.spec.kind !== "event") throw new Error("expected event");
    expect(ready.spec).toMatchObject({
      title: "Volleyball",
      date: "2026-11-19",
      startTime: "18:00",
      endTime: "20:00",
      rrule: "FREQ=WEEKLY;BYDAY=TH",
      recurrenceText: "Every Thursday",
      lifeAreaId: w.areas[1].id,
    });
  });

  it("lets the user correct an earlier answer", () => {
    const t1 = userTurn("Volleyball Thursday at 6", [wire({ type: "create_event", title: "Volleyball", evidence: "Volleyball Thursday at 6", start_time: "18:00", date: date({ weekday: "th" }) })], []);
    const d = t1.next.drafts[0];
    const t2 = userTurn("actually it's at 7, every week", [wire({ type: "create_event", draft_id: d.id, evidence: "at 7", start_time: "19:00", recurrence: "weekly", days: ["th"] })], t1.next.drafts);
    expect(t2.next.drafts[0].intent.startTime).toBe("19:00");
    expect(t2.next.clarify?.field).toBe("duration");
  });

  it("stops asking about the same field after two tries", () => {
    let drafts: Draft[] = [];
    let first = userTurn("I have practice", [wire({ type: "create_event", title: "Practice", evidence: "practice" })], drafts);
    drafts = first.next.drafts;
    for (let i = 0; i < 2; i++) {
      first = userTurn("not sure", [wire({ type: "create_event", draft_id: drafts[0]?.id ?? null, evidence: "not sure" })], drafts);
      drafts = first.next.drafts;
    }
    expect(first.next.givenUp).toEqual(["Practice"]);
    expect(drafts).toHaveLength(0);
  });

  it("cancels a draft on 'never mind'", () => {
    const t1 = userTurn("I have practice", [wire({ type: "create_event", title: "Practice", evidence: "practice" })], []);
    const t2 = userTurn("never mind", [wire({ type: "cancel_draft", draft_id: t1.next.drafts[0].id, evidence: "never mind" })], t1.next.drafts);
    expect(t2.next.drafts).toHaveLength(0);
    expect(t2.next.clarify).toBeNull();
  });
});

describe("other intents", () => {
  it("school until 3 every weekday asks only for the start time", () => {
    const a = assessIntent(intent({ type: "create_event", title: "School", evidence: "school until 3 every weekday", end_time: "15:00", recurrence: "weekdays" }), world());
    expect(a.status).toBe("needs");
    if (a.status === "needs") expect(a.clarify.question).toBe("What time does school start?");
  });

  it("an exam on a calendar date is one-time and asks for the time", () => {
    const a = assessIntent(intent({ type: "create_event", title: "Chemistry exam", evidence: "chemistry exam next Friday", date: date({ weekday: "fr", week: "next" }) }), world());
    expect(a.status).toBe("needs");
    if (a.status === "needs") expect(a.clarify.field).toBe("time");
  });

  it("creates a task from conversation with a resolved due date", () => {
    const a = assessIntent(
      intent({ type: "create_task", title: "Lab report", evidence: "lab report due Friday", explicit: true, deadline: date({ weekday: "fr" }), priority: "high" }),
      world(),
    );
    expect(a.status).toBe("ready");
    if (a.status === "ready") expect(a.spec).toMatchObject({ kind: "task_create", title: "Lab report", dueDate: "2026-11-20", priority: "high" });
  });

  it("asks which task when the reference is unclear", () => {
    const w = world();
    w.refs.tasks.set("t1", task({ title: "Chemistry worksheet" }));
    w.refs.tasks.set("t2", task({ title: "Chemistry lab" }));
    const a = assessIntent(intent({ type: "complete_task", title: "chemistry", evidence: "finished chemistry" }), w);
    expect(a.status).toBe("needs");
    if (a.status === "needs") expect(a.clarify.choices).toEqual(["Chemistry worksheet", "Chemistry lab"]);
  });

  it("never invents a study amount", () => {
    const a = assessIntent(intent({ type: "plan_time", title: "Study for chemistry", evidence: "study for chemistry" }), world());
    expect(a.status).toBe("needs");
    if (a.status === "needs") expect(a.clarify.field).toBe("amount");
  });

  it("asks for session length when only a count was given", () => {
    const a = assessIntent(intent({ type: "plan_time", title: "Piano", evidence: "practice piano twice", amount_kind: "sessions", session_count: 2 }), world());
    expect(a.status).toBe("needs");
    if (a.status === "needs") expect(a.clarify.question).toBe("How long should each piano session be?");
  });

  it("habits: 'exercise twice a week'", () => {
    const a = assessIntent(intent({ type: "create_habit", title: "Exercise", evidence: "exercising twice a week", cadence: "weekly", times_per_week: 2 }), world());
    expect(a.status).toBe("ready");
    if (a.status === "ready") expect(a.spec).toMatchObject({ kind: "habit_create", cadence: { type: "weekly", timesPerWeek: 2 } });
  });
});
