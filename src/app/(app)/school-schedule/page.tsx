import { PageHeader, Skeleton } from "@/components/ui";
import { SchoolScheduleSetup } from "@/features/school-schedule/school-schedule-setup";
import { loadSchoolSchedule } from "@/features/school-schedule/server";
import { isAiConfigured } from "@/lib/ai/config";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "School schedule" };

export default function SchoolSchedulePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="School schedule" description="Your bell times. Plans never land in class." />
      <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}>
        <SchoolScheduleContent />
      </Suspense>
    </div>
  );
}

async function SchoolScheduleContent() {
  const data = await loadSchoolSchedule();
  if (data.state !== "ready") {
    return (
      <div className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2">
        {data.state === "signed_out"
          ? "Sign in to set up your school schedule."
          : "School schedules aren't available yet. The database needs its latest update."}
      </div>
    );
  }
  const { stored, profileSchool } = data;
  return (
    <SchoolScheduleSetup
      variant="settings"
      aiConfigured={isAiConfigured()}
      initialSchool={stored.status === "none" ? profileSchool : (stored.school ?? profileSchool)}
      initialDistrict={stored.status === "none" ? null : stored.district}
      initialSchedule={stored.status === "saved" ? stored.schedule : null}
    />
  );
}
