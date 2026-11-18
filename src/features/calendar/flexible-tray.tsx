import { AreaDot, Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { SAMPLE_TASKS } from "@/lib/placeholder";
import { formatDuration } from "@/lib/scheduling/time";

/**
 * Flexible work that still needs a time slot. In a later phase the
 * scheduling engine (lib/scheduling) will propose placements for these.
 */
export function FlexibleTray() {
  const items = SAMPLE_TASKS.filter((t) => t.estimatedMinutes && t.estimatedMinutes >= 30);
  return (
    <Card>
      <CardHeader
        title="Needs a time slot"
        description="Flexible work that is not on the calendar yet."
        action={<SampleDataBadge />}
      />
      <CardBody className="pt-3">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong px-3 py-2.5">
              <AreaDot area={t.area} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{t.title}</span>
              <span className="text-[12px] tabular-nums text-ink-3">{formatDuration(t.estimatedMinutes!)}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
