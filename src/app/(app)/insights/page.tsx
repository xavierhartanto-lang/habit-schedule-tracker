import { PageHeader } from "@/components/ui";
import { DailyLoad } from "@/features/insights/daily-load";
import { Observations } from "@/features/insights/observations";
import { TimeAllocation } from "@/features/insights/time-allocation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Insights" description="A clear look at how your week actually went." />
      <TimeAllocation />
      <div className="grid gap-6 lg:grid-cols-2">
        <DailyLoad />
        <Observations />
      </div>
    </div>
  );
}
