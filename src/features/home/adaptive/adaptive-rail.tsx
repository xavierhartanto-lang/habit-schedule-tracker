import { loadHomeData } from "../home-data";
import { loadHomeIntel } from "../home-intel";
import { RailNote, RailSection } from "../rail-section";
import { SectionCard } from "./sections";

/**
 * The adaptive part of Home's rail (Layer B, then Layer C). Today's
 * schedule above it and Tasks below it stay put (Layer A).
 * Render inside <Suspense>.
 *
 * On phones and tablets the lead section moves up into the glance hub
 * (AdaptiveLead) and is hidden here, so it never shows twice.
 */
export async function AdaptiveRail() {
  const [{ ctx, error }, intel] = await Promise.all([loadHomeData(), loadHomeIntel()]);
  if (ctx.state !== "ready") return null;
  if (error || !intel.layout) {
    return (
      <RailSection title="What matters now">
        <RailNote tone={error ? "danger" : "muted"}>
          {error ? "Couldn't load your plan. Refresh to try again." : "Suggestions are unavailable right now. Your calendar and tasks still work."}
        </RailNote>
      </RailSection>
    );
  }
  const view = { timeZone: ctx.timeZone, todayKey: ctx.todayKey, areas: ctx.areas };
  return (
    <>
      {intel.layout.sections.map((s) => (
        <SectionCard key={s.id} section={s} ctx={view} className={s.lead ? "max-xl:hidden" : undefined} />
      ))}
    </>
  );
}

/** The lead section on phones and tablets, inside the glance hub above the conversation. */
export async function AdaptiveLead() {
  const [{ ctx }, intel] = await Promise.all([loadHomeData(), loadHomeIntel()]);
  const lead = intel.layout?.sections.find((s) => s.lead);
  if (ctx.state !== "ready" || !lead) return null;
  return (
    <SectionCard section={lead} ctx={{ timeZone: ctx.timeZone, todayKey: ctx.todayKey, areas: ctx.areas }} className="xl:hidden" />
  );
}
