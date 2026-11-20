import { Skeleton } from "@/components/ui";
import { isSession } from "@/lib/proactive/analyze";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, startOfDayInZone } from "@/lib/scheduling/zoned";
import { loadHomeData } from "./home-data";
import { RailNote, RailSection } from "./rail-section";
import { TodayList } from "./today-list";

export function TodayScheduleSkeleton() {
  return (
    <RailSection title="Today">
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    </RailSection>
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
    sessionId: isSession(o.event) ? o.event.id : null,
    outcome: o.event.outcome ?? null,
  }));

  return (
    <RailSection title="Today" href="/calendar?view=day" hrefLabel="Calendar">
      {error ? (
        <RailNote tone="danger">Couldn&apos;t load today. Refresh to try again.</RailNote>
      ) : ctx.state !== "ready" ? (
        <RailNote>{ctx.state === "preview" ? "Preview mode: connect Supabase to see your day." : "Sign in to see your day."}</RailNote>
      ) : (
        <TodayList items={today} areas={ctx.areas} timeZone={ctx.timeZone} />
      )}
    </RailSection>
  );
}
