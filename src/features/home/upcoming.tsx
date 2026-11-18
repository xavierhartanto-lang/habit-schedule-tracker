import { AreaDot, Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { SAMPLE_UPCOMING } from "@/lib/placeholder";

function relativeDay(n: number) {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  return `In ${n} days`;
}

export function Upcoming() {
  return (
    <Card>
      <CardHeader title="Coming up" description="The next few things that matter." action={<SampleDataBadge />} />
      <CardBody className="pt-3">
        <ul className="divide-y divide-border">
          {SAMPLE_UPCOMING.map((u) => (
            <li key={u.id} className="flex items-start gap-3 py-3 first:pt-1 last:pb-0">
              <AreaDot area={u.area} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug text-ink">{u.title}</p>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  {relativeDay(u.inDays)} · {u.time}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
