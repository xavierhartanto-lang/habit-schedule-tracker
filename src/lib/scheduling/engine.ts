import type { Commitment, Preferences } from "@/lib/domain/types";

/**
 * Scheduling engine contract.
 *
 * The engine is deterministic and runs without any LLM. The AI layer may
 * later *propose* inputs (priorities, constraints) or *explain* outputs,
 * but placement decisions are made here so they are testable and predictable.
 *
 * Not implemented in Phase 1.
 */

export type TimeBlock = { start: string; end: string };

export type ScheduleRequest = {
  fixed: Commitment[];
  flexible: Commitment[];
  preferences: Pick<Preferences, "dayStartTime" | "dayEndTime" | "weekStartsOn">;
  /** Window to plan, inclusive start, exclusive end (ISO). */
  window: TimeBlock;
};

export type Placement = { commitmentId: string; block: TimeBlock };

export type ScheduleResult = {
  placements: Placement[];
  /** Flexible items that could not fit, with a human-readable reason. */
  unplaced: { commitmentId: string; reason: string }[];
};

export interface SchedulingEngine {
  plan(request: ScheduleRequest): ScheduleResult;
}
