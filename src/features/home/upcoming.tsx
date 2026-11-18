import { Card, CardBody, CardHeader, LifeAreaDot } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import { dueParts } from "@/lib/domain/tasks";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, formatDateKey, formatTimeInZone, startOfDayInZone } from "@/lib/scheduling/zoned";
import { CalendarDays, CircleCheck } from "lucide-react";
import { LOOKAHEAD_DAYS, loadHomeData } from "./home-data";

function relativeDay(n: number, key: string) {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 7) return formatDateKey(key, { weekday: "long" });
  return formatDateKey(key, { weekday: "short", month: "short", day: "numeric" });
}

type Item = { id: string; title: string; when: string; sort: number; areaId: string | null; kind: "event" | "task" };

/** One-off fixed commitments and task due dates in the next two weeks. Weekly routines are left out. Render inside <Suspense>. */
export async function Upcoming() {
  const { ctx, events, openTasks } = await loadHomeData();
  const tz = ctx.timeZone;
  const from = startOfDayInZone(addDaysToKey(ctx.todayKey, 1), tz);
  const to = startOfDayInZone(addDaysToKey(ctx.todayKey, LOOKAHEAD_DAYS + 1), tz);

  const items: Item[] = [];
  for (const o of expandEvents(events, from, to, tz)) {
    if (o.event.kind !== "fixed" || o.event.recurrenceRule) continue;
    const key = dateKeyInZone(o.start, tz);
    const days = daysBetweenKeys(ctx.todayKey, key);
    items.push({
      id: o.key,
      title: o.event.title,
      when: `${relativeDay(days, key)} · ${o.allDay ? "All day" : formatTimeInZone(o.start, tz)}`,
      sort: o.start.getTime(),
      areaId: o.event.lifeAreaId ?? null,
      kind: "event",
    });
  }
  for (const t of openTasks) {
    const due = dueParts(t.dueAt, tz);
    if (!due) continue;
    const days = daysBetweenKeys(ctx.todayKey, due.date);
    if (days < 0 || days > LOOKAHEAD_DAYS) continue;
    items.push({
      id: t.id,
      title: t.title,
      when: `Due ${days < 2 ? relativeDay(days, due.date).toLowerCase() : relativeDay(days, due.date)}`,
      sort: Date.parse(t.dueAt!),
      areaId: t.lifeAreaId ?? null,
      kind: "task",
    });
  }
  items.sort((a, b) => a.sort - b.sort);
  const shown = items.slice(0, 5);

  return (
    <Card>
      <CardHeader title="Coming up" description="Next 2 weeks" />
      <CardBody className="pt-3">
        {shown.length === 0 ? (
          <p className="rounded-xl bg-surface-2 px-4 py-5 text-center text-[13px] text-ink-3">
            {ctx.state === "ready" ? "No deadlines or one-off events in the next two weeks." : "Sign in to see what's coming up."}
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
