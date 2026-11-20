import { Skeleton } from "@/components/ui";
import { listActiveHabits } from "@/lib/db/habits";
import { isScheduledOn } from "@/lib/domain/habits";
import { dueParts } from "@/lib/domain/tasks";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, daysBetweenKeys, startOfDayInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { CircleCheck, LineChart, Target, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { GlanceNext, type NextItem } from "./glance-next";
import { loadHomeData } from "./home-data";

/**
 * Home's one-tap hub on phones and tablets (hidden from xl, where the side
 * rail shows the same things). What's on now or next, then tiles for tasks,
 * habits and insights. Render inside <Suspense>.
 */

export const TILE =
  "group relative flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-3.5 shadow-card transition-[transform,background-color,border-color] duration-150 ease-out active:scale-[0.97] active:bg-surface-2 hover:border-border-strong";

export function GlanceSkeleton() {
  return (
    <div className="grid gap-2.5 xl:hidden">
      <Skeleton className="h-[76px] rounded-2xl" />
      <div className="grid grid-cols-3 gap-2.5">
        <Skeleton className="h-[104px] rounded-2xl" />
        <Skeleton className="h-[104px] rounded-2xl" />
        <Skeleton className="h-[104px] rounded-2xl" />
      </div>
    </div>
  );
}

export async function HomeGlance() {
  const { ctx, events, openTasks, error } = await loadHomeData();
  if (ctx.state !== "ready" || error) return null;
  const tz = ctx.timeZone;

  // Today and tomorrow, so the card can say what's first tomorrow once today is done.
  const from = startOfDayInZone(ctx.todayKey, tz);
  const to = startOfDayInZone(addDaysToKey(ctx.todayKey, 2), tz);
  const tomorrowStart = startOfDayInZone(addDaysToKey(ctx.todayKey, 1), tz).getTime();
  const upcoming: NextItem[] = expandEvents(events, from, to, tz)
    .filter((o) => !o.allDay)
    .map((o) => ({
      key: o.key,
      title: o.event.title,
      location: o.event.location ?? null,
      start: o.start.toISOString(),
      end: o.end.toISOString(),
      areaId: o.event.lifeAreaId ?? null,
      tomorrow: o.start.getTime() >= tomorrowStart,
    }));

  const dueSoon = openTasks.filter((t) => {
    const due = dueParts(t.dueAt, tz);
    return due !== null && daysBetweenKeys(ctx.todayKey, due.date) <= 1;
  }).length;

  let habits: { due: number; done: number } | null = null;
  try {
    const list = await listActiveHabits(ctx.userId, { from: ctx.todayKey, to: ctx.todayKey });
    const todays = list.filter((h) => isScheduledOn(h.cadence, ctx.todayKey));
    habits = { due: todays.length, done: todays.filter((h) => h.completedOn.includes(ctx.todayKey)).length };
  } catch {
    habits = null;
  }

  return (
    <nav aria-label="At a glance" className="grid gap-2.5 xl:hidden">
      <GlanceNext items={upcoming} areas={ctx.areas} timeZone={tz} />
      <div className="grid grid-cols-3 gap-2.5">
        <Tile
          href="/tasks"
          icon={CircleCheck}
          label="Tasks"
          value={openTasks.length}
          detail={dueSoon ? `${dueSoon} due soon` : openTasks.length ? "Open" : "All clear"}
          alert={dueSoon > 0}
        />
        <Tile
          href="/habits"
          icon={Target}
          label="Habits"
          value={habits?.due ? `${habits.done}/${habits.due}` : "–"}
          detail={habits?.due ? (habits.done === habits.due ? "Done today" : "Today") : "None today"}
        >
          {habits && habits.due > 0 && <Dots done={habits.done} total={habits.due} />}
        </Tile>
        <Tile href="/insights" icon={LineChart} label="Insights" value={<LineChart aria-hidden className="size-[22px] text-accent" strokeWidth={2.2} />} detail="Your week" />
      </div>
    </nav>
  );
}

function Tile({
  href,
  icon: Icon,
  label,
  value,
  detail,
  alert,
  children,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail: string;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <Link href={href} className={cn(TILE, "min-h-[104px]")}>
      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2">
        <Icon className="size-4 shrink-0 text-ink-3 transition-colors group-hover:text-accent" strokeWidth={2} />
        <span className="truncate">{label}</span>
      </span>
      <span className="mt-auto pt-3">
        <span className="block text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">{value}</span>
        <span className={cn("mt-1.5 flex items-center gap-1.5 text-[12px]", alert ? "text-accent-ink" : "text-ink-3")}>
          {children}
          <span className="truncate">{detail}</span>
        </span>
      </span>
    </Link>
  );
}

function Dots({ done, total }: { done: number; total: number }) {
  const shown = Math.min(total, 5);
  return (
    <span aria-hidden className="flex shrink-0 gap-[3px]">
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className={cn("size-1.5 rounded-full", i < Math.min(done, shown) ? "bg-success" : "bg-border-strong")} />
      ))}
    </span>
  );
}
