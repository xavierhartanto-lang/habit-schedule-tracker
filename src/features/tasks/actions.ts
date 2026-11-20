"use server";

import { DataValidationError } from "@/lib/db/client";
import { markPastSessionsDone } from "@/lib/db/events";
import { createSteps, createTask, deleteTask, getTask, listOpenTasks, setTaskStatus, updateTask } from "@/lib/db/tasks";
import { getSessionUser } from "@/lib/auth/session";
import { AiError } from "@/lib/ai/errors";
import { suggestBreakdown } from "@/lib/ai/service";
import { buildBreakdownPrompt, finishBreakdown, MAX_STEPS, MIN_STEPS, type ProposedStep } from "@/lib/assistant/breakdown";
import { shortDate } from "@/lib/assistant/dates";
import { dateKeyInZone } from "@/lib/scheduling/zoned";
import { validateTaskForm } from "@/lib/domain/tasks";
import type { TaskStatus } from "@/lib/domain/types";
import type { ActionResult } from "@/features/shared/action-result";
import { profileTimeZone } from "@/features/shared/profile-tz";
import { PLANNING_PATHS, runAction } from "@/features/shared/run-action";

/** Task writes. Tasks are never placed on the calendar automatically. */

const PATHS = ["/", "/tasks"];

export async function saveTask(id: string | null, form: unknown): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    // Dates are read in the user's profile time zone, whatever the browser says.
    const timezone = await profileTimeZone(userId);
    const result = validateTaskForm({ ...(form as object), timezone });
    if (!result.ok) throw new DataValidationError(result.error);
    if (id === null) return createTask(userId, result.value);
    return updateTask(userId, id, result.value);
  });
}

export async function setTaskDone(id: string, done: boolean): Promise<ActionResult> {
  const status: TaskStatus = done ? "done" : "todo";
  return runAction(PATHS, async (userId) => {
    await setTaskStatus(userId, id, status);
    // Plan vs reality: finishing the task means its past sessions happened. Never blocks the check-off.
    if (done) await markPastSessionsDone(userId, id).catch((e) => console.error("[tasks] session outcomes not recorded", e));
  });
}

export async function removeTask(id: string): Promise<ActionResult> {
  return runAction(PATHS, (userId) => deleteTask(userId, id));
}

// ---------------------------------------------------------------------------
// Phase 7.3: break a task into steps. Proposed by the AI, saved only on Save.
// ---------------------------------------------------------------------------

export type StepsProposal = { ok: true; steps: ProposedStep[] } | { ok: false; error: string };

export async function proposeSteps(taskId: string): Promise<StepsProposal> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to break tasks down." };
  try {
    const [task, open, timeZone] = await Promise.all([getTask(user.id, taskId), listOpenTasks(user.id, { limit: 200 }), profileTimeZone(user.id)]);
    if (task.status === "done") return { ok: false, error: "That task is already done." };
    if (task.parentTaskId) return { ok: false, error: "This is already a step." };
    if (open.some((t) => t.parentTaskId === task.id)) return { ok: false, error: "It already has steps." };
    const now = new Date();
    const due = task.dueAt ? `${shortDate(dateKeyInZone(new Date(task.dueAt), timeZone))}` : null;
    const wire = await suggestBreakdown({ prompt: buildBreakdownPrompt(task, due) });
    return { ok: true, steps: finishBreakdown(wire, task, { now, timeZone }) };
  } catch (e) {
    if (e instanceof AiError) return { ok: false, error: e.code === "not_configured" ? "Breaking tasks down needs the AI to be set up." : e.userMessage };
    if (e instanceof DataValidationError) return { ok: false, error: e.message };
    console.error("[tasks] breakdown failed", e);
    return { ok: false, error: "Couldn't suggest steps right now. Try again in a moment." };
  }
}

/** Saves the steps the user kept (possibly renamed). Dates and minutes are re-checked here. */
export async function saveSteps(taskId: string, steps: unknown): Promise<ActionResult> {
  return runAction(PLANNING_PATHS, async (userId) => {
    const list = Array.isArray(steps) ? steps : [];
    if (list.length < MIN_STEPS - 1 || list.length > MAX_STEPS) throw new DataValidationError(`Keep between 1 and ${MAX_STEPS} steps.`);
    const parent = await getTask(userId, taskId);
    if (parent.parentTaskId) throw new DataValidationError("A step can't have its own steps.");
    const dueLimit = parent.dueAt ? Date.parse(parent.dueAt) : null;
    const clean = list.map((raw) => {
      const s = (raw ?? {}) as { title?: unknown; minutes?: unknown; dueAt?: unknown };
      const title = typeof s.title === "string" ? s.title.replace(/\s+/g, " ").trim() : "";
      const minutes = typeof s.minutes === "number" ? Math.round(s.minutes) : NaN;
      const dueAt = typeof s.dueAt === "string" && Number.isFinite(Date.parse(s.dueAt)) ? new Date(s.dueAt).toISOString() : null;
      if (title.length < 1 || title.length > 120) throw new DataValidationError("Each step needs a short name.");
      if (!(minutes >= 5 && minutes <= 240)) throw new DataValidationError("Each step needs between 5 minutes and 4 hours.");
      // A step is never due after its task.
      const due = dueAt && dueLimit !== null && Date.parse(dueAt) > dueLimit ? parent.dueAt : dueAt;
      return { title, estimatedMinutes: minutes, dueAt: due };
    });
    await createSteps(userId, parent, clean);
  });
}
