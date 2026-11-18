import { Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, startOfDayInZone } from "@/lib/scheduling/zoned";
import Link from "next/link";
import { loadHomeData } from "./home-data";
import { TodayList } from "./today-list";

export function TodayScheduleSkeleton() {
  return (
    <Card>
      <CardHeader title="Today" />
      <CardBody className="pt-3">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

/** Today's events from the calendar. Render inside <Suspense>. */
export async function TodaySchedule() {
  const { ctx, events, error } = await loadHomeData();
  const from = startOfDayInZone(ctx.todayKey, ctx.timeZone);
  const to = startOfDayInZone(addDaysToKey(ctx.todayKey, 1), ctx.timeZone);
  const today = expandEvents(events, from, to, ctx.timeZone).map((o) => ({
    key: o.key,
    title: o.event.title,
    location: o.event.location ?? null,
    kind: o.event.kind,
    allDay: o.allDay,
    start: o.start.toISOString(),
    end: o.end.toISOString(),
    areaId: o.event.lifeAreaId ?? null,
  }));

  return (
    <Card>
      <CardHeader
        title="Today"
        action={
          <Link href="/calendar?view=day" className="text-[12px] font-medium text-accent-ink hover:underline">
            Calendar
          </Link>
        }
      />
      <CardBody className="pt-3">
        {error ? (
          <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-danger">Could not load today. Refresh to try again.</p>
        ) : ctx.state !== "ready" ? (
          <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-ink-3">
            {ctx.state === "preview" ? "Preview mode: connect Supabase to see your day." : "Sign in to see your day."}
          </p>
        ) : (
          <TodayList items={today} areas={ctx.areas} timeZone={ctx.timeZone} />
        )}
      </CardBody>
    </Card>
  );
}
