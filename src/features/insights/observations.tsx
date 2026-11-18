import { Card, CardBody, CardHeader, SampleDataBadge } from "@/components/ui";
import { SAMPLE_OBSERVATIONS } from "@/lib/placeholder";

export function Observations() {
  return (
    <Card className="h-full">
      <CardHeader
        title="Weekly observations"
        description="Patterns worth a second look."
        action={<SampleDataBadge />}
      />
      <CardBody className="space-y-3 pt-3">
        {SAMPLE_OBSERVATIONS.map((o) => (
          <div key={o.id} className="rounded-xl border border-border px-4 py-3">
            <p className="text-sm font-medium text-ink">{o.title}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{o.body}</p>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
