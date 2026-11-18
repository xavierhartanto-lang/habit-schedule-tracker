import { Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { SAMPLE_DAILY_LOAD } from "@/lib/placeholder";
import { formatDuration } from "@/lib/scheduling/time";

export function DailyLoad() {
  const max = Math.max(...SAMPLE_DAILY_LOAD.map((d) => d.scheduledMinutes));
  return (
    <Card className="h-full">
      <CardHeader title="Daily load" description="Scheduled hours per day" action={<SampleDataBadge />} />
      <CardBody>
        <div className="flex h-44 items-end gap-2.5">
          {SAMPLE_DAILY_LOAD.map((d) => {
            const heavy = d.scheduledMinutes === max;
            return (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-2">
                <span className="text-[11px] tabular-nums text-ink-3">{formatDuration(d.scheduledMinutes)}</span>
                <div
                  className="w-full rounded-md transition-all"
                  style={{
                    height: `${(d.scheduledMinutes / max) * 120}px`,
                    background: heavy ? "var(--accent)" : "var(--accent-soft)",
                  }}
                />
                <span className="text-[12px] font-medium text-ink-2">{d.day}</span>
              </div>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}
