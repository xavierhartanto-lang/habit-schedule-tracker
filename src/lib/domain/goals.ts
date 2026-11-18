import { isLifeArea, isUuid, type ValidationResult } from "./context-items";
import type { DataSource, GoalHorizon, GoalStatus, LifeArea } from "./types";

/**
 * Pure validation for goals created from a form or a confirmed AI proposal.
 *
 * A goal's life area can be given two ways:
 *  - lifeAreaId: a user-defined life area (Phase 3 forms)
 *  - area: a legacy fixed category (AI proposals); the database maps it
 *    to the user's matching life area.
 * Neither means uncategorized.
 */

export type GoalInput = {
  title: string;
  area: LifeArea | null;
  /** Present only when the caller chose a life area explicitly (null = uncategorized). */
  lifeAreaId?: string | null;
  description?: string | null;
  /** YYYY-MM-DD */
  targetDate?: string | null;
  status?: GoalStatus;
  horizon?: GoalHorizon | null;
  /** 0-100, set manually by the user. */
  progress?: number;
  source?: DataSource;
  sourceMessageId?: string | null;
};

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "completed"];

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function isProgress(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function validateGoalInput(raw: unknown): ValidationResult<GoalInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing goal." };
  const input = raw as Record<string, unknown>;

  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return { ok: false, error: "A title is required." };
  if (title.length > 200) return { ok: false, error: "Keep the title under 200 characters." };

  const hasAreaId = "lifeAreaId" in input;
  if (hasAreaId && input.lifeAreaId != null && input.lifeAreaId !== "" && !isUuid(input.lifeAreaId)) {
    return { ok: false, error: "Unknown life area." };
  }
  if (input.area != null && input.area !== "" && !isLifeArea(input.area)) {
    return { ok: false, error: "Unknown life area." };
  }
  if (input.targetDate != null && input.targetDate !== "" && !isDateKey(input.targetDate)) {
    return { ok: false, error: "Target date must be YYYY-MM-DD." };
  }
  if (input.status != null && !GOAL_STATUSES.includes(input.status as GoalStatus)) {
    return { ok: false, error: "Unknown status." };
  }
  if (input.horizon != null && input.horizon !== "short_term" && input.horizon !== "long_term") {
    return { ok: false, error: "Unknown horizon." };
  }
  if (input.progress != null && !isProgress(input.progress)) {
    return { ok: false, error: "Progress must be a whole number from 0 to 100." };
  }
  if (input.source != null && input.source !== "conversation" && input.source !== "manual") {
    return { ok: false, error: "Unknown source." };
  }
  if (input.sourceMessageId != null && !isUuid(input.sourceMessageId)) {
    return { ok: false, error: "Invalid source message." };
  }

  const description =
    typeof input.description === "string" ? input.description.trim() || null : null;
  if (description && description.length > 2000) {
    return { ok: false, error: "Description is too long (max 2000 characters)." };
  }

  const value: GoalInput = {
    title,
    area: isLifeArea(input.area) ? input.area : null,
    description,
    targetDate: (input.targetDate as string | null | undefined) || null,
    status: (input.status as GoalStatus | undefined) ?? "active",
    horizon: (input.horizon as GoalHorizon | null | undefined) ?? null,
    source: (input.source as DataSource | undefined) ?? "manual",
    sourceMessageId: (input.sourceMessageId as string | null | undefined) ?? null,
  };
  if (hasAreaId) value.lifeAreaId = (input.lifeAreaId as string | null) || null;
  if (input.progress != null) value.progress = input.progress as number;
  return { ok: true, value };
}
