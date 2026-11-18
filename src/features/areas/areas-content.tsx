import { Notice } from "@/components/ui";
import { countLifeAreaUsage } from "@/lib/db/life-areas";
import { loadPlanningContext, type PlanningContext } from "@/features/shared/planning-context";
import { AreaManager } from "./area-manager";

/** Reads the session and the user's life areas. Render inside <Suspense>. */
export async function AreasContent() {
  let ctx: PlanningContext;
  let usage: Record<string, number> = {};
  try {
    ctx = await loadPlanningContext();
    if (ctx.state === "ready") usage = await countLifeAreaUsage(ctx.userId);
  } catch {
    return <Notice tone="danger">Could not load your life areas. Refresh to try again.</Notice>;
  }

  return (
    <div className="space-y-4">
      {ctx.state === "preview" && <Notice>Preview mode: connect Supabase to create and edit life areas.</Notice>}
      {ctx.state === "signed-out" && <Notice>Sign in to customize your life areas.</Notice>}
      <AreaManager areas={ctx.areas} usage={usage} disabled={ctx.state !== "ready"} />
    </div>
  );
}
