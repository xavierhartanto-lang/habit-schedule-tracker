import { Card, CardBody, CardHeader } from "@/components/ui";
import { areaColors } from "@/lib/domain/life-areas";
import type { AreaTime, GoalTime, TimeBucket, WeekTime } from "@/lib/insights/area-time";
import { compareWeeks } from "@/lib/insights/area-time";
import type { Observation } from "@/lib/insights/observations";
import { shortDuration } from "@/features/assistant/plan-visual";
import { duration } from "@/lib/proactive/text";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ArrowDownRight, ArrowUpRight, ChevronDown, Minus } from "lucide-react";

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

function Stat({ label, value, sub }: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-[18px] border border-border/70 bg-surface px-4 py-3.5 shadow-card dark:border-border">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</p>
      <p className="mt-1.5 truncate text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">{value}</p>
      <p className="mt-1.5 truncate text-[12px] text-ink-3">{sub}</p>
    </div>
  );
}

/** The week in four numbers: load, its trend, the heaviest day and follow-through. */
export function WeekStats({ thisWeek, lastWeek }: { thisWeek: WeekTime; lastWeek: WeekTime }) {
  const total = thisWeek.totals.scheduled;
  const delta = total - lastWeek.totals.scheduled;
  const busiest = thisWeek.perDay.reduce((m, d) => (d.scheduled > m.scheduled ? d : m), thisWeek.perDay[0]);
  const top = [...thisWeek.areas].filter((a) => a.areaId).sort((a, b) => b.scheduled - a.scheduled)[0];
  const t = thisWeek.totals;
  const past = t.done + t.partial + t.missed + t.unrecorded;
  const worked = t.done + t.partial;
  const trend =
    Math.abs(delta) < 15 ? (
      "Same as last week"
    ) : (
      <span className="inline-flex items-center gap-0.5">
        {delta > 0 ? <ArrowUpRight aria-hidden className="size-3" /> : <ArrowDownRight aria-hidden className="size-3" />}
        {shortDuration(Math.abs(delta))} vs last week
      </span>
    );
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <Stat label="Scheduled" value={total ? duration(total) : "None"} sub={trend} />
      <Stat
        label="Heaviest day"
        value={busiest && busiest.scheduled ? formatDateKey(busiest.date, { weekday: "long" }, "en-US") : "None"}
        sub={busiest && busiest.scheduled ? duration(busiest.scheduled) : "Nothing timed yet"}
      />
      <Stat
        label="Top area"
        value={top && top.scheduled ? top.name : "None"}
        sub={top && total ? `${Math.round((top.scheduled / total) * 100)}% of the week` : "No areas yet"}
      />
      <Stat
        label="Follow-through"
        value={past ? `${Math.round((worked / past) * 100)}%` : "None yet"}
        sub={past ? `${duration(worked)} of ${duration(past)} worked` : "No past sessions this week"}
      />
    </div>
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
            <div className="mt-4 grid grid-cols-[1fr_auto_5rem] gap-3 px-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">
              <span>Area</span>
              <span className="text-right">This week</span>
              <span className="text-right">Change</span>
            </div>
            <ul className="mt-1">
              {rows.map((r) => {
                const a = byId.get(r.areaId ?? "none");
                const detail = a ? breakdown(a) : `Nothing this week, ${duration(r.lastWeek)} last week`;
                const share = total && r.thisWeek ? Math.round((r.thisWeek / total) * 100) : 0;
                return (
                  <li key={r.areaId ?? "none"} className="grid grid-cols-[1fr_auto_5rem] items-center gap-x-3 border-b border-border py-2.5 last:border-0">
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(r).color }} />
                        <span className={cn("truncate text-sm", r.areaId ? "text-ink" : "text-ink-2")}>{r.name}</span>
                        {share > 0 && <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{share}%</span>}
                      </span>
                      {detail && <span className="mt-0.5 block truncate pl-5 text-[12px] text-ink-3">{detail}</span>}
                    </span>
                    <span className="text-right text-sm font-medium tabular-nums text-ink">{duration(r.thisWeek)}</span>
                    <Delta minutes={r.delta} />
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

/** Calendar vs Whitespace sessions. Follow-through lives in "Planned vs what happened". */
function breakdown(a: TimeBucket): string {
  const sessions = a.done + a.partial + a.missed + a.unrecorded + a.upcoming;
  return [a.calendar && `${duration(a.calendar)} calendar`, sessions && `${duration(sessions)} in sessions`].filter(Boolean).join(" · ");
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
    { label: "Still ahead", minutes: totals.upcoming, tone: "var(--accent)" },
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
          items.map((o) => <ObservationItem key={o.id} o={o} />)
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

const BAR_TONE = { accent: "bg-accent", muted: "bg-ink-3/40", warn: "bg-[var(--cat-creative)]" } as const;

/** One observation: the headline and its comparison as bars. The sentence is one tap away. */
function ObservationItem({ o }: { o: Observation }) {
  const max = Math.max(1, ...(o.bars ?? []).map((b) => b.minutes));
  return (
    <details className="group rounded-xl border border-border px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
      <summary className="block cursor-pointer list-none">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium text-ink">{o.title}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" />
        </span>
        {o.bars && o.bars.length > 0 && (
          <span className="mt-2.5 block space-y-1.5" role="img" aria-label={o.bars.map((b) => `${b.label}: ${duration(b.minutes)}`).join(", ")}>
            {o.bars.map((b) => (
              <span key={b.label} className="flex items-center gap-2.5 text-[11.5px] tabular-nums">
                <span className="w-16 shrink-0 text-ink-3">{b.label}</span>
                <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <span className={cn("block h-full rounded-full", BAR_TONE[b.tone])} style={{ width: `${Math.max((b.minutes / max) * 100, b.minutes ? 3 : 0)}%` }} />
                </span>
                <span className="shrink-0 whitespace-nowrap text-right font-semibold text-ink">{duration(b.minutes)}</span>
              </span>
            ))}
          </span>
        )}
      </summary>
      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-2">{o.body}</p>
    </details>
  );
}
