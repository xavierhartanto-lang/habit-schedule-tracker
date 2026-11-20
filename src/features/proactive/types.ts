/**
 * Phase 5 proactive assistant: client-safe types (no server imports).
 * Contract: /mnt/project-files/phase-5/recommendations-api.md
 *
 * Every text field is built deterministically from the user's real data,
 * so it can be shown as is when the AI is unavailable.
 */

export type ProactivityLevel = "minimal" | "balanced" | "proactive";

export const PROACTIVITY_LEVELS: readonly ProactivityLevel[] = ["minimal", "balanced", "proactive"];

export type AssistantSettings = {
  proactivity: ProactivityLevel;
  /** "HH:MM" local. Both null = no quiet hours. End before start crosses midnight. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  proactivity: "balanced",
  quietHoursStart: null,
  quietHoursEnd: null,
};

export type RecommendationKind =
  /** Due within ~2 days and its work isn't scheduled yet. */
  | "deadline_soon"
  /** Bigger than one session and due within a week: split it up now. */
  | "start_early"
  /** Not enough free time left before the deadline, counting earlier deadlines. */
  | "deadline_at_risk"
  | "overdue"
  /** Pushed back two or more times. */
  | "postponed"
  /** A session Whitespace scheduled has passed, the task is still open and nothing else is planned. */
  | "missed_session"
  | "overload_day"
  | "overload_week"
  /** A scheduled session now collides with an event: the user became unavailable. */
  | "plan_broken"
  /** Phase 7: two fixed events overlap. Which one is right? */
  | "commitment_conflict"
  /** Phase 7: several deadlines close together that only fit if work starts earlier. */
  | "deadline_cluster"
  /** Phase 7.6: a life area with no time lately, and a real window for it. Low priority. */
  | "neglected_area"
  /** Phase 7.3: an exam, test or quiz soon with nothing planned to study for it. */
  | "exam_prep";

/** Kinds added by the Phase 7 migration (20261128000000). Older databases reject them. */
export const PHASE7_KINDS: ReadonlySet<RecommendationKind> = new Set(["commitment_conflict", "deadline_cluster", "neglected_area", "exam_prep"]);
/** Kinds added by the Phase 7.3 migration (20261129000000). */
export const PHASE73_KINDS: ReadonlySet<RecommendationKind> = new Set(["exam_prep"]);

export type RecommendationPriority = "high" | "medium" | "low";

export type RecommendationStatus = "open" | "proposed" | "snoozed" | "dismissed" | "acted" | "resolved";

export type RecommendationActionKind =
  /** { taskId, minutes } plan sessions for the remaining work */
  | "schedule_work"
  /** { taskId, sessions, minutesEach } break a big task into sessions */
  | "split_sessions"
  /** { commitmentIds } move Whitespace sessions to new free times */
  | "reschedule"
  /** { date, commitmentIds } move flexible sessions off an overloaded day */
  | "lighten_day"
  /** { date, taskIds } the daily plan: sessions on that day for the focus tasks */
  | "plan_day"
  /** {} plan every open task with an estimate this week and report what doesn't fit */
  | "plan_week"
  /** { taskId, priority } */
  | "change_priority"
  /** { taskId } */
  | "mark_complete"
  /** { taskIds } plan the remaining work of several tasks together (deadline cluster) */
  | "schedule_tasks"
  /** { dropId, keepId, date } one of two overlapping fixed events goes: skip that day (repeating) or remove (one-off) */
  | "resolve_conflict"
  /** { eventId, sessions, minutesEach } study sessions before an exam */
  | "prep_exam"
  /** {} "Both are right": the situation is fine, never raise it again */
  | "acknowledge"
  /** { prompt } no plan: send `prompt` as the user's chat message */
  | "ask";

export type RecommendationAction = {
  /** Stable within one recommendation, e.g. "schedule_work". */
  id: string;
  kind: RecommendationActionKind;
  /** Button text, e.g. "Schedule 2 sessions". */
  label: string;
  params: Record<string, string | number | string[] | null>;
};

export type Recommendation = {
  id: string;
  kind: RecommendationKind;
  priority: RecommendationPriority;
  status: RecommendationStatus;
  /** Short: "History essay is due tomorrow". */
  title: string;
  /** One sentence: why now. */
  reason: string;
  /** What the assistant would say: one or two sentences ending with an offer. */
  message: string;
  /** Engine numbers: "Due Fri, Nov 27", "About 2 h of work", "1 h 30 min free before then". */
  facts: string[];
  /** date = local YYYY-MM-DD. */
  target: { taskId: string | null; commitmentIds: string[]; date: string | null };
  /** The first one is the recommended action. May be empty. */
  actions: RecommendationAction[];
  dedupeKey: string;
  /** Set once turned into a plan. */
  planId: string | null;
  createdAt: string;
  updatedAt: string;
  lastShownAt: string | null;
  /** Shown within the cooldown for the user's level: don't open with it again, keep it quiet. */
  raisedRecently: boolean;
};

export type BriefEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  kind: "fixed" | "flexible";
};

export type BriefFocus = {
  taskId: string;
  title: string;
  dueAt: string | null;
  estimatedMinutes: number | null;
  /** "Due tomorrow", "Overdue since Mon", "High priority, due Fri". */
  why: string;
};

export type DailyBrief = {
  /** Local today. */
  date: string;
  timeZone: string;
  /** The rest of today, in order. */
  events: BriefEvent[];
  /** Free working time left today (scheduling engine). */
  freeMinutes: number;
  /** At most 3, ranked. */
  focus: BriefFocus[];
  message: string;
  /** Usually plan_day. Null when there is nothing to plan. */
  action: RecommendationAction | null;
  /** Phase 7.5: overdue work, or work that doesn't fit before it's due. Home offers "I'm behind". */
  behind?: boolean;
};

export type ProactiveState = {
  settings: AssistantSettings;
  /** Now is inside the user's quiet hours. */
  quiet: boolean;
  today: DailyBrief;
  /** Ranked, filtered by level (and quiet hours on Home), at most the level's limit. */
  recommendations: Recommendation[];
  /** Every open recommendation, for a "see all" link. */
  openCount: number;
};
