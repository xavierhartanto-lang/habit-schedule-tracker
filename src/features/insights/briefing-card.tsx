"use client";

import { ChipRow } from "@/features/assistant/proactive-nudges";
import { sendToHomeChat } from "@/features/home/adaptive/home-bridge";
import type { ProactiveChip } from "@/features/home/proactive";
import type { BriefingAction, BriefingDay } from "@/lib/insights/weekly";
import { duration } from "@/lib/proactive/text";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { CalendarRange, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { dismissBriefing, markBriefingShown } from "./actions";

/**
 * Phase 7.6 weekly briefing card. The facts are always there; the short AI
 * summary (a server-rendered slot) sits on top when it exists and passed
 * validation. On Home its buttons go to the conversation, which answers
 * with a normal approval card. Nothing changes from here.
 */
export type BriefingCardProps = {
  weekStart: string;
  heading: string;
  headline: string;
  preview: boolean;
  lines: string[];
  days: BriefingDay[];
  actions: BriefingAction[];
  empty: boolean;
  /** The AI summary, streamed in. Null slot = facts only. */
  summary: ReactNode;
  variant: "home" | "insights";
  /** Home only: the briefing is remembered (the migration ran), so it can be closed for good. */
  tracked?: boolean;
};

export function BriefingCard(p: BriefingCardProps) {
  const [closed, setClosed] = useState(false);
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const home = p.variant === "home";

  useEffect(() => {
    if (home && p.tracked) void markBriefingShown({ weekStart: p.weekStart }).catch(() => undefined);
  }, [home, p.tracked, p.weekStart]);

  if (closed) return null;

  const chips: ProactiveChip[] = p.actions
    .filter((a) => !sent.has(a.recommendationId))
    .map((a, i) => ({ label: a.label, primary: i === 0, act: { kind: "recommendation", id: a.recommendationId, actionId: a.actionId } }));

  return (
    <section
      aria-label={`Weekly briefing, ${p.heading}`}
      className="min-w-0 rounded-[20px] border border-border/70 bg-surface p-5 shadow-card dark:border-border"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-ink">
            <CalendarRange className="size-3.5" aria-hidden />
            {p.preview ? "Next week" : "This week"}
          </p>
          <h2 className="mt-1 text-[15px] font-semibold tracking-[-0.015em] text-ink">{p.heading}</h2>
          <p className="mt-0.5 text-[13px] text-ink-3">{p.headline}</p>
        </div>
        {home && p.tracked && (
          <button
            type="button"
            aria-label="Close the weekly briefing"
            onClick={() => {
              setClosed(true);
              void dismissBriefing({ weekStart: p.weekStart }).catch(() => undefined);
            }}
            className="hit-area -mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {p.summary}

      {p.empty ? (
        <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-3 text-[13px] leading-relaxed text-ink-3">
          Nothing is on your calendar or due yet for this week. Add what&apos;s coming up and the briefing fills in.
        </p>
      ) : (
        <>
          {p.days.length > 0 && <WeekStrip days={p.days} />}
          <ul className="mt-3 space-y-1.5">
            {p.lines.map((l) => (
              <li key={l} className="flex gap-2 text-[13px] leading-relaxed text-ink-2">
                <span aria-hidden className="mt-[0.55em] size-1 shrink-0 rounded-full bg-ink-3" />
                <span className="min-w-0 text-pretty">{l.replace(/^Problem: /, "")}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {home && (
        <Link href="/insights" className="mt-3 inline-block text-[12.5px] font-medium text-accent-ink hover:underline">
          Full briefing and last week in Insights
        </Link>
      )}

      {home ? (
        chips.length > 0 && (
          <ChipRow
            chips={chips}
            className="mt-3"
            onAct={(chip) => {
              if (chip.act.kind === "recommendation") setSent((s) => new Set(s).add((chip.act as { id: string }).id));
              sendToHomeChat({ chip, nudge: null });
            }}
          />
        )
      ) : (
        p.actions.length > 0 && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            {p.actions.length === 1 ? "There's a suggested fix" : `There are ${p.actions.length} suggested fixes`} on{" "}
            <Link href="/" className="font-medium text-accent-ink hover:underline">
              Home
            </Link>
            .
          </p>
        )
      )}
    </section>
  );
}

/** Seven small bars: scheduled load and realistic free time per day. Heavy days are marked. */
function WeekStrip({ days }: { days: BriefingDay[] }) {
  const max = Math.max(60, ...days.map((d) => d.commitmentMinutes + d.sessionMinutes));
  return (
    <div className="mt-4 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
      {days.map((d) => {
        const load = d.commitmentMinutes + d.sessionMinutes;
        const label = `${formatDateKey(d.date, { weekday: "long" }, "en-US")}: ${duration(load)} scheduled, ${duration(d.freeMinutes)} free${d.due ? `, ${d.due} due` : ""}${d.heavy ? ", heavy" : ""}`;
        return (
          <div key={d.date} className="flex flex-col items-center gap-1" title={label} aria-label={label} role="img">
            <div className="flex h-10 w-full items-end overflow-hidden rounded-md bg-surface-2">
              <div
                className="w-full rounded-md"
                style={{
                  height: `${Math.max(load ? 8 : 0, (load / max) * 100)}%`,
                  background: d.heavy ? "var(--area-amber)" : "color-mix(in oklab, var(--accent) 45%, transparent)",
                }}
              />
            </div>
            <span className={cn("text-[11px] font-medium", d.heavy ? "text-ink" : "text-ink-3")}>{formatDateKey(d.date, { weekday: "narrow" }, "en-US")}</span>
            {d.due > 0 && <span aria-hidden className="size-1 rounded-full bg-accent" />}
          </div>
        );
      })}
    </div>
  );
}

/** The AI summary line. Server-rendered and passed in as the card's summary slot. */
export function BriefingSummary({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="mt-3 text-[14px] leading-relaxed text-ink text-pretty">{text}</p>;
}
