import { addDaysToKey } from "@/lib/scheduling/zoned";
import type { HomeSignals } from "./signals";
import type { DeadlineItem, HomeLayout, HomeSection, SectionKind, SectionLayer } from "./types";

/**
 * Step 3 of the adaptive Home: which sections show, and in what order.
 * Deterministic rules over HomeSignals. No LLM decides layout.
 *
 *  - Each kind has a fixed slot. Priority decides whether a section makes
 *    the cut and which one leads, never where it sits, so a refresh can
 *    add or remove a section but never shuffle the rail.
 *  - At most MAX_ADAPTIVE adaptive and MAX_CONTEXT context sections.
 *  - A calm day (nothing due soon, no overload) never gets a warning.
 *  - A new user gets one intentional "getting started" section.
 */

export const MAX_ADAPTIVE = 3;
export const MAX_CONTEXT = 2;
/** Deadlines this close (days) are "now"; later ones go to Coming up. */
export const NEAR_DAYS = 3;
/** Free time worth pointing out on a calm day. */
export const OPEN_TIME_MINUTES = 60;
/** Only a section at least this important gets the lead emphasis. */
export const LEAD_MIN_PRIORITY = 60;
const MAX_DEADLINES = 4;
const MAX_COMING_UP = 4;

export const SLOTS: Record<SectionKind, { slot: number; layer: SectionLayer }> = {
  getting_started: { slot: 0, layer: "adaptive" },
  focus: { slot: 1, layer: "adaptive" },
  deadlines: { slot: 2, layer: "adaptive" },
  workload: { slot: 3, layer: "adaptive" },
  suggestions: { slot: 4, layer: "adaptive" },
  open_time: { slot: 5, layer: "adaptive" },
  week_outlook: { slot: 10, layer: "context" },
  progress: { slot: 11, layer: "context" },
  coming_up: { slot: 12, layer: "context" },
  goals: { slot: 13, layer: "context" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Draft = Omit<HomeSection, "slot" | "layer" | "lead" | "id" | "updatedAt"> & { updatedAt?: string | null };

function make(d: Draft): HomeSection {
  const { slot, layer } = SLOTS[d.kind];
  return { ...d, id: d.kind, slot, layer, lead: false, updatedAt: d.updatedAt ?? null } as HomeSection;
}

function deadlinePriority(items: DeadlineItem[]): number {
  if (items.some((i) => i.overdue)) return 85;
  const soonest = Math.min(...items.map((i) => i.days));
  return Math.max(55, 80 - soonest * 5);
}

function deadlinesReason(items: DeadlineItem[]): string {
  const overdue = items.filter((i) => i.overdue).length;
  const soon = items.length - overdue;
  const parts = [overdue && `${overdue} overdue`, soon && `${soon} in the next ${NEAR_DAYS} days`].filter(Boolean);
  return parts.join(", ");
}

/** Pick the strongest `max`, then put them back in slot order. Ties go to the earlier slot. */
function pick(list: HomeSection[], max: number): HomeSection[] {
  return [...list]
    .sort((a, b) => b.priority - a.priority || a.slot - b.slot)
    .slice(0, max)
    .sort((a, b) => a.slot - b.slot);
}

export function selectSections(s: HomeSignals): HomeLayout {
  if (s.isNewUser) {
    const only = make({
      kind: "getting_started",
      priority: 50,
      reason: "Nothing added yet",
      data: { aiConfigured: s.aiConfigured },
    });
    return { sections: [only], calm: true };
  }

  const focusId = s.focus?.taskId ?? null;
  const near = s.deadlines.filter((d) => d.overdue || d.days <= NEAR_DAYS).filter((d) => !(d.kind === "task" && d.id === focusId));
  const later = s.deadlines.filter((d) => !d.overdue && d.days > NEAR_DAYS);
  const hasWorkload = s.workloadWarnings.length + s.coveredWarnings.length > 0;
  const urgentDeadline = near.some((d) => d.overdue || d.days <= 1);
  const calm = s.focusUrgency < 2 && !urgentDeadline && !hasWorkload;

  const adaptive: HomeSection[] = [];
  const context: HomeSection[] = [];

  if (s.focus) {
    adaptive.push(
      make({
        kind: "focus",
        priority: [0, 60, 80, 90][s.focusUrgency],
        reason: s.focus.why,
        data: s.focus,
      }),
    );
  }

  if (near.length) {
    adaptive.push(
      make({
        kind: "deadlines",
        priority: deadlinePriority(near),
        reason: deadlinesReason(near),
        data: { items: near.slice(0, MAX_DEADLINES), more: Math.max(0, near.length - MAX_DEADLINES) },
      }),
    );
  }

  if (hasWorkload) {
    const flagsToday = s.week?.[0]?.overloaded ?? false;
    adaptive.push(
      make({
        kind: "workload",
        priority: flagsToday ? 88 : 72,
        reason: s.workloadWarnings[0]?.message ?? s.coveredWarnings[0]!.message,
        data: { warnings: s.workloadWarnings, coveredWarnings: s.coveredWarnings, days: s.week ?? [] },
        updatedAt: s.recommendationsUpdatedAt,
      }),
    );
  }

  if (s.suggestions.length) {
    adaptive.push(
      make({
        kind: "suggestions",
        priority: s.suggestions.some((n) => n.tone === "warning") ? 64 : 50,
        reason: plural(s.suggestions.length, "suggestion"),
        data: { items: s.suggestions },
        updatedAt: s.recommendationsUpdatedAt,
      }),
    );
  }

  const openTime = calm && s.freeMinutesToday >= OPEN_TIME_MINUTES && s.ideas.length > 0;
  if (openTime) {
    adaptive.push(
      make({
        kind: "open_time",
        priority: 40,
        reason: "A calm day with free time",
        data: { freeMinutes: s.freeMinutesToday, from: s.nextFreeAt, ideas: s.ideas },
      }),
    );
  }

  // The workload section already shows the week, so the outlook steps aside.
  const weekHasSomething = s.week?.some((d) => d.commitmentMinutes + d.sessionMinutes > 0 || d.due > 0) ?? false;
  if (s.week && weekHasSomething && !hasWorkload) {
    context.push(
      make({
        kind: "week_outlook",
        priority: calm ? 45 : 30,
        reason: `Next 7 days, through ${addDaysToKey(s.todayKey, 6)}`,
        data: { days: s.week },
      }),
    );
  }

  if (s.progress && s.progress.doneThisWeek > 0) {
    context.push(
      make({
        kind: "progress",
        priority: s.progress.doneToday > 0 ? 42 : 34,
        reason: s.progress.doneToday > 0 ? `${plural(s.progress.doneToday, "task")} done today` : `${plural(s.progress.doneThisWeek, "task")} done this week`,
        data: s.progress,
      }),
    );
  }

  if (later.length) {
    context.push(
      make({
        kind: "coming_up",
        priority: 35,
        reason: plural(later.length, "date") + " later in the next two weeks",
        data: { items: later.slice(0, MAX_COMING_UP) },
      }),
    );
  }

  // Goals are for calmer days; open time already lists them when it shows.
  if (s.goals.length && !openTime) {
    context.push(
      make({
        kind: "goals",
        priority: calm ? 36 : 20,
        reason: plural(s.goals.length, "active goal"),
        data: { goals: s.goals.slice(0, 3) },
      }),
    );
  }

  const shownAdaptive = pick(adaptive, MAX_ADAPTIVE);
  const top = [...shownAdaptive].sort((a, b) => b.priority - a.priority || a.slot - b.slot)[0];
  if (top && top.priority >= LEAD_MIN_PRIORITY) top.lead = true;

  return { sections: [...shownAdaptive, ...pick(context, MAX_CONTEXT)], calm };
}
