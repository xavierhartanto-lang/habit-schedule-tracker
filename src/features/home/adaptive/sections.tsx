import { LifeAreaDot } from "@/components/ui";
import { BehindButton } from "./suggestion-items";
import { findArea } from "@/lib/domain/life-areas";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { formatDuration } from "@/lib/scheduling/time";
import { formatDateKey, formatTimeInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { CalendarDays, CircleCheck, Flag, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { RailSection } from "../rail-section";
import { SuggestionItems } from "./suggestion-items";
import type { DayLoad, DeadlineItem, HomeSection, SectionKind } from "./types";

/**
 * Step 4 of the adaptive Home: presentation. One small view per section
 * kind, all built on the existing rail card. The page renders whatever
 * the selector returns; layout is never decided here.
 */

type Ctx = { timeZone: string; todayKey: string; areas: LifeAreaRecord[] };
type ViewProps<K extends SectionKind> = { section: Extract<HomeSection, { kind: K }>; ctx: Ctx };

function dayLabel(days: number, key: string) {
  if (days < 0) return "Overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return formatDateKey(key, { weekday: "long" });
  return formatDateKey(key, { weekday: "short", month: "short", day: "numeric" });
}

function whenOf(i: DeadlineItem, tz: string) {
  const day = dayLabel(i.days, i.dateKey);
  if (i.overdue) return `Overdue · was due ${formatDateKey(i.dateKey, { weekday: "short", month: "short", day: "numeric" })}`;
  if (i.kind === "task") return `Due ${i.days < 2 ? day.toLowerCase() : day}`;
  return `${day} · ${i.allDay ? "All day" : formatTimeInZone(new Date(i.at), tz)}`;
}

function ItemList({ items, ctx }: { items: DeadlineItem[]; ctx: Ctx }) {
  return (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={`${i.kind}:${i.id}`} className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-1.5">
          <LifeAreaDot area={findArea(ctx.areas, i.areaId)} className="mt-[7px]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] leading-snug text-ink">{i.title}</p>
            <p className={cn("mt-0.5 flex items-center gap-1 text-[12px] tabular-nums", i.overdue ? "text-danger" : "text-ink-3")}>
              {i.kind === "event" ? <CalendarDays aria-hidden className="size-3" /> : <CircleCheck aria-hidden className="size-3" />}
              {whenOf(i, ctx.timeZone)}
            </p>
          </div>
          {i.priority === "high" && !i.overdue && <span className="pt-0.5 text-[11px] font-medium text-danger">High</span>}
        </li>
      ))}
    </ul>
  );
}

function FocusView({ section, ctx }: ViewProps<"focus">) {
  const f = section.data;
  const free =
    f.freeMinutesToday >= 15
      ? `${formatDuration(f.freeMinutesToday)} free today${f.nextFreeAt ? `, from ${formatTimeInZone(new Date(f.nextFreeAt), ctx.timeZone)}` : ""}`
      : "No free time left today";
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <LifeAreaDot area={findArea(ctx.areas, f.areaId)} className="mt-[9px]" />
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold leading-snug tracking-[-0.015em] text-ink text-pretty">{f.title}</p>
          <p className="mt-1 text-[12.5px] tabular-nums text-ink-3">
            {[f.why, f.estimatedMinutes ? `about ${formatDuration(f.estimatedMinutes)}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      {f.now ? (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed tabular-nums text-ink-2">
          <span className="mr-1.5 text-[10.5px] font-bold uppercase tracking-wide text-accent-ink">Now</span>
          {f.now.message}
        </p>
      ) : (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] tabular-nums text-ink-2">{free}</p>
      )}
      {f.then.length > 0 && (
        <p className="mt-3 text-[12.5px] text-ink-3">
          Then: <span className="text-ink-2">{f.then.map((t) => t.title).join(", ")}</span>
        </p>
      )}
      {f.behind && <BehindButton />}
    </div>
  );
}

function DeadlinesView({ section, ctx }: ViewProps<"deadlines">) {
  return (
    <>
      <ItemList items={section.data.items} ctx={ctx} />
      {section.data.more > 0 && (
        <Link href="/tasks" className="mt-2 inline-block text-[12.5px] font-medium text-ink-3 hover:text-accent-ink">
          +{section.data.more} more
        </Link>
      )}
    </>
  );
}

/** Seven small bars: booked time against realistic room for work. Overloaded days are flagged by the engine, not here. */
function WeekBars({ days }: { days: DayLoad[] }) {
  const busiest = Math.max(60, ...days.map((d) => d.commitmentMinutes + d.sessionMinutes + d.freeMinutes));
  return (
    <ol aria-label="Next 7 days" className="grid grid-cols-7 gap-1.5">
      {days.map((d, i) => {
        const booked = d.commitmentMinutes + d.sessionMinutes;
        const label = `${formatDateKey(d.dateKey, { weekday: "long" })}: ${formatDuration(booked) || "nothing"} booked, ${formatDuration(d.freeMinutes) || "no time"} free${d.due ? `, ${d.due} due` : ""}${d.overloaded ? ", overloaded" : ""}`;
        return (
          <li key={d.dateKey} aria-label={label} title={label} className="flex flex-col items-center gap-1.5">
            <span className="relative flex h-14 w-full flex-col justify-end overflow-hidden rounded-lg bg-surface-2">
              <span
                className={cn("w-full rounded-t-[3px]", d.overloaded ? "bg-danger/70" : "bg-accent/55")}
                style={{ height: `${Math.min(100, Math.round((booked / busiest) * 100))}%` }}
              />
            </span>
            <span className={cn("text-[11px] font-medium tabular-nums", i === 0 ? "text-ink" : "text-ink-3")}>
              {formatDateKey(d.dateKey, { weekday: "narrow" })}
            </span>
            <span aria-hidden className={cn("size-1 rounded-full", d.due ? "bg-ink-3" : "bg-transparent")} />
          </li>
        );
      })}
    </ol>
  );
}

function WorkloadView({ section }: ViewProps<"workload">) {
  const { warnings, coveredWarnings, days } = section.data;
  return (
    <div className="space-y-3.5">
      {coveredWarnings.length > 0 && (
        <ul className="space-y-1">
          {coveredWarnings.map((w) => (
            <li key={w.id} className="text-[13.5px] leading-relaxed text-ink">
              {w.message}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && <SuggestionItems items={warnings} compact />}
      {days.length > 0 && <WeekBars days={days} />}
    </div>
  );
}

function OpenTimeView({ section, ctx }: ViewProps<"open_time">) {
  const d = section.data;
  return (
    <div>
      <p className="text-[13.5px] leading-relaxed text-ink">
        Nothing urgent today, and about {formatDuration(d.freeMinutes)} free
        {d.from ? ` from ${formatTimeInZone(new Date(d.from), ctx.timeZone)}` : ""}. A good window for:
      </p>
      <ul className="mt-2.5 space-y-0.5">
        {d.ideas.map((i) => (
          <li key={`${i.kind}:${i.id}`} className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            {i.kind === "goal" ? <Flag aria-hidden className="size-3.5 shrink-0 text-ink-3" /> : <LifeAreaDot area={findArea(ctx.areas, i.areaId)} />}
            <span className="truncate text-[13.5px] text-ink">{i.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProgressView({ section }: ViewProps<"progress">) {
  const p = section.data;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-2">
        {[
          { v: p.doneToday, l: "done today" },
          { v: p.doneThisWeek, l: "this week" },
        ].map((x) => (
          <div key={x.l} className="rounded-2xl bg-surface-2 px-3.5 py-2.5">
            <dd className="text-[22px] font-bold leading-tight tracking-[-0.03em] tabular-nums text-ink">{x.v}</dd>
            <dt className="text-[12px] font-medium text-ink-3">{x.l}</dt>
          </div>
        ))}
      </dl>
      {p.recent.length > 0 && (
        <p className="mt-3 truncate text-[12.5px] text-ink-3">
          Latest: <span className="text-ink-2">{p.recent.map((r) => r.title).join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function GoalsView({ section, ctx }: ViewProps<"goals">) {
  return (
    <ul className="space-y-3">
      {section.data.goals.map((g) => (
        <li key={g.id}>
          <div className="flex items-center gap-2.5">
            <LifeAreaDot area={findArea(ctx.areas, g.areaId)} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{g.title}</span>
            {g.progress !== null && <span className="text-[12px] tabular-nums text-ink-3">{g.progress}%</span>}
          </div>
          {g.progress !== null && (
            <span aria-hidden className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-2">
              <span className="block h-full rounded-full bg-accent/60" style={{ width: `${g.progress}%` }} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function GettingStartedView({ section }: ViewProps<"getting_started">) {
  return (
    <div>
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        {section.data.aiConfigured
          ? "Tell the assistant what your week looks like: classes, practices, a test coming up. It will sort out what matters."
          : "Add your classes, practices and deadlines. Home will start pointing out what matters."}
      </p>
      <div className="mt-3.5 flex flex-wrap gap-1.5">
        <Link href="/calendar" className="rounded-xl bg-surface-2 px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-accent-soft hover:text-accent-ink">
          Add to calendar
        </Link>
        <Link href="/tasks" className="rounded-xl bg-surface-2 px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-accent-soft hover:text-accent-ink">
          Add a task
        </Link>
      </div>
    </div>
  );
}

type Meta = { title: string; href?: string; hrefLabel?: string; icon?: ReactNode };

const META: Record<SectionKind, Meta> = {
  focus: { title: "Start here", href: "/tasks", hrefLabel: "Tasks" },
  deadlines: { title: "Due soon", href: "/tasks", hrefLabel: "Tasks" },
  workload: { title: "Workload", href: "/calendar?view=week", hrefLabel: "Week" },
  suggestions: { title: "Worth a look" },
  open_time: { title: "Open time", href: "/calendar?view=day", hrefLabel: "Calendar" },
  week_outlook: { title: "Your week", href: "/calendar?view=week", hrefLabel: "Week" },
  progress: { title: "Progress", href: "/insights", hrefLabel: "Insights" },
  coming_up: { title: "Coming up" },
  goals: { title: "Goals", href: "/habits", hrefLabel: "All goals" },
  getting_started: { title: "Get started" },
};

function Body({ section, ctx }: { section: HomeSection; ctx: Ctx }) {
  switch (section.kind) {
    case "focus":
      return <FocusView section={section} ctx={ctx} />;
    case "deadlines":
      return <DeadlinesView section={section} ctx={ctx} />;
    case "workload":
      return <WorkloadView section={section} ctx={ctx} />;
    case "suggestions":
      return <SuggestionItems items={section.data.items} />;
    case "open_time":
      return <OpenTimeView section={section} ctx={ctx} />;
    case "week_outlook":
      return <WeekBars days={section.data.days} />;
    case "progress":
      return <ProgressView section={section} ctx={ctx} />;
    case "coming_up":
      return <ItemList items={section.data.items} ctx={ctx} />;
    case "goals":
      return <GoalsView section={section} ctx={ctx} />;
    case "getting_started":
      return <GettingStartedView section={section} ctx={ctx} />;
  }
}

/** One adaptive section as a rail card. The lead gets a quiet accent ring and its reason as a label. */
export function SectionCard({ section, ctx, className }: { section: HomeSection; ctx: Ctx; className?: string }) {
  const meta = META[section.kind];
  return (
    <RailSection
      title={meta.title}
      meta={section.kind === "coming_up" ? "2 weeks" : undefined}
      href={meta.href}
      hrefLabel={meta.hrefLabel}
      className={cn("animate-fade-up", section.lead && "ring-1 ring-accent/25", className)}
    >
      <div data-section={section.kind} data-layer={section.layer}>
        {section.lead && (
          <p className="-mt-2 mb-3 flex items-center gap-1.5 text-[12px] font-medium text-accent-ink">
            <Sparkles aria-hidden className="size-3.5" />
            {section.reason}
          </p>
        )}
        <Body section={section} ctx={ctx} />
      </div>
    </RailSection>
  );
}
