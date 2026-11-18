import { Notice } from "@/components/ui";
import { listGoals } from "@/lib/db/goals";
import { listActiveHabits } from "@/lib/db/habits";
import type { Goal, Habit } from "@/lib/domain/types";
import { addDaysToKey, startOfWeekKey } from "@/lib/scheduling/zoned";
import { loadPlanningContext, type PlanningContext } from "@/features/shared/planning-context";
import { GoalBoard } from "./goal-board";
import { HabitBoard } from "./habit-board";
import { HISTORY_WEEKS } from "@/lib/domain/habits";

/** Reads the session, habits (with ~12 weeks of history) and goals. Render inside <Suspense>. */
export async function HabitsContent() {
  let ctx: PlanningContext;
  let habits: Habit[] = [];
  let goals: Goal[] = [];
  try {
    ctx = await loadPlanningContext();
    if (ctx.state === "ready") {
      const from = addDaysToKey(startOfWeekKey(ctx.todayKey, ctx.weekStartsOn), -7 * HISTORY_WEEKS);
      [habits, goals] = await Promise.all([
        listActiveHabits(ctx.userId, { from, to: ctx.todayKey }),
        listGoals(ctx.userId),
      ]);
    }
  } catch {
    return <Notice tone="danger">Could not load your habits and goals. Refresh to try again.</Notice>;
  }

  const disabled = ctx.state !== "ready";
  return (
    <div className="space-y-8">
      {ctx.state === "preview" && <Notice>Preview mode: connect Supabase to track habits and goals.</Notice>}
      {ctx.state === "signed-out" && <Notice>Sign in to track your habits and goals.</Notice>}
      <HabitBoard
        habits={habits}
        areas={ctx.areas}
        todayKey={ctx.todayKey}
        weekStartsOn={ctx.weekStartsOn}
        timeZone={ctx.timeZone}
        disabled={disabled}
      />
      <GoalBoard goals={goals} areas={ctx.areas} todayKey={ctx.todayKey} disabled={disabled} />
    </div>
  );
}
