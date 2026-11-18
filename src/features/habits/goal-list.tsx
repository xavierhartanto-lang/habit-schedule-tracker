import { AreaLabel, Card, CardBody, CardHeader, Progress, SampleDataBadge } from "@/components/ui";
import { LIFE_AREAS } from "@/lib/domain/life-areas";
import { SAMPLE_GOALS } from "@/lib/placeholder";
import { cn } from "@/lib/utils/cn";
import { Check, Flag } from "lucide-react";

function formatTarget(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function GoalList() {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Personal goals</h2>
          <p className="text-[13px] text-ink-3">Longer arcs, broken into milestones.</p>
        </div>
        <SampleDataBadge />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {SAMPLE_GOALS.map((g) => {
          const done = g.milestones.filter((m) => m.done).length;
          const pct = (done / g.milestones.length) * 100;
          return (
            <Card key={g.id} className="flex flex-col">
              <CardHeader
                title={g.title}
                description={g.description}
                className="[&_h2]:leading-snug"
              />
              <CardBody className="flex flex-1 flex-col pt-3">
                <div className="flex items-center justify-between text-[12px] text-ink-3">
                  <AreaLabel area={g.area} />
                  {g.targetDate && (
                    <span className="flex items-center gap-1"><Flag className="size-3" /> {formatTarget(g.targetDate)}</span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <Progress value={pct} color={LIFE_AREAS[g.area].color} />
                  <span className="shrink-0 text-[12px] tabular-nums text-ink-2">{done}/{g.milestones.length}</span>
                </div>
                <ul className="mt-4 space-y-2">
                  {g.milestones.map((m) => (
                    <li key={m.id} className="flex items-center gap-2.5 text-[13px]">
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded-full border",
                          m.done ? "border-transparent bg-ink text-bg" : "border-border-strong",
                        )}
                      >
                        {m.done && <Check className="size-2.5" strokeWidth={3} />}
                      </span>
                      <span className={m.done ? "text-ink-3 line-through decoration-ink-3/40" : "text-ink"}>{m.title}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
