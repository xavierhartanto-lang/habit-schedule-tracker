import { stageDueRecurring } from "./server/stage";
import { EMPTY_AUTOMATION_REPORT, type AutomationReport } from "@/lib/domain/templates";
import { loadPlanningContext } from "@/features/shared/planning-context";
import Link from "next/link";

async function runDue(): Promise<AutomationReport> {
  try {
    const ctx = await loadPlanningContext();
    if (ctx.state !== "ready") return EMPTY_AUTOMATION_REPORT;
    return await stageDueRecurring(ctx.userId, new Date());
  } catch {
    return EMPTY_AUTOMATION_REPORT;
  }
}

/** Home note after an automation sends, or when Gmail refused. */
export async function AutomationNotice() {
  const report = await runDue();
  if (!report.sent.length && !report.errors.length) return null;
  return (
    <Link href="/automations" className="block rounded-[20px] border border-border/70 bg-surface px-4 py-3 shadow-card">
      {report.sent.length > 0 && <p className="text-[13px] font-medium text-ink">Sent {report.sent.join(", ")}.</p>}
      {report.errors.map((message) => (
        <p key={message} className="mt-0.5 text-[12px] text-danger">{message}</p>
      ))}
    </Link>
  );
}
