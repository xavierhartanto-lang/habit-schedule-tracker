import { Notice } from "@/components/ui";
import { isMissingTemplates, listTemplates } from "@/lib/db/templates";
import { SupabaseNotConfiguredError } from "@/lib/db/client";
import { loadPlanningContext } from "@/features/shared/planning-context";
import { EMPTY_AUTOMATION_REPORT, type AutomationReport } from "@/lib/domain/templates";
import { stageDueRecurring } from "./server/stage";
import { AutomationsBoard } from "./automations-board";

/** Reads automations and sends any weekly email that is due. Render inside <Suspense>. */
export async function AutomationsContent() {
  const ctx = await loadPlanningContext();
  if (ctx.state !== "ready") {
    const note = ctx.state === "preview" ? "Preview mode: connect Supabase to save automations." : "Sign in to save automations.";
    return (
      <div className="space-y-4">
        <Notice>{note}</Notice>
        <AutomationsBoard templates={[]} report={EMPTY_AUTOMATION_REPORT} disabled />
      </div>
    );
  }

  const loaded = await loadBoard(ctx.userId);
  if (loaded.status === "ready") return <AutomationsBoard templates={loaded.templates} report={loaded.report} disabled={false} />;
  if (loaded.status === "missing") {
    return <Notice>Automations need the database update 20261205000000. Run it in Supabase, then refresh.</Notice>;
  }
  return <Notice tone="danger">Could not load automations. Refresh to try again.</Notice>;
}

async function loadBoard(userId: string): Promise<{ status: "missing" | "error" } | { status: "ready"; templates: Awaited<ReturnType<typeof listTemplates>>; report: AutomationReport }> {
  try {
    const now = new Date();
    const [report, templates] = await Promise.all([stageDueRecurring(userId, now), listTemplates(userId)]);
    return { status: "ready", templates, report };
  } catch (error) {
    if (error instanceof SupabaseNotConfiguredError || isMissingTemplates(error)) return { status: "missing" as const };
    return { status: "error" as const };
  }
}
