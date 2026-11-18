"use client";

import { buttonClasses } from "@/components/ui/button";
import { useNow } from "@/lib/hooks/use-now";
import { cn } from "@/lib/utils/cn";
import { ChevronDown, Compass, MessageSquare, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteConversation } from "./actions";

export type ConversationSummary = {
  id: string;
  kind: "onboarding" | "assistant";
  title: string | null;
  lastMessageAt: string;
};

function hrefFor(c: ConversationSummary) {
  return c.kind === "onboarding" ? "/onboarding" : `/assistant?c=${c.id}`;
}

function titleFor(c: ConversationSummary) {
  return c.title ?? (c.kind === "onboarding" ? "Getting to know you" : "New conversation");
}

function RelativeDay({ iso }: { iso: string }) {
  const now = useNow();
  if (!now) return <span className="invisible">Today</span>;
  const then = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(then)) / 86_400_000);
  const label =
    diff <= 0
      ? then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : diff === 1
        ? "Yesterday"
        : diff < 7
          ? then.toLocaleDateString(undefined, { weekday: "short" })
          : then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return <time dateTime={iso}>{label}</time>;
}

/** Desktop sidebar with the user's saved conversations. */
export function ConversationHistory({
  conversations,
  activeId,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteConversation({ conversationId: id });
      setConfirming(null);
      if (!result.ok) {
        setError(result.error ?? "Couldn't delete that conversation.");
        return;
      }
      if (id === activeId) router.replace("/assistant");
      else router.refresh();
    });
  };

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border lg:flex" aria-label="Conversations">
      <div className="flex items-center justify-between px-4 py-3.5">
        <p className="text-[13px] font-semibold text-ink">Conversations</p>
        <Link
          href="/assistant"
          aria-label="New conversation"
          className="grid size-7 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Plus className="size-4" />
        </Link>
      </div>

      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 && (
          <li className="px-3 py-2 text-[12px] leading-relaxed text-ink-3">
            Your conversations are saved here, so you can pick up where you left off.
          </li>
        )}
        {conversations.map((c) => {
          const active = c.id === activeId;
          return (
            <li key={c.id} className="group relative">
              <Link
                href={hrefFor(c)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2 pr-9 transition-colors",
                  active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/60 hover:text-ink",
                )}
              >
                {c.kind === "onboarding" ? (
                  <Compass className="mt-0.5 size-3.5 shrink-0 text-accent" />
                ) : (
                  <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{titleFor(c)}</span>
                  <span className="block text-[11px] text-ink-3">
                    <RelativeDay iso={c.lastMessageAt} />
                  </span>
                </span>
              </Link>
              {c.kind === "assistant" &&
                (confirming === c.id ? (
                  <div className="mx-2 mb-1 flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2">
                    Delete chat?
                    <span className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="rounded px-1.5 py-0.5 hover:text-ink"
                        disabled={pending}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(c.id)}
                        className="rounded px-1.5 py-0.5 font-medium text-danger"
                        disabled={pending}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(c.id)}
                    aria-label={`Delete ${titleFor(c)}`}
                    className="absolute right-2 top-2 grid size-6 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity hover:bg-surface hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="px-4 pb-3 text-[12px] text-danger">{error}</p>}
      <p className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-ink-3">
        Deleting a chat keeps anything you saved from it.
      </p>
    </aside>
  );
}

/** Compact switcher for small screens, where the sidebar is hidden. */
export function ConversationSwitcher({
  conversations,
  activeId,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
}) {
  return (
    <div className="flex items-center gap-1.5 lg:hidden">
      {conversations.length > 0 && (
        <details className="relative">
          <summary
            className={buttonClasses("ghost", "sm", "list-none px-2 [&::-webkit-details-marker]:hidden")}
            aria-label="Your conversations"
          >
            <MessageSquare className="size-4" />
            <ChevronDown className="size-3.5" />
          </summary>
          <ul className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-card">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={hrefFor(c)}
                  className={cn(
                    "block rounded-lg px-3 py-2 text-[13px]",
                    c.id === activeId ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2",
                  )}
                >
                  <span className="block truncate font-medium">{titleFor(c)}</span>
                  <span className="block text-[11px] text-ink-3">
                    <RelativeDay iso={c.lastMessageAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Link href="/assistant" aria-label="New conversation" className={buttonClasses("secondary", "sm", "px-2")}>
        <Plus className="size-4" />
      </Link>
    </div>
  );
}
