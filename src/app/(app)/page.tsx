import { Skeleton } from "@/components/ui";
import { AdaptiveRail } from "@/features/home/adaptive/adaptive-rail";
import { HomeTop, HomeTopSkeleton } from "@/features/home/home-assistant";
import { HomeBriefing } from "@/features/insights/home-briefing";
import { PriorityTasks } from "@/features/home/priority-tasks";
import { RailSection } from "@/features/home/rail-section";
import { RefreshOnReturn } from "@/features/home/refresh-on-return";
import { TodayHero, TodayHeroSkeleton } from "@/features/home/today-hero";
import { OnboardingRedirect } from "@/features/onboarding/onboarding-redirect";
import { Suspense } from "react";

function SectionSkeleton({ title }: { title: string }) {
  return (
    <RailSection title={title}>
      <div className="space-y-2">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    </RailSection>
  );
}

/**
 * Home is today, and nothing else (calm daily view):
 *  - Top: date, weather, greeting, quote of the day, and the AI button that
 *    opens the assistant as a sheet. No chat log on the page.
 *  - Hero: "Your today", a timeline of today's blocks with now and next,
 *    and "Plan my day with AI" (the existing Plan my day flow).
 *  - Beside it (below it on phones): what the engine thinks matters now
 *    (Phase 7 adaptive sections), the weekly briefing when it's due, and
 *    the tasks to do next. Their buttons run in the assistant sheet.
 * Other tabs show what Home and the assistant organized.
 */
export default function HomePage(props: PageProps<"/">) {
  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-5 pb-4 sm:gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Suspense fallback={null}>
        <OnboardingRedirect />
      </Suspense>
      <RefreshOnReturn />

      <div className="min-w-0 xl:col-span-2">
        <Suspense fallback={<HomeTopSkeleton />}>
          <HomeTopFromParams searchParams={props.searchParams} />
        </Suspense>
      </div>

      <Suspense fallback={<TodayHeroSkeleton />}>
        <TodayHero className="xl:self-start" />
      </Suspense>

      <aside
        aria-label="What matters today"
        className="grid min-w-0 content-start gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-1"
      >
        <Suspense fallback={null}>
          <HomeBriefing />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title="What matters now" />}>
          <AdaptiveRail />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title="Tasks" />}>
          <PriorityTasks />
        </Suspense>
      </aside>
    </div>
  );
}

async function HomeTopFromParams({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { new: fresh } = await searchParams;
  return <HomeTop fresh={fresh === "1"} />;
}
