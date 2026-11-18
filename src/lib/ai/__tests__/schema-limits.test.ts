import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";

import { ExtractionWireSchema } from "@/lib/ai/extraction";
import { PlannerApiSchema, PlannerWireSchema, fromApiWire, validatePlannerOutput } from "@/lib/assistant/intents";

/**
 * The API compiles structured-output schemas into a grammar and rejects a
 * request with more than 16 union-typed fields (nullable counts) or more than
 * 24 optional fields. Mock-model tests can't catch that, so count here.
 */
type Json = { [k: string]: unknown };

function complexity(schema: unknown) {
  let unions = 0;
  let optional = 0;
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as Json;
    const props = (n.properties ?? {}) as Record<string, Json>;
    const required = new Set((n.required as string[] | undefined) ?? []);
    for (const [key, value] of Object.entries(props)) {
      if (Array.isArray(value.type) || Array.isArray(value.anyOf)) unions++;
      if (!required.has(key)) optional++;
    }
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(schema);
  return { unions, optional };
}

const schemaOf = (format: unknown) => (format as { schema: unknown }).schema;

describe("structured-output schemas fit the API limits", () => {
  it("planner schema has no unions and no optional fields", () => {
    const c = complexity(schemaOf(zodOutputFormat(PlannerApiSchema)));
    expect(c).toEqual({ unions: 0, optional: 0 });
  });

  it("the nullable planner wire schema would not fit (why the API twin exists)", () => {
    expect(complexity(schemaOf(zodOutputFormat(PlannerWireSchema))).unions).toBeGreaterThan(16);
  });

  it("extraction schema stays within 16 unions and 24 optional fields", () => {
    const c = complexity(schemaOf(zodOutputFormat(ExtractionWireSchema)));
    expect(c.unions).toBeLessThanOrEqual(16);
    expect(c.optional).toBeLessThanOrEqual(24);
  });
});

describe("fromApiWire", () => {
  const none = { iso_date: "", weekday: "none", week: "none", day_offset: -1 };
  const api = (o: Record<string, unknown>) => ({
    draft_id: "", explicit: false, title: "", area: "", target_ref: "", date: none, start_time: "", end_time: "",
    duration_minutes: -1, recurrence: "none", days: [], deadline: none, deadline_time: "", amount_kind: "none",
    amount_minutes: -1, session_count: -1, session_minutes: -1, window: "none", priority: "none", cadence: "none",
    times_per_week: -1, progress: -1, target_date: none, location: "", fact_category: "none", details: "",
    pref_day_start: "", pref_day_end: "", pref_max_session_minutes: -1, pref_buffer_minutes: -1, pref_protected_label: "",
    ...o,
  });

  it("parses with the API schema and turns markers into nulls", () => {
    const raw = PlannerApiSchema.parse({
      intents: [api({ type: "create_event", title: "Volleyball", evidence: "volleyball at 6", start_time: "18:00", date: { ...none, weekday: "th" } })],
      question: "",
    });
    const out = validatePlannerOutput(fromApiWire(raw), { userText: "I have volleyball at 6 on Thursday", drafts: [] });
    expect(out.question).toBeNull();
    expect(out.intents).toHaveLength(1);
    const i = out.intents[0];
    expect(i.title).toBe("Volleyball");
    expect(i.startTime).toBe("18:00");
    expect(i.date).toEqual({ isoDate: null, weekday: "th", week: null, dayOffset: null });
    expect(i.deadline).toBeNull();
    expect(i.durationMinutes).toBeNull();
    expect(i.recurrence).toBeNull();
  });

  it("keeps day_offset 0 (today) and progress 0", () => {
    const raw = PlannerApiSchema.parse({
      intents: [api({ type: "update_goal", title: "Essay", evidence: "essay", progress: 0, date: { ...none, day_offset: 0 } })],
      question: "",
    });
    const out = validatePlannerOutput(fromApiWire(raw), { userText: "essay", drafts: [] });
    expect(out.intents[0].progress).toBe(0);
    expect(out.intents[0].date?.dayOffset).toBe(0);
  });
});
