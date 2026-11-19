import { LifeAreaDot } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import { dueParts } from "@/lib/domain/tasks";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, formatDateKey, formatTimeInZone, startOfDayInZone } from "@/lib/scheduling/zoned";
import { CalendarDays, CircleCheck } from "lucide-react";
import { LOOKAHEAD_DAYS, loadHomeData } from "./home-data";
import { RailNote, RailSection } from "./rail-section";

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
    <RailSection title="Coming up" meta="2 weeks">
      {shown.length === 0 ? (
        <RailNote>
          {ctx.state === "ready" ? "No deadlines or one-off events in the next two weeks." : "Sign in to see what's coming up."}
        </RailNote>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((u) => (
            <li key={`${u.kind}:${u.id}`} className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-1.5">
              <LifeAreaDot area={findArea(ctx.areas, u.areaId)} className="mt-[7px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] leading-snug text-ink">{u.title}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[12px] tabular-nums text-ink-3">
                  {u.kind === "event" ? <CalendarDays aria-hidden className="size-3" /> : <CircleCheck aria-hidden className="size-3" />}
                  {u.when}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}
