import type { DailyBrief, ProactiveState, Recommendation, RecommendationKind } from "@/features/proactive/types";
import { surface } from "@/lib/proactive/surface";

/**
 * Turns the proactive engine's output into what Home shows: one opening line
 * with a few buttons, and at most a couple of quiet "also worth a look"
 * lines. Text and numbers come from the engine (deterministic); this only
 * decides what to show where. Pure, so it is tested. Client-safe.
 */

/** What a button does. Every change still goes through an approval card. */
export type ProactiveAct =
  | { kind: "daily_plan" }
  | { kind: "recommendation"; id: string; actionId: string }
  /** Sends `prompt` as the user's message (needs the AI). */
  | { kind: "ask"; prompt: string }
  /** "Not now": snoozes until tomorrow. */
  | { kind: "dismiss"; id: string };

export type ProactiveChip = { label: string; primary?: boolean; act: ProactiveAct };

export type Nudge = {
  /** Recommendation id. */
  id: string;
  tone: "suggestion" | "warning";
  message: string;
  facts: string[];
  chips: ProactiveChip[];
};

export type ProactiveOpening = { message: string; chips: ProactiveChip[]; recommendationId: string | null };

export type HomeProactive = {
  /** Replaces the Phase 4 opening line when set. */
  opening: ProactiveOpening | null;
  /** Shown under the opening line (fresh conversation). */
  nudges: Nudge[];
  /** Shown at the end of a resumed conversation: the opening (if a recommendation) plus the nudges. */
  resumeNudges: Nudge[];
};

export const EMPTY_PROACTIVE: HomeProactive = { opening: null, nudges: [], resumeNudges: [] };

const WARNING_KINDS: ReadonlySet<RecommendationKind> = new Set(["overload_day", "overload_week", "deadline_at_risk", "plan_broken"]);

/** Most buttons a suggestion gets, not counting "Not now". */
const MAX_ACTIONS = 2;
/** Home never shows more than this many quiet lines under the opening. */
export const MAX_NUDGES = 2;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function chipsFor(rec: Recommendation, aiConfigured: boolean): ProactiveChip[] {
  const chips: ProactiveChip[] = [];
  for (const a of rec.actions) {
    if (chips.length >= MAX_ACTIONS) break;
    const label = clean(a.label);
    if (!label) continue;
    if (a.kind === "ask") {
      const prompt = typeof a.params.prompt === "string" ? clean(a.params.prompt) : "";
      // Free-form follow-ups need the AI; plan-building actions don't.
      if (!aiConfigured || !prompt) continue;
      chips.push({ label, act: { kind: "ask", prompt } });
    } else {
      chips.push({ label, act: { kind: "recommendation", id: rec.id, actionId: a.id } });
    }
  }
  if (chips[0]) chips[0] = { ...chips[0], primary: true };
  chips.push({ label: "Not now", act: { kind: "dismiss", id: rec.id } });
  return chips;
}

export function toNudge(rec: Recommendation, aiConfigured: boolean): Nudge {
  return {
    id: rec.id,
    tone: WARNING_KINDS.has(rec.kind) ? "warning" : "suggestion",
    message: clean(rec.message || rec.title),
    facts: rec.facts.slice(0, 3),
    chips: chipsFor(rec, aiConfigured),
  };
}

function briefOpening(brief: DailyBrief): ProactiveOpening | null {
  const message = clean(brief.message);
  if (!message || !brief.action || brief.action.kind !== "plan_day") return null;
  return {
    message,
    recommendationId: null,
    chips: [{ label: clean(brief.action.label) || "Organize my day", primary: true, act: { kind: "daily_plan" } }],
  };
}

/**
 * Decides what Home says first:
 *  1. The daily brief, when the engine has a day worth planning.
 *  2. Otherwise a high-priority recommendation (overdue, overload, a broken plan).
 *  3. Otherwise nothing: Home keeps its Phase 4 opening line.
 * Recommendations about a task the opening already covers are not repeated.
 * Pass the engine's `surface: "all"` state.
 */
export function homeProactive(state: ProactiveState | null, aiConfigured: boolean, now: Date = new Date()): HomeProactive {
  if (!state) return EMPTY_PROACTIVE;
  let opening = briefOpening(state.today);
  // `state` comes from the engine's "all" surface. Drop what the brief already
  // covers first, then let the engine apply the level, quiet hours and limit,
  // so a covered task never takes the place of something new.
  const covered = new Set(opening ? state.today.focus.map((f) => f.taskId) : []);
  const candidates = state.recommendations.filter(
    (r) => r.status === "open" && clean(r.message || r.title) && (!r.target.taskId || !covered.has(r.target.taskId)),
  );
  const usable = surface(candidates, { settings: state.settings, now, timeZone: state.today.timeZone, mode: "home" });

  let rest = usable;
  if (!opening) {
    // Something already raised recently can sit quietly below; it never leads again.
    const top = usable.find((r) => r.priority === "high" && !r.raisedRecently);
    if (top) {
      const nudge = toNudge(top, aiConfigured);
      opening = { message: nudge.message, chips: nudge.chips, recommendationId: top.id };
      rest = usable.filter((r) => r.id !== top.id);
    }
  }

  const nudges = rest.slice(0, MAX_NUDGES).map((r) => toNudge(r, aiConfigured));
  const resumeNudges = opening?.recommendationId
    ? [toNudge(usable.find((r) => r.id === opening!.recommendationId)!, aiConfigured), ...nudges].slice(0, MAX_NUDGES)
    : nudges;
  return { opening, nudges, resumeNudges };
}

/** Ids of the recommendations Home actually shows, for the cooldown. */
export function shownIds(p: HomeProactive, resumed: boolean): string[] {
  const list = resumed ? p.resumeNudges : p.nudges;
  const ids = list.map((n) => n.id);
  if (!resumed && p.opening?.recommendationId) ids.unshift(p.opening.recommendationId);
  return [...new Set(ids)];
}
