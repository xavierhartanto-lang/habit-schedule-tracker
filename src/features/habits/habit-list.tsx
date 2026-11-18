import { AreaLabel, Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { LIFE_AREAS } from "@/lib/domain/life-areas";
import type { HabitCadence } from "@/lib/domain/types";
import { SAMPLE_HABITS } from "@/lib/placeholder";
import { Check } from "lucide-react";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

function cadenceLabel(c: HabitCadence) {
  return c.type === "daily" ? "Every day" : `${c.timesPerWeek}× a week`;
}

function target(c: HabitCadence) {
  return c.type === "daily" ? 7 : c.timesPerWeek;
}

export function HabitList() {
  return (
    <Card>
      <CardHeader
        title="Recurring habits"
        description="Small routines that support the bigger goals."
        action={<SampleDataBadge />}
      />
      <CardBody className="pt-3">
        <div className="mb-2 hidden grid-cols-[1fr_auto_88px] items-center gap-6 px-2 text-[11px] font-medium uppercase tracking-wide text-ink-3 sm:grid">
          <span>Habit</span>
          <span className="grid grid-cols-7 gap-1.5">
            {DAYS.map((d, i) => <span key={i} className="w-6 text-center">{d}</span>)}
          </span>
          <span className="text-right">This week</span>
        </div>
        <ul className="divide-y divide-border">
          {SAMPLE_HABITS.map((h) => {
            const color = LIFE_AREAS[h.area].color;
            return (
              <li key={h.id} className="grid grid-cols-1 gap-3 px-2 py-3.5 sm:grid-cols-[1fr_auto_88px] sm:items-center sm:gap-6">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{h.title}</p>
                  <div className="mt-0.5 flex items-center gap-3">
                    <AreaLabel area={h.area} />
                    <span className="text-[12px] text-ink-3">{cadenceLabel(h.cadence)}</span>
                  </div>
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {DAYS.map((d, i) => {
                    const done = h.doneOffsets.includes(i);
                    return (
                      <span
                        key={i}
                        aria-label={`${d}: ${done ? "done" : "not done"}`}
                        className="grid size-6 place-items-center rounded-md border transition-colors"
                        style={done ? { background: color, borderColor: color } : { borderColor: "var(--border)" }}
                      >
                        {done && <Check className="size-3.5 text-white" strokeWidth={3} />}
                      </span>
                    );
                  })}
                </div>
                <p className="text-[13px] tabular-nums text-ink-2 sm:text-right">
                  {h.doneOffsets.length} of {target(h.cadence)}
                </p>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
