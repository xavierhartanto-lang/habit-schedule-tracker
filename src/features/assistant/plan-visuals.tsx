"use client";

import { useNow } from "@/lib/hooks/use-now";
import { dateKeyInZone, formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ArrowRight, CalendarDays, Clock, Flag, Info, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PlanItem, PlanView } from "./plan-types";
import { isTimed, leftOutTag, stripWindow, type StripBlock, type Tone } from "./plan-visual";

/** Visual pieces of the plan card: time strips, step path, chips, "next time" pills. */

const HOUR = 3_600_000;

export const PILL = "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold";

export const TONE: Record<Tone | "accent" | "ok", string> = {
  plain: "bg-surface-2 text-ink-2",
  accent: "bg-accent-soft text-accent-ink",
  ok: "bg-success-soft text-success",
  warn: "bg-[var(--cat-creative-soft)] text-[var(--cat-creative)]",
  danger: "bg-danger-soft text-danger",
};

function hourLabel(ms: number, tz: string, first: boolean) {
  const s = new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", timeZone: tz });
  return first ? s.replace(" ", " ") : s.replace(/\s?(AM|PM)$/, "");
}

/** Blocks for one day: what's around (hatched), what's new (numbered), where moved items came from (dashed). */
function blocksFor(items: readonly PlanItem[], numberOf: Map<string, number>): { blocks: StripBlock[]; deadline: number | null } {
  const blocks: StripBlock[] = [];
  const seen = new Set<string>();
  let deadline: number | null = null;
  const own = new Set(items.map((i) => `${i.title}|${i.timing!.start}`));
  for (const i of items) {
    for (const n of i.nearby) {
      const key = `${n.title}|${n.start}`;
      if (seen.has(key) || own.has(key)) continue;
      seen.add(key);
      blocks.push({ key, start: Date.parse(n.start), end: Date.parse(n.end), label: n.title, kind: "busy" });
    }
    if (i.previous) {
      blocks.push({ key: `${i.id}-was`, start: Date.parse(i.previous.start), end: Date.parse(i.previous.end), label: "", kind: "ghost" });
    }
    const closed = i.status === "rejected" || i.status === "undone";
    blocks.push({
      key: i.id,
      start: Date.parse(i.timing!.start),
      end: Date.parse(i.timing!.end),
      label: String(numberOf.get(i.id) ?? ""),
      kind: closed ? "removed" : i.action === "remove_block" || i.action === "remove_event" || i.action === "skip_occurrence" ? "removed" : i.conflicts.length || i.status === "conflict" ? "conflict" : i.status === "applied" ? "done" : "new",
    });
    if (i.deadline) {
      const d = Date.parse(i.deadline);
      if (deadline === null || d < deadline) deadline = d;
    }
  }
  return { blocks, deadline };
}

const BLOCK: Record<StripBlock["kind"], string> = {
  busy: "border border-border-strong/60 bg-[repeating-linear-gradient(135deg,var(--border-strong)_0_5px,transparent_5px_9px)] text-ink-3",
  new: "bg-accent text-on-accent shadow-[0_4px_12px_-6px_var(--accent)]",
  done: "bg-success text-surface",
  conflict: "bg-danger text-surface",
  ghost: "border border-dashed border-ink-3/60",
  removed: "border border-dashed border-ink-3/50 text-ink-3 line-through",
};

/** One day's strip. `window` lets stacked strips share the same hours. */
export function DayStrip({
  items,
  numberOf,
  timeZone,
  window: shared,
  label,
  compact = false,
}: {
  items: PlanItem[];
  numberOf: Map<string, number>;
  timeZone: string;
  window?: { start: number; end: number };
  label?: string;
  compact?: boolean;
}) {
  const now = useNow();
  const { blocks, deadline } = blocksFor(items, numberOf);
  const win = shared ?? stripWindow(blocks, deadline, timeZone);
  const span = win.end - win.start;
  const pct = (ms: number) => `${(((Math.min(Math.max(ms, win.start), win.end) - win.start) / span) * 100).toFixed(2)}%`;
  const width = (a: number, b: number) => `${((Math.max(Math.min(b, win.end) - Math.max(a, win.start), 0) / span) * 100).toFixed(2)}%`;
  const hours: number[] = [];
  for (let h = win.start; h <= win.end; h += HOUR) hours.push(h);
  const step = hours.length > 10 ? 2 : 1;
  const visible = blocks.filter((b) => b.end > win.start && b.start < win.end);
  const nowMs = now?.getTime() ?? null;
  const day = items[0]?.timing?.date;
  const showNow = nowMs !== null && nowMs > win.start && nowMs < win.end && day === dateKeyInZone(new Date(nowMs), timeZone);
  const showDue = deadline !== null && deadline > win.start && deadline <= win.end;
  const summary = items
    .map((i) => `${numberOf.get(i.id) ?? ""} ${i.title}`)
    .join(", ");

  return (
    <div className={cn("flex items-center gap-3", compact && "gap-2.5")}>
      {label && <span className="w-12 shrink-0 text-[11.5px] font-semibold text-ink-3">{label}</span>}
      <div className="min-w-0 flex-1">
        <div
          role="img"
          aria-label={`Time strip: ${summary}`}
          className={cn("relative rounded-xl bg-surface-2", compact ? "h-8" : "h-11", showDue && "mr-1")}
        >
          {visible.map((b) => (
            <div
              key={b.key}
              title={b.label && b.kind === "busy" ? b.label : undefined}
              className={cn(
                "absolute inset-y-1 flex min-w-[6px] items-center justify-center overflow-hidden rounded-lg px-1.5 text-[11px] font-bold",
                BLOCK[b.kind],
                b.kind === "ghost" && "inset-y-1.5",
              )}
              style={{ left: pct(b.start), width: width(b.start, b.end) }}
            >
              <span className="min-w-0 truncate">{b.kind === "busy" && (b.end - b.start) / span < 0.12 ? "" : b.label}</span>
            </div>
          ))}
          {showNow && <div aria-hidden className="absolute -inset-y-0.5 w-0.5 rounded-full bg-ink" style={{ left: pct(nowMs!) }} />}
          {showDue && (
            <div aria-hidden className="absolute -inset-y-1 w-0.5 rounded-full bg-danger" style={{ left: `calc(${pct(deadline!)} - 1px)` }}>
              {!compact && <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] font-bold text-danger">Due</span>}
            </div>
          )}
        </div>
        {!compact && (
          <div aria-hidden className="relative mt-1 h-4">
            {hours.map((h, idx) =>
              idx % step === 0 ? (
                <span
                  key={h}
                  className={cn(
                    "absolute -translate-x-1/2 text-[10.5px] tabular-nums text-ink-3 first:translate-x-0",
                    step === 1 && idx % 2 === 1 && "max-sm:hidden",
                  )}
                  style={{ left: pct(h) }}
                >
                  {hourLabel(h, timeZone, idx === 0)}
                </span>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Several days, one compact strip each, sharing the same hours so they line up. */
export function WeekStrips({ items, numberOf, timeZone }: { items: PlanItem[]; numberOf: Map<string, number>; timeZone: string }) {
  const byDay = new Map<string, PlanItem[]>();
  for (const i of items) byDay.set(i.timing!.date, [...(byDay.get(i.timing!.date) ?? []), i]);
  const all = blocksFor(items, numberOf);
  // Shared hours: compare minutes of the day, then project onto each day.
  const minOfDay = (ms: number) => {
    const d = new Date(ms);
    const [h, m] = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone, hourCycle: "h23" }).split(":").map(Number);
    return h * 60 + m;
  };
  const mins = all.blocks.flatMap((b) => [minOfDay(b.start), minOfDay(b.end) || 24 * 60]);
  const lo = Math.floor(Math.min(...mins) / 60);
  const hi = Math.max(lo + 3, Math.ceil(Math.max(...mins) / 60));
  const days = [...byDay.keys()].sort();
  return (
    <div className="space-y-1.5">
      {days.map((date) => {
        const dayItems = byDay.get(date)!;
        const first = Date.parse(dayItems[0].timing!.start);
        const base = first - minOfDay(first) * 60_000;
        return (
          <DayStrip
            key={date}
            compact
            items={dayItems}
            numberOf={numberOf}
            timeZone={timeZone}
            window={{ start: base + lo * HOUR, end: base + hi * HOUR }}
            label={formatDateKey(date, { weekday: "short" }) + " " + Number(date.slice(8))}
          />
        );
      })}
      <div aria-hidden className="flex justify-between pl-[3.6rem] text-[10.5px] tabular-nums text-ink-3">
        <span>{((lo + 11) % 12) + 1}{lo < 12 ? " AM" : " PM"}</span>
        <span>{((hi + 11) % 12) + 1}{hi < 12 || hi === 24 ? " AM" : " PM"}</span>
      </div>
    </div>
  );
}

/** Progress ring: steps placed in this plan out of the open steps. */
export function StepRing({ placed, total }: { placed: number; total: number }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 44 44" className="size-11 shrink-0" role="img" aria-label={`${placed} of ${total} steps in this plan`}>
      <circle cx="22" cy="22" r={r} fill="none" strokeWidth="5" className="stroke-surface-2" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        className="stroke-accent transition-[stroke-dasharray] duration-500"
        strokeDasharray={`${(c * placed) / Math.max(total, 1)} ${c}`}
        transform="rotate(-90 22 22)"
      />
      <text x="22" y="26" textAnchor="middle" className="fill-ink text-[12px] font-bold">
        {placed}/{total}
      </text>
    </svg>
  );
}

const CHIP_ICON: Record<string, typeof Clock> = {
  before_deadline: Flag,
  near_deadline: Flag,
  buffer: Clock,
  light_day: CalendarDays,
  preferred_day: CalendarDays,
  not_preferred_day: CalendarDays,
  busy_day: CalendarDays,
};

/** The "why" as short chips: warnings first, then reasons. */
export function ChipLine({ item }: { item: PlanItem }) {
  const chips = item.chips;
  const conflict = item.conflicts[0];
  if (!chips.length && !conflict && !item.timing?.recurrence) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {conflict && (
        <span className={cn(PILL, TONE.danger)}>
          <TriangleAlert aria-hidden className="size-3" /> Overlaps {conflict.title}
        </span>
      )}
      {item.timing?.recurrence && <span className={cn(PILL, TONE.accent)}>{item.timing.recurrence}</span>}
      {chips.map((c) => {
        const Icon = c.code === "free_gap" ? ArrowRight : CHIP_ICON[c.code] ?? Info;
        return (
          <span
            key={c.code + c.label}
            className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium", c.tone === "warn" ? "text-[var(--cat-creative)]" : "text-ink-3")}
          >
            <Icon aria-hidden className="size-3" />
            {c.label}
          </span>
        );
      })}
    </div>
  );
}

/** Left-out work as pills, with the full reasons one tap away. */
export function NextUp({ entries }: { entries: PlanView["unscheduled"] }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const short = entries.some((e) => e.minutes > 0);
  return (
    <div className="border-t border-border bg-surface-2/60 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] font-semibold text-ink-2">{short ? "Didn't fit" : "Next time"}</span>
        {entries.map((e) => {
          const tag = leftOutTag(e);
          return (
            <span key={e.title} className={cn(PILL, "max-w-full py-1", TONE[tag?.tone ?? "plain"])}>
              <span className="truncate">{e.title}</span>
              {tag && <span className="font-medium opacity-80">· {tag.label}</span>}
            </span>
          );
        })}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[12px] font-semibold text-accent-ink hover:bg-accent-soft"
        >
          <Info className="size-3" /> {open ? "Hide" : "Why"}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1">
          {entries.map((e) => (
            <li key={e.title} className="text-[12px] leading-relaxed text-ink-2">
              <span className="font-medium text-ink">{e.title}:</span> {e.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Item numbering for strips and rows, in the card's row order, so a number matches its row. */
export function numberTimed(items: readonly PlanItem[]): Map<string, number> {
  return new Map(items.filter(isTimed).map((i, n) => [i.id, n + 1]));
}
