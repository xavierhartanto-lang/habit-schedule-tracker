import { PageHeader, Skeleton } from "@/components/ui";
import { KnowledgeContent } from "@/features/context/knowledge-content";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "What Whitespace knows" };

export default function AboutYouPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="What Whitespace knows"
        description="Everything the assistant uses to understand your life. You decide what stays."
      />
      <Suspense
        fallback={
          <div className="space-y-6">
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        }
      >
        <KnowledgeContent />
      </Suspense>
    </div>
  );
}
