import { PageHeader } from "@/components/ui";
import { FlexibleTray } from "@/features/calendar/flexible-tray";
import { WeekCalendar } from "@/features/calendar/week-calendar";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Fixed commitments hold their place. Flexible work can move around them."
      />
      <WeekCalendar />
      <FlexibleTray />
    </div>
  );
}
