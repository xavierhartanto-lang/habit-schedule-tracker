"use client";

import { ChipRow } from "@/features/assistant/proactive-nudges";
import { sendToHomeChat } from "@/features/home/adaptive/home-bridge";
import type { ProactiveChip } from "@/features/home/proactive";
import type { BriefingAction, BriefingDay, BriefingVisual } from "@/lib/insights/weekly";
import { CapacityBar } from "@/features/assistant/proactive-nudges";
import { shortDuration } from "@/features/assistant/plan-visual";
import { duration } from "@/lib/proactive/text";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ArrowDownRight, ArrowUpRight, CalendarDays, CalendarRange, GraduationCap, TriangleAlert, X } from "lucide-react";
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
  visual: BriefingVisual;
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
          <BriefingVisuals v={p.visual} />
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

const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-2";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="w-20 shrink-0 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** The week's facts as chips and bars. The sentences still go to the AI summary. */
function BriefingVisuals({ v }: { v: BriefingVisual }) {
  const s = v.sessions;
  const total = s ? s.done + s.partial + s.missed + s.unrecorded : 0;
  return (
    <div className="mt-4 space-y-2.5">
      {v.problems.map((pr) => (
        <p key={pr.title} title={pr.message} className="flex items-center gap-2 rounded-xl bg-[var(--cat-creative-soft)] px-3 py-2 text-[12.5px] font-medium text-ink">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-[var(--cat-creative)]" />
          <span className="min-w-0 truncate">{pr.title}</span>
        </p>
      ))}
      <Row label="Due">
        {v.due.length === 0 && <span className="pt-1 text-[12.5px] text-ink-3">Nothing due</span>}
        {v.due.map((d) => (
          <span key={d.title + d.when} className={CHIP}>
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", d.high ? "bg-danger" : "bg-accent")} />
            <span className="min-w-0 truncate text-ink">{d.title}</span>
            <span className="shrink-0 text-ink-3">{d.when}</span>
            {d.high && <span className="sr-only">high priority</span>}
          </span>
        ))}
        {v.moreDue > 0 && <span className="text-[12px] font-medium text-ink-3">+{v.moreDue}</span>}
      </Row>
      {v.events.length > 0 && (
        <Row label="Events">
          {v.events.map((e) => (
            <span key={e.title + e.when} className={CHIP}>
              {e.exam ? <GraduationCap aria-hidden className="size-3 shrink-0 text-accent-ink" /> : <CalendarDays aria-hidden className="size-3 shrink-0 text-ink-3" />}
              <span className="min-w-0 truncate text-ink">{e.title}</span>
              <span className="shrink-0 text-ink-3">{e.when}</span>
            </span>
          ))}
          {v.moreEvents > 0 && <span className="text-[12px] font-medium text-ink-3">+{v.moreEvents}</span>}
        </Row>
      )}
      {v.capacity && (
        <Row label="Work left">
          <CapacityBar work={v.capacity.work} free={v.capacity.free} />
        </Row>
      )}
      {v.balance.length > 0 && (
        <Row label={v.behind}>
          {v.balance.map((b) => (
            <span key={b.name} className={CHIP}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: `var(--area-${b.color ?? "none"})` }} />
              <span className="text-ink">{b.name}</span>
              {b.delta > 0 ? <ArrowUpRight aria-label="up" className="size-3 text-success" /> : <ArrowDownRight aria-label="down" className="size-3 text-ink-3" />}
              <span className="tabular-nums">{shortDuration(Math.abs(Math.round(b.delta)))}</span>
            </span>
          ))}
        </Row>
      )}
      {s && total > 0 && (
        <Row label="Sessions">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div role="img" aria-label={`${v.behind}'s sessions: ${shortDuration(s.done)} done, ${shortDuration(s.partial)} partly, ${shortDuration(s.missed)} missed, ${shortDuration(s.unrecorded)} not recorded`} className="flex h-2 w-full max-w-72 overflow-hidden rounded-full bg-surface-2">
              {([["done", "bg-success"], ["partial", "bg-success/45"], ["missed", "bg-[var(--cat-creative)]"], ["unrecorded", "bg-ink-3/40"]] as const).map(([k, c]) =>
                s[k] > 0 ? <span key={k} className={c} style={{ width: `${(s[k] / total) * 100}%` }} /> : null,
              )}
            </div>
            <div className="flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-ink-3">
              {s.done > 0 && <span><b className="font-semibold text-ink">{shortDuration(s.done)}</b> done</span>}
              {s.partial > 0 && <span><b className="font-semibold text-ink">{shortDuration(s.partial)}</b> partly</span>}
              {s.missed > 0 && <span><b className="font-semibold text-ink">{shortDuration(s.missed)}</b> missed</span>}
              {s.unrecorded > 0 && <span><b className="font-semibold text-ink">{shortDuration(s.unrecorded)}</b> not recorded</span>}
            </div>
          </div>
        </Row>
      )}
    </div>
  );
}
