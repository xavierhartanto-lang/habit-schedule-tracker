import { PageHeader, Skeleton } from "@/components/ui";
import { HabitsContent } from "@/features/habits/habits-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Habits & Goals" };

export default function HabitsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Habits & Goals"
        description="Consistency over intensity. Track what you repeat and where it leads."
      />
      <Suspense
        fallback={
          <div className="space-y-8">
            <Skeleton className="h-72 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
        }
      >
        <HabitsContent />
      </Suspense>
    </div>
  );
}
