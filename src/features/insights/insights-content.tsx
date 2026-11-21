import { Notice } from "@/components/ui";
import { unstable_rethrow } from "next/navigation";
import { observations } from "@/lib/insights/observations";
import { loadPlanningContext, type PlanningContext } from "@/features/shared/planning-context";
import { BriefingFor } from "./home-briefing";
import { DailyLoad, GoalsLens, Observations, SessionsReality, TimeAllocation, WeekStats } from "./sections";
import { loadInsights, type InsightsCtx, type InsightsData } from "./server/weekly";

/** Insights (Phase 7.6): real numbers only. Render inside <Suspense>. */
export async function InsightsContent() {
  let ctx: PlanningContext;
  let data: InsightsData | null = null;
  try {
    ctx = await loadPlanningContext();
    if (ctx.state === "ready") {
      data = await loadInsights({ userId: ctx.userId, timeZone: ctx.timeZone, weekStartsOn: ctx.weekStartsOn, todayKey: ctx.todayKey, areas: ctx.areas });
    }
  } catch (error) {
    unstable_rethrow(error); // Let Next handle its own prerender signals.
    console.error("[insights] load failed", error);
    return <Notice tone="danger">Couldn&apos;t load your insights. Refresh to try again.</Notice>;
  }
  if (ctx.state === "preview") return <Notice>Preview mode: connect Supabase to see insights from your own week.</Notice>;
  if (ctx.state !== "ready" || !data) return <Notice>Sign in to see how your week is going.</Notice>;

  const c: InsightsCtx = { userId: ctx.userId, timeZone: ctx.timeZone, weekStartsOn: ctx.weekStartsOn, todayKey: ctx.todayKey, areas: ctx.areas };
  return (
    <div className="space-y-5 lg:space-y-6">
      <WeekStats thisWeek={data.thisWeek} lastWeek={data.lastWeek} />
      {data.briefing && <BriefingFor view={data.briefing} ctx={c} variant="insights" />}
      <TimeAllocation thisWeek={data.thisWeek} lastWeek={data.lastWeek} todayKey={ctx.todayKey} />
      <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
        <DailyLoad week={data.thisWeek} todayKey={ctx.todayKey} />
        <SessionsReality totals={data.thisWeek.totals} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
        <Observations items={observations(data.thisWeek, data.lastWeek, ctx.todayKey)} />
        <GoalsLens goals={data.goals} areas={ctx.areas} />
      </div>
    </div>
  );
}
