import { PageHeader, Skeleton } from "@/components/ui";
import { TasksContent } from "@/features/tasks/tasks-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Tasks" };

export default function TasksPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Tasks" description="Things to get done. Separate from your calendar, sorted your way." />
      <Suspense
        fallback={
          <div className="space-y-4">
            <Skeleton className="h-14 rounded-2xl" />
            <Skeleton className="h-96 rounded-2xl" />
          </div>
        }
      >
        <TasksContent />
      </Suspense>
    </div>
  );
}
