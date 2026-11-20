import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NOW, PREFS, task, TODAY, TZ, weekCalendar } from "@/lib/assistant/__tests__/fixtures";
import { DEFAULT_ASSISTANT_SETTINGS, type Recommendation } from "@/features/proactive/types";
import { analyze } from "@/lib/proactive/analyze";
import { buildBrief } from "@/lib/proactive/brief";
import { addDaysToKey, zonedToUtc } from "@/lib/scheduling/zoned";
import { selectSections } from "../select";
import { evaluateSignals, type SignalInput } from "../signals";
import type { HomeSection } from "../types";

vi.mock("@/features/proactive/actions", () => ({ markRecommendationsShown: async () => ({ ok: true }) }));

const { SectionCard } = await import("../sections");

const due = (days: number) => zonedToUtc(addDaysToKey(TODAY, days), "23:59", TZ).toISOString();
const ctx = { timeZone: TZ, todayKey: TODAY, areas: [] };

function layoutFor(over: Partial<SignalInput>) {
  const events = over.events ?? weekCalendar();
  const tasks = over.openTasks ?? [];
  const analysis = analyze({ now: NOW.toISOString(), timeZone: TZ, events, tasks, preferences: PREFS });
  return selectSections(
    evaluateSignals({
      now: NOW,
      todayKey: TODAY,
      timeZone: TZ,
      events,
      openTasks: tasks,
      analysis,
      brief: buildBrief(analysis),
      recommendations: [],
      settings: DEFAULT_ASSISTANT_SETTINGS,
      chatShownIds: [],
      goals: [],
      recentlyDone: [],
      aiConfigured: true,
      ...over,
    }),
  );
}

const html = (s: HomeSection) => renderToStaticMarkup(createElement(SectionCard, { section: s, ctx }));

describe("adaptive sections render", () => {
  it("renders the busy-day sections with their data and a lead reason", () => {
    const overload: Recommendation = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "overload_day",
      priority: "high",
      status: "open",
      title: "Thursday is packed",
      reason: "r",
      message: "Thursday has more work than time. Want me to move something?",
      facts: [],
      target: { taskId: null, commitmentIds: [], date: addDaysToKey(TODAY, 1) },
      actions: [{ id: "lighten_day", kind: "lighten_day", label: "Lighten Thursday", params: {} }],
      dedupeKey: "k",
      planId: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      lastShownAt: null,
      raisedRecently: false,
    };
    const layout = layoutFor({
      openTasks: [task({ title: "History essay", dueAt: due(1), estimatedMinutes: 90 }), task({ title: "Lab report", dueAt: due(2) })],
      recommendations: [overload],
    });
    const out = layout.sections.map(html).join("\n");
    expect(out).toContain("Start here");
    expect(out).toContain("History essay");
    expect(out).toContain("Due soon");
    expect(out).toContain("Lab report");
    expect(out).toContain("Workload");
    // A suggestion is labelled as one and only offers to do something.
    expect(out).toContain("Suggestion");
    expect(out).toContain("Lighten Thursday");
    expect(out).toContain("Not now");
    expect(out).toContain('aria-label="Next 7 days"');
  });

  it("renders the calm-day and new-user sections", () => {
    const calm = layoutFor({ openTasks: [task({ title: "Practice scales" })] });
    expect(calm.sections.map(html).join("")).toContain("Your week");
    const fresh = layoutFor({ events: [], openTasks: [] });
    const out = html(fresh.sections[0]);
    expect(out).toContain("Get started");
    expect(out).toContain('href="/calendar"');
    expect(out).toContain('href="/tasks"');
  });
});
