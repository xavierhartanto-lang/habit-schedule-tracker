import { Card, CardBody, CardHeader } from "@/components/ui";
import { areaColors } from "@/lib/domain/life-areas";
import type { AreaTime, GoalTime, TimeBucket, WeekTime } from "@/lib/insights/area-time";
import { compareWeeks } from "@/lib/insights/area-time";
import type { Observation } from "@/lib/insights/observations";
import { duration } from "@/lib/proactive/text";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/**
 * Phase 7.6 Insights sections. Real numbers only (lib/insights), honest
 * empty states, area colors from the user's own life areas. Calendar time
 * is labelled as scheduled, never as done.
 */

/** Scheduled-but-not-done time: a quiet tint of the accent that still reads in both themes. */
const CAL_TONE = "color-mix(in oklab, var(--accent) 38%, transparent)";

const colorOf = (a: Pick<AreaTime, "color">) => areaColors(a.color ? { color: a.color } : null);

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13px] leading-relaxed text-ink-3">{children}</p>;
}

function Delta({ minutes }: { minutes: number }) {
  if (Math.abs(minutes) < 15) {
    return (
      <span className="flex w-20 items-center justify-end gap-0.5 text-[12px] tabular-nums text-ink-3">
        <Minus className="size-3" aria-hidden /> <span className="sr-only">No change</span>same
      </span>
    );
  }
  const Arrow = minutes > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="flex w-20 items-center justify-end gap-0.5 text-[12px] tabular-nums text-ink-3">
      <Arrow className="size-3" aria-hidden />
      <span className="sr-only">{minutes > 0 ? "Up" : "Down"}</span>
      {duration(Math.abs(minutes))}
    </span>
  );
}

/** Where the time went this week, per life area, against last week. */
export function TimeAllocation({ thisWeek, lastWeek, todayKey }: { thisWeek: WeekTime; lastWeek: WeekTime; todayKey: string }) {
  const rows = compareWeeks(thisWeek, lastWeek);
  const byId = new Map(thisWeek.areas.map((a) => [a.areaId ?? "none", a]));
  const total = thisWeek.totals.scheduled;
  const partial = todayKey < thisWeek.days[6];
  return (
    <Card>
      <CardHeader
        title="Where your time went"
        description={total ? `${duration(total)} scheduled this week${partial ? " so far, including what's still ahead" : ""}` : "This week, by life area"}
      />
      <CardBody>
        {!rows.length ? (
          <Empty>Nothing with a time is on your calendar this week or last. Add events or let Whitespace plan work sessions, and the breakdown fills in.</Empty>
        ) : (
          <>
            {total > 0 && (
              <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Share of scheduled time by life area">
                {thisWeek.areas.map((a) => (
                  <div
                    key={a.areaId ?? "none"}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${(a.scheduled / total) * 100}%`, background: colorOf(a).color }}
                    title={`${a.name}: ${duration(a.scheduled)}`}
                  />
                ))}
              </div>
            )}
            <div className="mt-4 hidden grid-cols-[1fr_auto_5rem] gap-3 px-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3 sm:grid">
              <span>Area</span>
              <span className="text-right">This week</span>
              <span className="text-right">vs last week</span>
            </div>
            <ul className="mt-1">
              {rows.map((r) => {
                const a = byId.get(r.areaId ?? "none");
                const detail = a ? breakdown(a) : `Nothing this week, ${duration(r.lastWeek)} last week`;
                return (
                  <li key={r.areaId ?? "none"} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-border py-2.5 last:border-0 sm:grid-cols-[1fr_auto_5rem]">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(r).color }} />
                      <span className={cn("truncate text-sm", r.areaId ? "text-ink" : "text-ink-2")}>{r.name}</span>
                    </span>
                    <span className="text-right text-sm tabular-nums text-ink">{duration(r.thisWeek)}</span>
                    <span className="col-span-2 row-start-2 pl-5 text-[12px] text-ink-3 sm:col-span-1 sm:col-start-1 sm:row-start-2">{detail}</span>
                    <span className="col-start-2 row-start-2 justify-self-end sm:col-start-3 sm:row-span-2 sm:row-start-1">
                      <Delta minutes={r.delta} />
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
              Calendar time is what was scheduled, not proof it happened. Only sessions you mark count as done.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function breakdown(a: TimeBucket): string {
  const parts = [
    a.calendar && `${duration(a.calendar)} on the calendar`,
    a.done && `${duration(a.done)} done`,
    a.partial && `${duration(a.partial)} partly done`,
    a.missed && `${duration(a.missed)} missed`,
    a.unrecorded && `${duration(a.unrecorded)} not recorded`,
    a.upcoming && `${duration(a.upcoming)} of sessions ahead`,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Scheduled hours per day this week: calendar and Whitespace sessions. */
export function DailyLoad({ week, todayKey }: { week: WeekTime; todayKey: string }) {
  const max = Math.max(60, ...week.perDay.map((d) => d.scheduled));
  const any = week.perDay.some((d) => d.scheduled > 0);
  return (
    <Card className="h-full">
      <CardHeader title="Daily load" description="Scheduled time per day this week" />
      <CardBody>
        {!any ? (
          <Empty>No timed events this week yet.</Empty>
        ) : (
          <>
            <div className="flex h-44 items-end gap-2" role="list" aria-label="Scheduled time per day">
              {week.perDay.map((d) => {
                const today = d.date === todayKey;
                const cal = Math.max(0, d.scheduled - d.sessions);
                return (
                  <div key={d.date} role="listitem" className="flex min-w-0 flex-1 flex-col items-center gap-1.5" aria-label={`${formatDateKey(d.date, { weekday: "long" }, "en-US")}: ${duration(d.scheduled)}`}>
                    <span className="text-[11px] tabular-nums text-ink-3">{d.scheduled ? duration(d.scheduled).replace(" min", "m").replace(" h", "h") : ""}</span>
                    <div className="flex w-full max-w-10 flex-col justify-end overflow-hidden rounded-md" style={{ height: `${(d.scheduled / max) * 120}px` }}>
                      <div style={{ height: `${d.scheduled ? (d.sessions / d.scheduled) * 100 : 0}%`, background: "var(--accent)" }} />
                      <div style={{ height: `${d.scheduled ? (cal / d.scheduled) * 100 : 0}%`, background: CAL_TONE }} />
                    </div>
                    <span className={cn("text-[12px] font-medium", today ? "text-accent-ink" : "text-ink-2")}>
                      {formatDateKey(d.date, { weekday: "narrow" }, "en-US")}
                      <span className="sr-only">{today ? " (today)" : ""}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-sm" style={{ background: CAL_TONE }} /> Calendar
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-sm" style={{ background: "var(--accent)" }} /> Whitespace sessions
              </span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Plan vs reality for Whitespace sessions this week, by what the user recorded. */
export function SessionsReality({ totals }: { totals: TimeBucket }) {
  const rows: { label: string; minutes: number; tone: string }[] = [
    { label: "Done", minutes: totals.done, tone: "var(--success)" },
    { label: "Partly done", minutes: totals.partial, tone: "color-mix(in oklab, var(--success) 50%, var(--surface-2))" },
    { label: "Missed", minutes: totals.missed, tone: "var(--area-amber)" },
    { label: "Not recorded", minutes: totals.unrecorded, tone: "var(--area-none)" },
    { label: "Still ahead", minutes: totals.upcoming, tone: CAL_TONE },
  ];
  const sum = rows.reduce((s, r) => s + r.minutes, 0);
  return (
    <Card className="h-full">
      <CardHeader title="Planned vs what happened" description="Whitespace work sessions this week" />
      <CardBody>
        {!sum ? (
          <Empty>No Whitespace sessions this week. When you approve a plan, its sessions and how they went show up here.</Empty>
        ) : (
          <>
            <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2" aria-hidden>
              {rows
                .filter((r) => r.minutes)
                .map((r) => (
                  <div key={r.label} className="h-full" style={{ width: `${(r.minutes / sum) * 100}%`, background: r.tone }} />
                ))}
            </div>
            <ul className="mt-4 space-y-2">
              {rows.map((r) => (
                <li key={r.label} className="flex items-center gap-2.5 text-sm">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: r.tone }} />
                  <span className="flex-1 text-ink-2">{r.label}</span>
                  <span className={cn("tabular-nums", r.minutes ? "text-ink" : "text-ink-3")}>{r.minutes ? duration(r.minutes) : "None"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function Observations({ items }: { items: Observation[] }) {
  return (
    <Card className="h-full">
      <CardHeader title="Worth a look" description="Plain facts from this week's numbers" />
      <CardBody className="space-y-2.5 pt-3">
        {!items.length ? (
          <Empty>Nothing stands out this week. That&apos;s a fine answer.</Empty>
        ) : (
          items.map((o) => (
            <div key={o.id} className="rounded-xl border border-border px-4 py-3">
              <p className="text-sm font-medium text-ink">{o.title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{o.body}</p>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

/** Goals as a lens: session time on tasks linked to each goal. The same minutes are in their area above. */
export function GoalsLens({ goals, areas }: { goals: GoalTime[]; areas: { id: string; color: AreaTime["color"] }[] }) {
  if (!goals.length) return null;
  return (
    <Card>
      <CardHeader title="Time toward your goals" description="Sessions on tasks linked to a goal. Already counted in the areas above." />
      <CardBody>
        <ul>
          {goals.map((g) => {
            const area = areas.find((a) => a.id === g.areaId);
            return (
              <li key={g.goalId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border py-2.5 last:border-0">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: areaColors(area?.color ? { color: area.color } : null).color }} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{g.title}</span>
                <span className="text-[12px] tabular-nums text-ink-3">
                  {[g.worked && `${duration(g.worked)} worked`, g.upcoming && `${duration(g.upcoming)} ahead`, `${duration(g.scheduled)} planned`].filter(Boolean).join(" · ")}
                </span>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
