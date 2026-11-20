"use client";

import { ChipRow } from "@/features/assistant/proactive-nudges";
import { markRecommendationsShown } from "@/features/proactive/actions";
import { cn } from "@/lib/utils/cn";
import { useEffect, useState } from "react";
import type { Nudge } from "../proactive";
import { sendToHomeChat } from "./home-bridge";

/**
 * Engine suggestions in the rail. Styled like flexible (unsaved) items:
 * dashed, labelled "Suggestion". A button never changes anything here; it
 * goes to the conversation, which answers with an approval card.
 */
export function SuggestionItems({ items, compact = false }: { items: Nudge[]; compact?: boolean }) {
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const key = items.map((n) => n.id).join(",");

  // Start the cooldown for what the rail showed, once per page view (Phase 5 markShown).
  useEffect(() => {
    if (!key) return;
    void markRecommendationsShown({ ids: key.split(",") }).catch(() => undefined);
  }, [key]);

  const visible = items.filter((n) => !handled.has(n.id));
  if (!visible.length) return <p className="text-[13px] text-ink-3">Handled. Check the conversation for anything to approve.</p>;

  return (
    <ul className="space-y-2.5">
      {visible.map((n) => (
        <li
          key={n.id}
          className={cn(
            "animate-fade-up rounded-2xl border border-dashed px-3.5 py-3",
            n.tone === "warning" ? "border-[color-mix(in_oklab,var(--cat-creative)_55%,transparent)]" : "border-border-strong",
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Suggestion</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink text-pretty">{n.message}</p>
          {!compact && n.facts.length > 0 && <p className="mt-1 text-[12px] tabular-nums text-ink-3">{n.facts.join(" · ")}</p>}
          <ChipRow
            chips={n.chips}
            className="mt-2.5"
            onAct={(chip) => {
              setHandled((h) => new Set(h).add(n.id));
              sendToHomeChat({ chip, nudge: n });
            }}
          />
        </li>
      ))}
    </ul>
  );
}
