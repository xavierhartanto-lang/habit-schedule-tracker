import { Card, CardBody, CardHeader, LifeAreaLabel } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import { sortPriorityTasks } from "@/lib/domain/tasks";
import type { TaskPriority } from "@/lib/domain/types";
import { formatDuration } from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";
import Link from "next/link";
import { formatDue } from "@/features/tasks/format";
import { loadHomeData } from "./home-data";
import { TaskCheck } from "./task-check";

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: "text-danger",
  medium: "text-ink-2",
  low: "text-ink-3",
};

/** Open tasks, highest priority first. Render inside <Suspense>. */
export async function PriorityTasks() {
  const { ctx, openTasks, error } = await loadHomeData();
  const tasks = sortPriorityTasks(openTasks).slice(0, 6);
  return (
    <Card>
      <CardHeader
        title="Priorities"
        description="What deserves your focus first."
        action={
          <Link href="/tasks" className="text-[12px] font-medium text-accent-ink hover:underline">
            All tasks
          </Link>
        }
      />
      <CardBody className="pt-3">
        {error ? (
          <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-danger">Could not load tasks.</p>
        ) : tasks.length === 0 ? (
          <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-ink-3">
            {ctx.state === "ready" ? (
              <>
                No open tasks.{" "}
                <Link href="/tasks" className="font-medium text-accent-ink hover:underline">
                  Add one
                </Link>
              </>
            ) : (
              "Sign in to see your tasks."
            )}
          </p>
        ) : (
          <ul className="space-y-1">
            {tasks.map((t) => {
              const due = formatDue(t.dueAt, ctx.timeZone, ctx.todayKey);
              return (
                <li key={t.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
                  <TaskCheck id={t.id} title={t.title} inProgress={t.status === "in_progress"} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{t.title}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3">
                      <LifeAreaLabel area={findArea(ctx.areas, t.lifeAreaId)} />
                      {due && <span className="text-[12px] text-ink-3">Due {due}</span>}
                      {t.estimatedMinutes ? (
                        <span className="text-[12px] text-ink-3">{formatDuration(t.estimatedMinutes)}</span>
                      ) : null}
                    </div>
                  </div>
                  <span className={cn("text-[11px] font-medium uppercase tracking-wide", PRIORITY_STYLE[t.priority])}>
                    {t.priority}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
