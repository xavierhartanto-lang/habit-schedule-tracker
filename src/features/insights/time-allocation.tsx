import { AreaDot, Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { LIFE_AREAS } from "@/lib/domain/life-areas";
import { SAMPLE_ALLOCATION } from "@/lib/placeholder";
import { formatDuration } from "@/lib/scheduling/time";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export function TimeAllocation() {
  const total = SAMPLE_ALLOCATION.reduce((s, a) => s + a.minutes, 0);
  return (
    <Card>
      <CardHeader
        title="Where your time went"
        description={`${formatDuration(total)} of scheduled time this week`}
        action={<SampleDataBadge />}
      />
      <CardBody>
        {/* Stacked bar */}
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2">
          {SAMPLE_ALLOCATION.map((a) => (
            <div
              key={a.area}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(a.minutes / total) * 100}%`, background: LIFE_AREAS[a.area].color }}
              title={`${LIFE_AREAS[a.area].label}: ${formatDuration(a.minutes)}`}
            />
          ))}
        </div>

        <ul className="mt-5 grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {SAMPLE_ALLOCATION.map((a) => {
            const delta = a.minutes - a.lastWeek;
            const Arrow = delta >= 0 ? ArrowUpRight : ArrowDownRight;
            return (
              <li key={a.area} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0 sm:[&:nth-last-child(2)]:border-0">
                <AreaDot area={a.area} />
                <span className="flex-1 text-sm text-ink">{LIFE_AREAS[a.area].label}</span>
                <span className="text-sm tabular-nums text-ink">{formatDuration(a.minutes)}</span>
                <span className="flex w-16 items-center justify-end gap-0.5 text-[12px] tabular-nums text-ink-3">
                  <Arrow className="size-3" />
                  {formatDuration(Math.abs(delta))}
                </span>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
