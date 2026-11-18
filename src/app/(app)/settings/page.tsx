import { PageHeader, Skeleton } from "@/components/ui";
import { SettingsContent } from "@/features/settings/settings-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" description="Your profile, planning preferences and privacy." />
      <Suspense
        fallback={
          <div className="space-y-6">
            <Skeleton className="h-72 rounded-2xl" />
            <Skeleton className="h-48 rounded-2xl" />
          </div>
        }
      >
        <SettingsContent />
      </Suspense>
    </div>
  );
}
