import { AreaLabel, Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { sortPriorityTasks } from "@/lib/domain/tasks";
import type { TaskPriority } from "@/lib/domain/types";
import { SAMPLE_TASKS } from "@/lib/placeholder";
import { formatDuration } from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: "text-danger",
  medium: "text-ink-2",
  low: "text-ink-3",
};

export function PriorityTasks() {
  const tasks = sortPriorityTasks(SAMPLE_TASKS);
  return (
    <Card>
      <CardHeader title="Priorities" description="What deserves your focus first." action={<SampleDataBadge />} />
      <CardBody className="pt-3">
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
              <span
                aria-hidden
                className={cn(
                  "grid size-[18px] shrink-0 place-items-center rounded-md border-[1.5px] border-border-strong transition-colors group-hover:border-accent",
                  t.status === "in_progress" && "border-accent bg-accent-soft",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{t.title}</p>
                <div className="mt-0.5 flex items-center gap-3">
                  <AreaLabel area={t.area} />
                  {t.estimatedMinutes && (
                    <span className="text-[12px] text-ink-3">{formatDuration(t.estimatedMinutes)}</span>
                  )}
                </div>
              </div>
              <span className={cn("text-[11px] font-medium uppercase tracking-wide", PRIORITY_STYLE[t.priority])}>
                {t.priority}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
