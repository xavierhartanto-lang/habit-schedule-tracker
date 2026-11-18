import { PageHeader, Skeleton } from "@/components/ui";
import { CalendarContent } from "@/features/calendar/calendar-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Fixed commitments hold their place. Flexible activities can move around them."
      />
      <Suspense fallback={<Skeleton className="h-[640px] rounded-2xl" />}>
        <CalendarContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
