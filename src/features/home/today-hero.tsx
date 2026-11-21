import { Skeleton } from "@/components/ui";
import { isSession } from "@/lib/proactive/analyze";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { addDaysToKey, startOfDayInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { loadHomeData } from "./home-data";
import { loadHomeIntel } from "./home-intel";
import { PlanDayButton } from "./plan-day-button";
import { TodaySummary, TodayTimeline } from "./today-timeline";

/**
 * "Your today": the hero of Home. Today's blocks on a timeline with what's
 * happening now and next, and the one action that matters most here:
 * Plan my day with AI. Render inside <Suspense>.
 */

const HERO =
  "relative isolate min-w-0 overflow-hidden rounded-[28px] border border-border/70 bg-surface p-5 shadow-card dark:border-border sm:p-7 lg:p-8";

/** A faint violet light from the top corner: depth without decoration. */
function Glow() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -right-24 -top-32 -z-10 size-[420px] rounded-full bg-[radial-gradient(closest-side,var(--accent),transparent)] opacity-[0.10] dark:opacity-[0.16]"
    />
  );
}

function Head({ summary, action }: { summary: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[22px] font-bold leading-tight tracking-[-0.025em] text-ink sm:text-[26px]">
          Your today
        </h2>
        {summary}
      </div>
      {action}
    </div>
  );
}

export function TodayHeroSkeleton() {
  return (
    <section className={HERO} aria-label="Your today">
      <Head summary={<Skeleton className="mt-2 h-4 w-56" />} action={<Skeleton className="h-11 w-full rounded-2xl sm:w-52" />} />
      <div className="mt-7 space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 rounded-2xl" />
        ))}
      </div>
    </section>
  );
}

export async function TodayHero({ className }: { className?: string }) {
  const [{ ctx, events, error }, intel] = await Promise.all([loadHomeData(), loadHomeIntel()]);

  if (ctx.state !== "ready" || error) {
    const note = error
      ? "Couldn't load today. Refresh to try again."
      : ctx.state === "preview"
        ? "Preview mode: connect Supabase to see your day."
        : "Sign in to see your day.";
    return (
      <section className={cn(HERO, className)} aria-label="Your today">
        <Glow />
        <Head summary={<p className={cn("mt-1.5 text-[14px]", error ? "text-danger" : "text-ink-3")}>{note}</p>} />
      </section>
    );
  }

  const tz = ctx.timeZone;
  const from = startOfDayInZone(ctx.todayKey, tz);
  const to = startOfDayInZone(addDaysToKey(ctx.todayKey, 1), tz);
  const items = expandEvents(events, from, to, tz).map((o) => ({
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

  // The engine's own wording: "Plan my day", or "Plan tomorrow" once today has no real time left.
  const planLabel = intel.proactive?.today?.action?.label ?? "Plan my day";

  return (
    <section className={cn(HERO, "animate-fade-up", className)} aria-labelledby="your-today">
      <Glow />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="your-today" className="text-[22px] font-bold leading-tight tracking-[-0.025em] text-ink sm:text-[26px]">
            Your today
          </h2>
          <TodaySummary items={items} timeZone={tz} />
        </div>
        <PlanDayButton label={planLabel} className="w-full sm:w-auto" />
      </div>

      <div className="mt-6 sm:mt-7">
        <TodayTimeline items={items} areas={ctx.areas} timeZone={tz} />
      </div>

      <div className="mt-5 flex justify-end">
        <Link
          href="/calendar?view=day"
          className="-my-2 inline-flex items-center gap-1 rounded px-1 py-2 text-[12.5px] font-medium text-ink-3 transition-colors hover:text-accent-ink"
        >
          Open in Calendar <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
