"use client";

import { Button, Dialog, Segmented } from "@/components/ui";
import type { Commitment, LifeAreaRecord } from "@/lib/domain/types";
import { useNow } from "@/lib/hooks/use-now";
import { expandEvents, findConflicts, type Occurrence } from "@/lib/scheduling/recurrence";
import {
  addDaysToKey,
  addMonthsToKey,
  formatDateKey,
  startOfDayInZone,
} from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ChevronLeft, ChevronRight, Lock, MoveVertical, Plus, TriangleAlert } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { EventDetails } from "./event-details";
import { EventEditor, formFromEvent, newEventForm, type EditorTarget } from "./event-editor";
import { MonthGrid } from "./month-grid";
import { TimeGrid } from "./time-grid";
import { UnplacedTray } from "./unplaced-tray";

export type CalendarViewMode = "day" | "week" | "month";

const VIEW_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

export function CalendarView({
  view,
  date,
  dayKeys,
  events,
  unplaced,
  areas,
  timeZone,
  todayKey,
  disabled,
}: {
  view: CalendarViewMode;
  date: string;
  dayKeys: string[];
  events: Commitment[];
  unplaced: Commitment[];
  areas: LifeAreaRecord[];
  timeZone: string;
  todayKey: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNav] = useTransition();
  const now = useNow();
  const [selected, setSelected] = useState<Occurrence | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const occurrences = useMemo(() => {
    const from = startOfDayInZone(dayKeys[0], timeZone);
    const to = startOfDayInZone(addDaysToKey(dayKeys[dayKeys.length - 1], 1), timeZone);
    return expandEvents(events, from, to, timeZone);
  }, [events, dayKeys, timeZone]);
  const conflicts = useMemo(() => findConflicts(occurrences), [occurrences]);

  const go = (nextView: CalendarViewMode, nextDate: string) =>
    startNav(() => router.push(`${pathname}?view=${nextView}&date=${nextDate}`, { scroll: false }));

  const step = (dir: 1 | -1) => {
    if (view === "day") go(view, addDaysToKey(date, dir));
    else if (view === "week") go(view, addDaysToKey(date, 7 * dir));
    else go(view, addMonthsToKey(date, dir));
  };

  const title = (() => {
    if (view === "day") return formatDateKey(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (view === "month") return formatDateKey(date, { month: "long", year: "numeric" });
    const a = dayKeys[0];
    const b = dayKeys[6];
    const left = formatDateKey(a, { month: "short", day: "numeric" });
    const right = a.slice(0, 7) === b.slice(0, 7) ? formatDateKey(b, { day: "numeric" }) : formatDateKey(b, { month: "short", day: "numeric" });
    return `${left} – ${right}, ${b.slice(0, 4)}`;
  })();

  const openNew = (dateKey: string, startMin?: number) => {
    if (disabled) return;
    setEditor({ mode: "create", initial: newEventForm(dateKey, startMin, timeZone, now) });
  };

  // New events default to today when it is visible, else the date in view.
  const todayVisible =
    view === "month" ? todayKey.slice(0, 7) === date.slice(0, 7) : dayKeys.includes(todayKey);
  const defaultNewDate = todayVisible ? todayKey : view === "week" ? dayKeys[0] : date;

  const browserTz =typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => go(view, todayKey)}>
            Today
          </Button>
          <div className="flex">
            <NavButton label="Previous" onClick={() => step(-1)}>
              <ChevronLeft className="size-4" />
            </NavButton>
            <NavButton label="Next" onClick={() => step(1)}>
              <ChevronRight className="size-4" />
            </NavButton>
          </div>
          <h2 className="ml-1 truncate text-[15px] font-semibold tracking-tight text-ink" aria-live="polite">
            {title}
          </h2>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 md:justify-end">
          <Legend />
          <div className="flex items-center gap-2">
            <Segmented label="Calendar view" value={view} options={VIEW_OPTIONS} onChange={(v) => go(v, date)} />
            <Button size="sm" onClick={() => openNew(defaultNewDate)} disabled={disabled} aria-label="New event">
              <Plus className="size-3.5" /> <span className="hidden sm:inline">Event</span>
            </Button>
          </div>
        </div>
      </div>

      <div className={cn("transition-opacity", navigating && "opacity-60")} aria-busy={navigating}>
        {view === "month" ? (
          <MonthGrid
            dayKeys={dayKeys}
            monthKey={date}
            occurrences={occurrences}
            conflicts={conflicts}
            areas={areas}
            timeZone={timeZone}
            todayKey={todayKey}
            onOpenDay={(k) => go("day", k)}
            onSelect={setSelected}
            onCreate={(k) => openNew(k)}
          />
        ) : (
          <TimeGrid
            dayKeys={dayKeys}
            occurrences={occurrences}
            conflicts={conflicts}
            areas={areas}
            timeZone={timeZone}
            todayKey={todayKey}
            now={now}
            compact={view === "week"}
            onSelect={setSelected}
            onCreate={openNew}
            onOpenDay={(k) => go("day", k)}
          />
        )}
      </div>

      {now && browserTz && browserTz !== timeZone && (
        <p className="text-[12px] text-ink-3">
          Times are shown in your profile time zone ({timeZone.replaceAll("_", " ")}). Change it in Settings.
        </p>
      )}

      <UnplacedTray
        items={unplaced}
        areas={areas}
        disabled={disabled}
        onPlace={(event) =>
          setEditor({
            mode: "edit",
            event,
            occurrence: null,
            initial: newEventForm(view === "day" ? date : todayKey, 16 * 60, timeZone, now, event),
          })
        }
      />

      <Dialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.event.title ?? ""}
        size="sm"
      >
        {selected && (
          <EventDetails
            occurrence={selected}
            conflicts={conflicts.get(selected.key) ?? []}
            areas={areas}
            timeZone={timeZone}
            disabled={disabled}
            onEdit={() => {
              const occ = selected;
              setSelected(null);
              setEditor({
                mode: "edit",
                event: occ.event,
                occurrence: occ,
                initial: formFromEvent(occ.event, occ, timeZone),
              });
            }}
            onDone={() => setSelected(null)}
          />
        )}
      </Dialog>

      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === "create" ? "New event" : "Edit event"}
      >
        {editor && (
          <EventEditor
            target={editor}
            areas={areas}
            occurrences={occurrences}
            onDone={() => setEditor(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[12px] text-ink-3">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-4 rounded-sm border-l-[3px] border-[var(--area-slate)] bg-[var(--area-slate-soft)]" />
        <Lock className="size-3" /> Fixed
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-4 rounded-sm border border-dashed border-[var(--area-slate)]" />
        <MoveVertical className="size-3" /> Flexible
      </span>
      <span className="hidden items-center gap-1 sm:flex">
        <TriangleAlert className="size-3 text-danger" /> Overlap
      </span>
    </div>
  );
}
