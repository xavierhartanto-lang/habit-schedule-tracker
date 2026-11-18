import { areaColors } from "@/lib/domain/life-areas";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";

/** Color dot for a user-defined life area. Grey when uncategorized. */
export function LifeAreaDot({ area, className }: { area: LifeAreaRecord | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: areaColors(area).color }}
    />
  );
}

export function LifeAreaLabel({ area, className }: { area: LifeAreaRecord | null; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3", className)}>
      <LifeAreaDot area={area} />
      <span className="truncate">{area ? area.name : "No area"}</span>
    </span>
  );
}

/** <option>s for a life area <select>. Value "" means uncategorized. */
export function LifeAreaOptions({ areas, noneLabel = "No area" }: { areas: readonly LifeAreaRecord[]; noneLabel?: string }) {
  return (
    <>
      <option value="">{noneLabel}</option>
      {areas.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </>
  );
}
