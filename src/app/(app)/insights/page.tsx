import { PageHeader, Skeleton } from "@/components/ui";
import { InsightsContent } from "@/features/insights/insights-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Insights" description="A clear look at how your week is actually going." />
      <Suspense
        fallback={
          <div className="space-y-5">
            <Skeleton className="h-48 rounded-[20px]" />
            <Skeleton className="h-64 rounded-[20px]" />
            <div className="grid gap-5 lg:grid-cols-2">
              <Skeleton className="h-64 rounded-[20px]" />
              <Skeleton className="h-64 rounded-[20px]" />
            </div>
          </div>
        }
      >
        <InsightsContent />
      </Suspense>
    </div>
  );
}
