import { cache, Suspense } from "react";
import { cn } from "@/lib/utils/cn";
import { loadHomeData } from "@/features/home/home-data";
import { loadHomeIntel } from "@/features/home/home-intel";
import { BriefingCard, BriefingSummary } from "./briefing-card";
import { briefingOnHome, briefingSummary, loadBriefing, type BriefingView, type InsightsCtx } from "./server/weekly";

/**
 * Home's weekly briefing (Phase 7.6): the last evening of the week, or the
 * first days of a new one, until the user closes it or a day after it was
 * first shown. Reuses Home's engine load. Render inside <Suspense>.
 */
const homeView = cache(async (): Promise<{ view: BriefingView; ctx: InsightsCtx } | null> => {
  const [{ ctx, error }, intel] = await Promise.all([loadHomeData(), loadHomeIntel()]);
  if (ctx.state !== "ready" || error || !intel.analysis) return null;
  const c: InsightsCtx = { userId: ctx.userId, timeZone: ctx.timeZone, weekStartsOn: ctx.weekStartsOn, todayKey: ctx.todayKey, areas: ctx.areas };
  const view = await loadBriefing(c, {
    now: intel.now,
    engine: { analysis: intel.analysis, recommendations: intel.proactive?.recommendations ?? [] },
    onlyForHome: true,
  }).catch((e) => {
    console.error("[home] weekly briefing failed", e);
    return null;
  });
  if (!view || !briefingOnHome(view, intel.now)) return null;
  return { view, ctx: c };
});

/** Phones and tablets show it in the glance hub, desktop at the top of the rail: one render each, one load. */
export async function HomeBriefing({ className }: { className?: string }) {
  const r = await homeView();
  if (!r) return null;
  return (
    <div className={cn("min-w-0", className)}>
      <BriefingFor view={r.view} ctx={r.ctx} variant="home" />
    </div>
  );
}

/** One AI call per request, however many places show the summary. */
const cachedSummary = cache((ctx: InsightsCtx, view: BriefingView) => briefingSummary(ctx, view).catch(() => null));

/** The card with its facts now and the AI summary streamed in when it's ready. */
export function BriefingFor({ view, ctx, variant }: { view: BriefingView; ctx: InsightsCtx; variant: "home" | "insights" }) {
  return (
    <BriefingCard
      weekStart={view.window.weekStart}
      heading={view.heading}
      headline={view.headline}
      preview={view.window.preview}
      visual={variant === "home" ? view.compactVisual : view.visual}
      days={view.facts.days}
      actions={view.facts.actions}
      empty={view.facts.empty}
      tracked={view.tracked}
      variant={variant}
      summary={
        <Suspense fallback={null}>
          <SummarySlot view={view} ctx={ctx} />
        </Suspense>
      }
    />
  );
}

async function SummarySlot({ view, ctx }: { view: BriefingView; ctx: InsightsCtx }) {
  const text = await cachedSummary(ctx, view);
  return <BriefingSummary text={text} />;
}
