import { Skeleton } from "@/components/ui";
import { AdaptiveLead, AdaptiveRail } from "@/features/home/adaptive/adaptive-rail";
import { GlanceSkeleton, HomeGlance } from "@/features/home/glance";
import { HomeAssistant, HomeAssistantSkeleton } from "@/features/home/home-assistant";
import { HomeBriefing } from "@/features/insights/home-briefing";
import { PriorityTasks } from "@/features/home/priority-tasks";
import { RailSection } from "@/features/home/rail-section";
import { RefreshOnReturn } from "@/features/home/refresh-on-return";
import { TodaySchedule, TodayScheduleSkeleton } from "@/features/home/today-schedule";
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
 * Home is the assistant, in a hybrid layout (Phase 7.1):
 *  - Stable workspace: greeting + week tiles, the conversation, Today and
 *    Tasks in the rail, navigation. Always in the same place.
 *  - Adaptive sections between Today and Tasks: chosen by
 *    features/home/adaptive/select.ts from the Phase 5 engine's output,
 *    in fixed slots, only when they matter.
 * Below xl the rail drops under the conversation as two columns, and the
 * lead adaptive section moves up into the glance hub.
 */
export default function HomePage(props: PageProps<"/">) {
  return (
    <div className="grid gap-4 lg:gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Suspense fallback={null}>
        <OnboardingRedirect />
      </Suspense>
      <RefreshOnReturn />

      <div className="flex min-w-0 flex-col">
        <Suspense fallback={<HomeAssistantSkeleton />}>
          <HomeAssistantFromParams searchParams={props.searchParams} />
        </Suspense>
      </div>

      <aside
        aria-label="Your schedule at a glance"
        className="grid min-w-0 content-start gap-4 sm:grid-cols-2 lg:gap-5 xl:sticky xl:top-3 xl:max-h-[calc(100dvh-1.5rem)] xl:grid-cols-1 xl:self-start xl:overflow-y-auto xl:rounded-[20px] xl:pb-1"
      >
        <Suspense fallback={null}>
          <HomeBriefing className="max-xl:hidden" />
        </Suspense>
        <Suspense fallback={<TodayScheduleSkeleton />}>
          <TodaySchedule />
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

async function HomeAssistantFromParams({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { new: fresh } = await searchParams;
  return (
    <HomeAssistant
      fresh={fresh === "1"}
      glance={
        <>
          <Suspense fallback={<GlanceSkeleton />}>
            <HomeGlance />
          </Suspense>
          <Suspense fallback={null}>
            <HomeBriefing className="xl:hidden" />
          </Suspense>
          <Suspense fallback={null}>
            <AdaptiveLead />
          </Suspense>
        </>
      }
    />
  );
}
