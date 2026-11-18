import { formatDuration } from "@/lib/scheduling/time";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { loadHomeAssistant } from "./assistant-data";

/** Four plain facts about the next seven days. Render inside <Suspense>. */
export async function WeekGlance() {
  const data = await loadHomeAssistant();
  if (data.state !== "ready") return null;
  const w = data.week;
  const facts = [
    { label: "Commitments", value: String(w.commitments) },
    { label: "Scheduled", value: w.scheduledMinutes ? formatDuration(w.scheduledMinutes) : "0h" },
    { label: "Deadlines", value: String(w.deadlines) },
    {
      label: w.busiestDay ? "Busiest day" : "Open days",
      value: w.busiestDay ? formatDateKey(w.busiestDay, { weekday: "short" }) : String(w.openDays),
    },
  ];
  return (
    <section aria-labelledby="week-glance" className="rounded-2xl border border-border bg-surface px-5 py-4 shadow-card">
      <h2 id="week-glance" className="text-[13px] font-semibold tracking-tight text-ink">
        Next 7 days
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{f.label}</dt>
            <dd className="mt-0.5 text-[17px] font-semibold tabular-nums tracking-tight text-ink">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
