"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { autoSyncGoogle } from "@/features/google/actions";

const KEY = "ws-google-sync-at";
const EVERY_MS = 5 * 60_000;

/**
 * Keeps imported Google events fresh without a button. At most every few
 * minutes per tab; the server skips the work when the last sync is under
 * 15 minutes old, and does nothing for people who never connected Google.
 */
export function GoogleSync() {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      try {
        const last = Number(sessionStorage.getItem(KEY) ?? 0);
        if (Date.now() - last < EVERY_MS) return;
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        // Storage blocked: the server-side freshness check still applies.
      }
      void autoSyncGoogle()
        .then((r) => {
          if (r.changed) router.refresh();
        })
        .catch(() => undefined);
    };
    tick();
    const onFocus = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [router]);
  return null;
}
