import type { Commitment, TaskPriority, Weekday } from "@/lib/domain/types";
import type { SchedulingPreferences } from "./preferences";

/** ISO 8601 instant, e.g. "2026-11-20T23:00:00.000Z". */
export type Iso = string;

export type IsoRange = { start: Iso; end: Iso };

export type BusyBlock = { start: Iso; end: Iso; title?: string };

export type PlanAmount =
  | { type: "single"; minutes: number }
  | { type: "total"; minutes: number }
  | { type: "sessions"; count: number; minutesEach: number };

export type PlanRequest = {
  id: string;
  title: string;
  amount: PlanAmount;
  priority?: TaskPriority;
  deadline?: Iso | null;
  earliestStart?: Iso | null;
  preferredDays?: Weekday[];
  avoid?: IsoRange[];
  lifeAreaId?: string | null;
  taskId?: string | null;
  habitId?: string | null;
  goalId?: string | null;
};

export type ScheduleBase = {
  /** Nothing is placed before now (plus a short lead time). */
  now: Iso;
  timeZone: string;
  window: IsoRange;
  events: readonly Commitment[];
  busy?: readonly BusyBlock[];
  preferences: SchedulingPreferences;
};

export type PlanInput = ScheduleBase & { requests: readonly PlanRequest[] };

/** `short` is a 1–3 word chip label ("After Math", "10m buffer"); `text` is the full sentence. */
export type Reason = { code: string; text: string; short?: string };

export type ProposedSession = {
  id: string;
  requestId: string;
  title: string;
  start: Iso;
  end: Iso;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  index: number;
  count: number;
  reasons: Reason[];
  tradeoffs: Reason[];
  /** Busy blocks near this session on the same day, for the plan card's time strip. */
  nearby?: { title: string; start: Iso; end: Iso }[];
  /** The request's deadline, when it has one. */
  deadline?: Iso | null;
  alternatives: IsoRange[];
  lifeAreaId: string | null;
  taskId: string | null;
  habitId: string | null;
  goalId: string | null;
};

export type IssueCode =
  | "deadline_passed"
  | "no_time_before_deadline"
  | "daily_limits_reached"
  | "no_working_hours"
  | "not_enough_free_time"
  | "block_too_long"
  | "invalid_request";

export type RequestOutcome = {
  requestId: string;
  title: string;
  status: "scheduled" | "partial" | "unscheduled";
  requestedMinutes: number;
  scheduledMinutes: number;
  shortfallMinutes: number;
  sessionIds: string[];
  issue?: { code: IssueCode; message: string };
};

export type PlanResult = {
  sessions: ProposedSession[];
  outcomes: RequestOutcome[];
  fitsCompletely: boolean;
  summary: string;
};

export type FreeSlot = { date: string; start: Iso; end: Iso; minutes: number };

export type PlacementConflict = {
  kind: "event" | "busy" | "placement" | "invalid";
  title: string;
  start: Iso;
  end: Iso;
};

export type PlacementWarning = {
  kind: "in_past" | "outside_working_hours" | "protected_time" | "buffer";
  text: string;
};

export type PlacementCheck = {
  ok: boolean;
  results: { id: string; ok: boolean; conflicts: PlacementConflict[]; warnings: PlacementWarning[] }[];
};

/** Bad top-level input (time zone, window). Individual requests never throw. */
export class SchedulingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingInputError";
  }
}
