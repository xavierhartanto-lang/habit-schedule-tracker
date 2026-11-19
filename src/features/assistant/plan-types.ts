/**
 * Client-safe types for Phase 4 plans (AI proposals) and check-ins.
 * Contract: /mnt/project-files/phase-4/assistant-api.md. Types only.
 *
 * A plan is everything the assistant wants to change, stored in Supabase
 * (`plan_proposals` + `plan_items`). Calendar items always need approval.
 * Organizational items are applied right away only when the user asked
 * for that exact action; they come back with `autoApplied: true`.
 */

export type PlanStatus = "pending" | "partially_applied" | "applied" | "rejected" | "stale";

export type PlanKind = "actions" | "schedule" | "reschedule";

export const PLAN_ITEM_ACTIONS = [
  "create_event",
  "schedule_block",
  "move_block",
  "remove_block",
  "remove_event",
  "skip_occurrence",
  "create_task",
  "update_task",
  "complete_task",
  "remove_task",
  "create_habit",
  "update_habit",
  "create_goal",
  "update_goal",
  "set_life_area",
  "update_preferences",
  "save_fact",
] as const;

export type PlanItemAction = (typeof PLAN_ITEM_ACTIONS)[number];

/** Actions that change the calendar. They always need the user's approval. */
export const CALENDAR_ACTIONS: ReadonlySet<PlanItemAction> = new Set([
  "create_event",
  "schedule_block",
  "move_block",
  "remove_block",
  "remove_event",
  "skip_occurrence",
]);

export type PlanItemStatus = "pending" | "applied" | "rejected" | "conflict" | "failed" | "undone";

export type PlanTiming = {
  start: string;
  end: string;
  /** Local YYYY-MM-DD in the user's zone. */
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  timeZone: string;
  allDay: boolean;
  /** Human text, e.g. "Every Thursday". Null = one time. */
  recurrence: string | null;
};

export type PlanConflict = { title: string; start: string; end: string; kind: "fixed" | "flexible" };

export type PlanItem = {
  id: string;
  position: number;
  action: PlanItemAction;
  group: "calendar" | "organize";
  status: PlanItemStatus;
  autoApplied: boolean;
  title: string;
  detail: string | null;
  lifeAreaId: string | null;
  timing: PlanTiming | null;
  previous: { start: string; end: string } | null;
  reason: string | null;
  tradeoffs: string[];
  conflicts: PlanConflict[];
  warnings: string[];
  editable: boolean;
  canUndo: boolean;
  targetId: string | null;
  resultId: string | null;
  error: string | null;
};

export type PlanView = {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  kind: PlanKind;
  status: PlanStatus;
  summary: string | null;
  version: number;
  createdAt: string;
  items: PlanItem[];
  unscheduled: { title: string; minutes: number; reason: string }[];
};

export type ClarifyField =
  | "date"
  | "time"
  | "duration"
  | "recurrence"
  | "days"
  | "deadline"
  | "amount"
  | "target"
  | "other";

/** The one follow-up question the assistant is asking. */
export type Clarify = {
  about: string;
  field: ClarifyField;
  question: string;
  /** Optional quick replies. May be empty. */
  choices: string[];
};

export type PlanItemOutcome = "applied" | "already_applied" | "rejected" | "conflict" | "stale" | "failed";

export type PlanActionResult =
  | { ok: true; plan: PlanView; results: { itemId: string; outcome: PlanItemOutcome; message?: string }[] }
  | { ok: false; error: string; plan?: PlanView };

export type CheckInKind = "daily" | "weekly";

export type CheckIn = {
  kind: CheckInKind;
  timeZone: string;
  /** Local dates, inclusive. */
  range: { from: string; to: string };
  events: {
    id: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    kind: "fixed" | "flexible";
    recurring: boolean;
    lifeAreaId: string | null;
  }[];
  deadlines: { id: string; title: string; dueAt: string; priority: "high" | "medium" | "low"; source: "task" }[];
  openTaskCount: number;
  unscheduledTasks: { id: string; title: string; estimatedMinutes: number | null; dueAt: string | null }[];
  recurring: { title: string; when: string }[];
  habitsDue: { id: string; title: string }[];
  freeMinutes: number;
  starters: string[];
};
