import { z } from "zod";
import { addDaysToKey, dateKeyInZone, timeKeyInZone, zonedToUtc } from "@/lib/scheduling/zoned";
import type { ValidationResult } from "./context-items";
import type { Task, TaskPriority, TaskStatus } from "./types";
import { check, zDateKey, zOptionalAreaId, zOptionalText, zTime, zTimeZone, zTitle, zUuid } from "./validation";

/**
 * Tasks are to-dos, separate from calendar events. They are never placed
 * on the calendar automatically. Pure business logic only.
 */

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

/** Open tasks, highest priority first, then soonest due. */
export function sortPriorityTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      return (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
    });
}

// ---------- Validation ----------

/** A due date without a chosen time is stored as 11:59 PM local. */
export const END_OF_DAY = "23:59";

export type TaskForm = {
  title: string;
  description?: string | null;
  lifeAreaId?: string | null;
  goalId?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  dueDate?: string | null;
  dueTime?: string | null;
  estimatedMinutes?: number | null;
  timezone: string;
};

export type TaskWrite = {
  title: string;
  description: string | null;
  lifeAreaId: string | null;
  goalId: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: string | null;
  estimatedMinutes: number | null;
};

export const TASK_TITLE_MAX = 300;
export const TASK_MAX_MINUTES = 1440;

const schema = z.object({
  title: zTitle(TASK_TITLE_MAX),
  description: zOptionalText(2000, "Description"),
  lifeAreaId: zOptionalAreaId,
  goalId: z.union([zUuid, z.literal("")], { error: "Unknown goal." }).nullish().transform((v) => v || null),
  priority: z.enum(["high", "medium", "low"], { error: "Unknown priority." }).default("medium"),
  status: z.enum(["todo", "in_progress", "done"], { error: "Unknown status." }).default("todo"),
  dueDate: z.union([zDateKey, z.literal("")], { error: "Use a valid date." }).nullish().transform((v) => v || null),
  dueTime: z.union([zTime, z.literal("")], { error: "Use a valid time." }).nullish().transform((v) => v || null),
  estimatedMinutes: z
    .number({ error: "Estimated time must be a number of minutes." })
    .int("Use whole minutes.")
    .min(1, "Estimated time must be at least 1 minute.")
    .max(TASK_MAX_MINUTES, "Estimated time must be under 24 hours.")
    .nullish()
    .transform((v) => v ?? null),
  timezone: zTimeZone,
});

export function validateTaskForm(raw: unknown): ValidationResult<TaskWrite> {
  const parsed = check(schema, raw);
  if (!parsed.ok) return parsed;
  const f = parsed.value;
  if (f.dueTime && !f.dueDate) return { ok: false, error: "Pick a due date for the time." };
  const dueAt = f.dueDate ? zonedToUtc(f.dueDate, f.dueTime ?? END_OF_DAY, f.timezone).toISOString() : null;
  return {
    ok: true,
    value: {
      title: f.title,
      description: f.description,
      lifeAreaId: f.lifeAreaId,
      goalId: f.goalId,
      priority: f.priority,
      status: f.status,
      dueAt,
      estimatedMinutes: f.estimatedMinutes,
    },
  };
}

// ---------- Due dates ----------

export type DueBucket = "overdue" | "today" | "week" | "later" | "none";

export function dueParts(dueAt: string | null, timeZone: string): { date: string; time: string | null } | null {
  if (!dueAt) return null;
  const at = new Date(dueAt);
  const time = timeKeyInZone(at, timeZone);
  return { date: dateKeyInZone(at, timeZone), time: time === END_OF_DAY ? null : time };
}

export function dueBucket(task: Pick<Task, "dueAt">, todayKey: string, timeZone: string): DueBucket {
  const due = dueParts(task.dueAt, timeZone);
  if (!due) return "none";
  if (due.date < todayKey) return "overdue";
  if (due.date === todayKey) return "today";
  if (due.date <= addDaysToKey(todayKey, 6)) return "week";
  return "later";
}

// ---------- Filtering and sorting ----------

export type TaskFilter = {
  status: "open" | "done" | "all";
  /** "all", "none" (uncategorized) or a life area id. */
  area: string;
  priority: "all" | TaskPriority;
  due: "all" | "overdue" | "today" | "week" | "none";
};

export type TaskSort = "due" | "priority" | "created" | "duration";

export const DEFAULT_TASK_FILTER: TaskFilter = { status: "open", area: "all", priority: "all", due: "all" };

export function filterTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
  ctx: { todayKey: string; timeZone: string },
): Task[] {
  return tasks.filter((t) => {
    if (filter.status === "open" && t.status === "done") return false;
    if (filter.status === "done" && t.status !== "done") return false;
    if (filter.area === "none" && t.lifeAreaId) return false;
    if (filter.area !== "all" && filter.area !== "none" && t.lifeAreaId !== filter.area) return false;
    if (filter.priority !== "all" && t.priority !== filter.priority) return false;
    if (filter.due !== "all") {
      const bucket = dueBucket(t, ctx.todayKey, ctx.timeZone);
      if (filter.due === "week") return bucket === "today" || bucket === "week" || bucket === "overdue";
      if (bucket !== filter.due) return false;
    }
    return true;
  });
}

export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
  const byDue = (a: Task, b: Task) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
  const byPriority = (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  const byCreated = (a: Task, b: Task) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  const byDuration = (a: Task, b: Task) => (a.estimatedMinutes ?? 99_999) - (b.estimatedMinutes ?? 99_999);
  const order: Record<TaskSort, ((a: Task, b: Task) => number)[]> = {
    due: [byDue, byPriority, byCreated],
    priority: [byPriority, byDue, byCreated],
    created: [byCreated],
    duration: [byDuration, byDue, byPriority],
  };
  return tasks.slice().sort((a, b) => {
    // Done tasks always sink to the bottom.
    const done = Number(a.status === "done") - Number(b.status === "done");
    if (done !== 0) return done;
    for (const cmp of order[sort]) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return 0;
  });
}
