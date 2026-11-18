import { AssistantQuickAccess } from "@/features/home/assistant-quick-access";
import { FirstName } from "@/features/home/first-name";
import { Greeting } from "@/features/home/greeting";
import { PriorityTasks } from "@/features/home/priority-tasks";
import { TodaySchedule } from "@/features/home/today-schedule";
import { Upcoming } from "@/features/home/upcoming";
import { OnboardingRedirect } from "@/features/onboarding/onboarding-redirect";
import { Suspense } from "react";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <OnboardingRedirect />
      </Suspense>
      <Greeting
        name={
          <Suspense fallback={null}>
            <FirstName />
          </Suspense>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <TodaySchedule />
        </div>
        <div className="min-w-0 space-y-6">
          <AssistantQuickAccess />
          <Upcoming />
        </div>
      </div>

      <PriorityTasks />
    </div>
  );
}
