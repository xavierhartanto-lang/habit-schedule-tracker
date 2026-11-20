import { Notice } from "@/components/ui";
import { listEventsForRange } from "@/lib/db/events";
import type { Commitment } from "@/lib/domain/types";
import { addDaysToKey, isDateKey, monthGridKeys, startOfDayInZone, weekKeys } from "@/lib/scheduling/zoned";
import { loadPlanningContext } from "@/features/shared/planning-context";
import { CalendarView, type CalendarViewMode } from "./calendar-view";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Loads the visible range for ?view=day|week|month&date=YYYY-MM-DD. Render inside <Suspense>. */
export async function CalendarContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let ctx;
  try {
    ctx = await loadPlanningContext();
  } catch {
    return <Notice tone="danger">Could not load your calendar. Refresh to try again.</Notice>;
  }

  const viewParam = first(params.view);
  const view: CalendarViewMode = viewParam === "day" || viewParam === "month" ? viewParam : "week";
  const dateParam = first(params.date);
  const date = isDateKey(dateParam) ? dateParam : ctx.todayKey;

  const keys =
    view === "day" ? [date] : view === "week" ? weekKeys(date, ctx.weekStartsOn) : monthGridKeys(date, ctx.weekStartsOn);
  // One day of padding on each side covers events that cross midnight.
  const from = startOfDayInZone(addDaysToKey(keys[0], -1), ctx.timeZone).toISOString();
  const to = startOfDayInZone(addDaysToKey(keys[keys.length - 1], 2), ctx.timeZone).toISOString();

  let events: Commitment[] = [];
  let unplaced: Commitment[] = [];
  let loadError = false;
  if (ctx.state === "ready") {
    try {
      ({ events, unplaced } = await listEventsForRange(ctx.userId, { from, to }));
    } catch {
      loadError = true;
    }
  }

  return (
    <div className="space-y-4">
      {ctx.state === "preview" && <Notice>Preview mode: connect Supabase to create and save events.</Notice>}
      {ctx.state === "signed-out" && <Notice>Sign in to see and plan your calendar.</Notice>}
      {loadError && <Notice tone="danger">Could not load events. Refresh to try again.</Notice>}
      <CalendarView
        view={view}
        viewChosen={viewParam !== undefined}
        weekStartsOn={ctx.weekStartsOn}
        date={date}
        dayKeys={keys}
        events={events}
        unplaced={unplaced}
        areas={ctx.areas}
        timeZone={ctx.timeZone}
        todayKey={ctx.todayKey}
        disabled={ctx.state !== "ready" || loadError}
      />
    </div>
  );
}
