import { PageHeader, Skeleton } from "@/components/ui";
import { AreasContent } from "@/features/areas/areas-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Life areas" };

export default function AreasPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Life areas"
        description="The parts of your life you organize around. Each one has a color across the app."
      />
      <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}>
        <AreasContent />
      </Suspense>
    </div>
  );
}
