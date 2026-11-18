import { Card, CardBody, CardHeader, LifeAreaDot } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import { dueParts } from "@/lib/domain/tasks";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, formatTimeInZone, startOfDayInZone } from "@/lib/scheduling/zoned";
import { CalendarDays, CircleCheck } from "lucide-react";
import { HOME_DAYS_AHEAD, loadHomeData } from "./home-data";

function relativeDay(n: number) {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  return `In ${n} days`;
}

type Item = { id: string; title: string; when: string; sort: number; areaId: string | null; kind: "event" | "task" };

/** Next week's fixed commitments and task due dates. Render inside <Suspense>. */
export async function Upcoming() {
  const { ctx, events, openTasks } = await loadHomeData();
  const tz = ctx.timeZone;
  const from = startOfDayInZone(addDaysToKey(ctx.todayKey, 1), tz);
  const to = startOfDayInZone(addDaysToKey(ctx.todayKey, HOME_DAYS_AHEAD + 1), tz);

  const items: Item[] = [];
  for (const o of expandEvents(events, from, to, tz)) {
    if (o.event.kind !== "fixed") continue;
    const days = daysBetweenKeys(ctx.todayKey, dateKeyInZone(o.start, tz));
    items.push({
      id: o.key,
      title: o.event.title,
      when: `${relativeDay(days)} · ${o.allDay ? "All day" : formatTimeInZone(o.start, tz)}`,
      sort: o.start.getTime(),
      areaId: o.event.lifeAreaId ?? null,
      kind: "event",
    });
  }
  for (const t of openTasks) {
    const due = dueParts(t.dueAt, tz);
    if (!due) continue;
    const days = daysBetweenKeys(ctx.todayKey, due.date);
    if (days < 0 || days > HOME_DAYS_AHEAD) continue;
    items.push({
      id: t.id,
      title: t.title,
      when: `Due ${relativeDay(days).toLowerCase()}`,
      sort: Date.parse(t.dueAt!),
      areaId: t.lifeAreaId ?? null,
      kind: "task",
    });
  }
  items.sort((a, b) => a.sort - b.sort);
  const shown = items.slice(0, 5);

  return (
    <Card>
      <CardHeader title="Coming up" description="Next 7 days" />
      <CardBody className="pt-3">
        {shown.length === 0 ? (
          <p className="rounded-xl bg-surface-2 px-4 py-5 text-center text-[13px] text-ink-3">
            {ctx.state === "ready" ? "Nothing scheduled in the next 7 days." : "Sign in to see what's coming up."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((u) => (
              <li key={`${u.kind}:${u.id}`} className="flex items-start gap-3 py-3 first:pt-1 last:pb-0">
                <LifeAreaDot area={findArea(ctx.areas, u.areaId)} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug text-ink">{u.title}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-3">
                    {u.kind === "event" ? <CalendarDays className="size-3" /> : <CircleCheck className="size-3" />}
                    {u.when}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
