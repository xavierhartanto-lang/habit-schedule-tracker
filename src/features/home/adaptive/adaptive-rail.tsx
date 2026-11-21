import { loadHomeData } from "../home-data";
import { loadHomeIntel } from "../home-intel";
import { RailNote, RailSection } from "../rail-section";
import { SectionCard } from "./sections";

/**
 * The adaptive part of Home (Layer B, then Layer C), beside "Your today"
 * on desktop and under it on phones. Tasks below it stay put (Layer A).
 * Render inside <Suspense>.
 */
/**
 * Home stays calm: only what needs action today (the adaptive layer), and
 * at most two of those. The context layer (progress, coming up, goals)
 * belongs to Insights and Calendar.
 */
const HOME_MAX_SECTIONS = 2;

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
      {intel.layout.sections
        .filter((s) => s.layer === "adaptive")
        .slice(0, HOME_MAX_SECTIONS)
        .map((s) => (
          <SectionCard key={s.id} section={s} ctx={view} />
        ))}
    </>
  );
}
