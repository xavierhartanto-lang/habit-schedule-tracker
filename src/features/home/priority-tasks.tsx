import { LifeAreaDot } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import { sortPriorityTasks } from "@/lib/domain/tasks";
import { formatDuration } from "@/lib/scheduling/time";
import Link from "next/link";
import { formatDue } from "@/features/tasks/format";
import { PriorityTag } from "@/features/tasks/priority";
import { loadHomeData } from "./home-data";
import { RailNote, RailSection } from "./rail-section";
import { TaskCheck } from "./task-check";

/** Open tasks, highest priority first. Render inside <Suspense>. */
export async function PriorityTasks() {
  const { ctx, openTasks, error } = await loadHomeData();
  const tasks = sortPriorityTasks(openTasks).slice(0, 4);
  return (
    <RailSection title="Tasks" href="/tasks" hrefLabel="All tasks">
      {error ? (
        <RailNote tone="danger">Couldn&apos;t load tasks.</RailNote>
      ) : tasks.length === 0 ? (
        <RailNote>
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
        </RailNote>
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {tasks.map((t) => {
            const due = formatDue(t.dueAt, ctx.timeZone, ctx.todayKey);
            return (
              <li key={t.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
                <span className="pt-px">
                  <TaskCheck id={t.id} title={t.title} inProgress={t.status === "in_progress"} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] text-ink">{t.title}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] tabular-nums text-ink-3">
                    <LifeAreaDot area={findArea(ctx.areas, t.lifeAreaId)} />
                    {[due && `Due ${/^(Today|Tomorrow|Yesterday)/.test(due) ? due.toLowerCase() : due}`, t.estimatedMinutes ? formatDuration(t.estimatedMinutes) : null]
                      .filter(Boolean)
                      .join(" · ") || findArea(ctx.areas, t.lifeAreaId)?.name || "Task"}
                  </p>
                </div>
                <PriorityTag priority={t.priority} className="shrink-0 pt-0.5 text-[11px]" />
              </li>
            );
          })}
        </ul>
      )}
    </RailSection>
  );
}
