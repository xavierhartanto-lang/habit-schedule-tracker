import { isLifeArea, isUuid, type ValidationResult } from "./context-items";
import type { DataSource, GoalHorizon, GoalStatus, LifeArea } from "./types";

/** Pure validation for goals created from a form or a confirmed AI proposal. */

export type GoalInput = {
  title: string;
  area: LifeArea;
  description?: string | null;
  /** YYYY-MM-DD */
  targetDate?: string | null;
  status?: GoalStatus;
  horizon?: GoalHorizon | null;
  source?: DataSource;
  sourceMessageId?: string | null;
};

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "completed"];

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function validateGoalInput(raw: unknown): ValidationResult<GoalInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing goal." };
  const input = raw as Record<string, unknown>;

  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  if (!title) return { ok: false, error: "A title is required." };
  if (!isLifeArea(input.area)) return { ok: false, error: "Unknown life area." };
  if (input.targetDate != null && !isDateKey(input.targetDate)) {
    return { ok: false, error: "Target date must be YYYY-MM-DD." };
  }
  if (input.status != null && !GOAL_STATUSES.includes(input.status as GoalStatus)) {
    return { ok: false, error: "Unknown status." };
  }
  if (input.horizon != null && input.horizon !== "short_term" && input.horizon !== "long_term") {
    return { ok: false, error: "Unknown horizon." };
  }
  if (input.source != null && input.source !== "conversation" && input.source !== "manual") {
    return { ok: false, error: "Unknown source." };
  }
  if (input.sourceMessageId != null && !isUuid(input.sourceMessageId)) {
    return { ok: false, error: "Invalid source message." };
  }

  const description =
    typeof input.description === "string" ? input.description.trim().slice(0, 2000) || null : null;

  return {
    ok: true,
    value: {
      title,
      area: input.area,
      description,
      targetDate: (input.targetDate as string | null | undefined) ?? null,
      status: (input.status as GoalStatus | undefined) ?? "active",
      horizon: (input.horizon as GoalHorizon | null | undefined) ?? null,
      source: (input.source as DataSource | undefined) ?? "manual",
      sourceMessageId: (input.sourceMessageId as string | null | undefined) ?? null,
    },
  };
}
