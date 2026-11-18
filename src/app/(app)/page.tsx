import { Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { HomeAssistant, HomeAssistantSkeleton } from "@/features/home/home-assistant";
import { PriorityTasks } from "@/features/home/priority-tasks";
import { TodaySchedule, TodayScheduleSkeleton } from "@/features/home/today-schedule";
import { Upcoming } from "@/features/home/upcoming";
import { WeekGlance } from "@/features/home/week-glance";
import { OnboardingRedirect } from "@/features/onboarding/onboarding-redirect";
import { Suspense } from "react";

function SectionSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="space-y-2">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </CardBody>
    </Card>
  );
}

/**
 * Home is the assistant. The conversation sits at the center; a light
 * overview of today, what's coming up and open tasks sits beside it.
 */
export default function HomePage(props: PageProps<"/">) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:gap-8">
      <Suspense fallback={null}>
        <OnboardingRedirect />
      </Suspense>

      <div className="min-w-0">
        <Suspense fallback={<HomeAssistantSkeleton />}>
          <HomeAssistantFromParams searchParams={props.searchParams} />
        </Suspense>
      </div>

      <aside aria-label="Your schedule at a glance" className="min-w-0 space-y-4 lg:pt-[76px]">
        <Suspense fallback={<TodayScheduleSkeleton />}>
          <TodaySchedule />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title="Coming up" />}>
          <Upcoming />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title="Tasks" />}>
          <PriorityTasks />
        </Suspense>
        <Suspense fallback={null}>
          <WeekGlance />
        </Suspense>
      </aside>
    </div>
  );
}

async function HomeAssistantFromParams({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { new: fresh } = await searchParams;
  return <HomeAssistant fresh={fresh === "1"} />;
}
