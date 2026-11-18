import { Notice } from "@/components/ui";
import { listGoals } from "@/lib/db/goals";
import { listTasks } from "@/lib/db/tasks";
import type { Goal, Task } from "@/lib/domain/types";
import { loadPlanningContext, type PlanningContext } from "@/features/shared/planning-context";
import { TaskBoard } from "./task-board";

/** Reads the session and the user's tasks. Render inside <Suspense>. */
export async function TasksContent() {
  let ctx: PlanningContext;
  let tasks: Task[] = [];
  let goals: Goal[] = [];
  try {
    ctx = await loadPlanningContext();
    if (ctx.state === "ready") {
      [tasks, goals] = await Promise.all([listTasks(ctx.userId), listGoals(ctx.userId)]);
    }
  } catch {
    return <Notice tone="danger">Could not load your tasks. Refresh to try again.</Notice>;
  }

  return (
    <div className="space-y-4">
      {ctx.state === "preview" && <Notice>Preview mode: connect Supabase to create and save tasks.</Notice>}
      {ctx.state === "signed-out" && <Notice>Sign in to manage your tasks.</Notice>}
      <TaskBoard
        tasks={tasks}
        goals={goals.map((g) => ({ id: g.id, title: g.title }))}
        areas={ctx.areas}
        timeZone={ctx.timeZone}
        todayKey={ctx.todayKey}
        disabled={ctx.state !== "ready"}
      />
    </div>
  );
}
