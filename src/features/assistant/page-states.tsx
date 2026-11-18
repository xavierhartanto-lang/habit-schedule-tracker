import { buttonClasses } from "@/components/ui/button";
import { Skeleton } from "@/components/ui";
import { Database, LogIn, SearchX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** Full-area states for the chat screens: honest about what is missing. */
export function ChatPageState({
  state,
  message,
}: {
  state: "no_storage" | "signed_out" | "not_found" | "error";
  message?: string;
}) {
  const content: Record<typeof state, { icon: ReactNode; title: string; body: string; action?: ReactNode }> = {
    no_storage: {
      icon: <Database className="size-5" />,
      title: "Conversations need a database",
      body: "Add your Supabase URL and publishable key to the environment, then restart. Until then nothing can be saved, so the assistant stays off.",
    },
    signed_out: {
      icon: <LogIn className="size-5" />,
      title: "Sign in to continue",
      body: "Your conversations and what Whitespace knows are private to your account.",
      action: (
        <Link href="/login" className={buttonClasses("primary", "sm")}>
          Sign in
        </Link>
      ),
    },
    not_found: {
      icon: <SearchX className="size-5" />,
      title: "Conversation not found",
      body: "It may have been deleted.",
      action: (
        <Link href="/assistant" className={buttonClasses("secondary", "sm")}>
          Start a new one
        </Link>
      ),
    },
    error: {
      icon: <TriangleAlert className="size-5" />,
      title: "Something went wrong",
      body: message ?? "Refresh to try again.",
    },
  };
  const c = content[state];
  return (
    <div className="grid h-full place-items-center px-6 py-16">
      <div className="max-w-sm text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-xl bg-surface-2 text-ink-3">{c.icon}</span>
        <h2 className="mt-4 text-[15px] font-semibold text-ink">{c.title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{c.body}</p>
        {c.action && <div className="mt-4">{c.action}</div>}
      </div>
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="size-7 rounded-lg" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/2 rounded-2xl" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="size-7 rounded-lg" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      </div>
    </div>
  );
}
