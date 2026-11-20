"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Away at least this long before Home re-reads the plan. */
const AWAY_MS = 5 * 60_000;

/**
 * Home's adaptive sections are computed on the server from the clock and
 * the calendar. When the user comes back to a tab left open for a while,
 * re-read them so "Now", deadlines and warnings aren't stale. Client state
 * (the conversation, a draft) is kept: router.refresh only re-renders
 * server components. Never while the user is typing.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt !== null && Date.now() - hiddenAt >= AWAY_MS;
      hiddenAt = null;
      const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      if (away && !typing) router.refresh();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [router]);
  return null;
}
