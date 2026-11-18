import { LIFE_AREAS } from "@/lib/domain/life-areas";
import type { LifeArea } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";

export function AreaDot({ area, className }: { area: LifeArea; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: LIFE_AREAS[area].color }}
    />
  );
}

export function AreaLabel({ area }: { area: LifeArea }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
      <AreaDot area={area} />
      {LIFE_AREAS[area].label}
    </span>
  );
}
