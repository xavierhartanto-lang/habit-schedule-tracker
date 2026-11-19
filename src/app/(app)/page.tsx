import { Skeleton } from "@/components/ui";
import { HomeAssistant, HomeAssistantSkeleton } from "@/features/home/home-assistant";
import { PriorityTasks } from "@/features/home/priority-tasks";
import { RailSection } from "@/features/home/rail-section";
import { TodaySchedule, TodayScheduleSkeleton } from "@/features/home/today-schedule";
import { Upcoming } from "@/features/home/upcoming";
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
 * Home is the assistant. The brief, what needs attention and the
 * conversation fill the main column; a quiet rail beside it holds today's
 * schedule, what's coming up and open tasks. Below xl the rail drops under
 * the conversation as two columns.
 */
export default function HomePage(props: PageProps<"/">) {
  return (
    <div className="grid gap-x-12 gap-y-12 xl:grid-cols-[minmax(0,1fr)_288px]">
      <Suspense fallback={null}>
        <OnboardingRedirect />
      </Suspense>

      <div className="flex min-w-0 flex-col">
        <Suspense fallback={<HomeAssistantSkeleton />}>
          <HomeAssistantFromParams searchParams={props.searchParams} />
        </Suspense>
      </div>

      <aside
        aria-label="Your schedule at a glance"
        className="grid min-w-0 content-start gap-10 border-t border-border pt-10 sm:grid-cols-2 sm:gap-x-10 xl:sticky xl:top-10 xl:max-h-[calc(100dvh-5rem)] xl:grid-cols-1 xl:self-start xl:overflow-y-auto xl:-mr-2 xl:border-l xl:border-t-0 xl:pb-6 xl:pl-10 xl:pr-2 xl:pt-1"
      >
        <Suspense fallback={<TodayScheduleSkeleton />}>
          <TodaySchedule />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title="Coming up" />}>
          <Upcoming />
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
  return <HomeAssistant fresh={fresh === "1"} />;
}
