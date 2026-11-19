"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { adoptBrowserTimeZone } from "@/features/shared/timezone-actions";

/** Once per browser session: if the profile is still on the UTC default, use this device's zone. */
export function TimeZoneSync() {
  const router = useRouter();
  useEffect(() => {
    let tz: string | undefined;
    try {
      if (sessionStorage.getItem("ws-tz-checked")) return;
      sessionStorage.setItem("ws-tz-checked", "1");
    } catch {
      // Storage blocked: still check once for this page view.
    }
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!tz) return;
    void adoptBrowserTimeZone(tz)
      .then((r) => {
        if (r.changed) router.refresh();
      })
      .catch(() => undefined);
  }, [router]);
  return null;
}
