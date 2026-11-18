import type { Task, TaskPriority } from "./types";

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

/** Open tasks, highest priority first, then soonest due. Pure business logic. */
export function sortPriorityTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      return (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
    });
}
