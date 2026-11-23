import { PageHeader, Skeleton } from "@/components/ui";
import { AutomationsContent } from "@/features/automations/automations-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Automations" };

export default function AutomationsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <PageHeader
        title="Automations"
        description="Weekly reminders and emails when something is booked. Whitespace sends them for you."
      />
      <Suspense fallback={<Skeleton className="h-72 rounded-2xl" />}>
        <AutomationsContent />
      </Suspense>
    </div>
  );
}
