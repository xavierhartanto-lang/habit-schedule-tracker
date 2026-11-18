/**
 * Phase 4 scheduling engine. Pure and deterministic: no LLM, database,
 * React or clock reads. The AI decides what to schedule; this decides
 * when. Contract: /mnt/project-files/phase-4/scheduling-api.md (also
 * summarized in README.md).
 */
export { planSchedule } from "./plan";
export { checkPlacements, findFreeTime } from "./check";
export { planRequestSchema, requestFromTask, requestedMinutes, sessionSizes, REQUEST_LIMITS } from "./requests";
export type { ValidPlanRequest } from "./requests";
export {
  DEFAULT_SCHEDULING_PREFERENCES,
  defaultSchedulingPreferences,
  schedulingPreferencesSchema,
  LIMITS as SCHEDULING_PREFERENCE_LIMITS,
} from "./preferences";
export type { ProtectedTime, SchedulingPreferences, TimeRange } from "./preferences";
export { MAX_WINDOW_DAYS, LEAD_MINUTES } from "./context";
export { SchedulingInputError } from "./types";
export type {
  BusyBlock,
  FreeSlot,
  IssueCode,
  IsoRange,
  PlacementCheck,
  PlacementConflict,
  PlacementWarning,
  PlanAmount,
  PlanInput,
  PlanRequest,
  PlanResult,
  ProposedSession,
  Reason,
  RequestOutcome,
  ScheduleBase,
} from "./types";
