"use client";

import { Card, CardBody, CardHeader, LifeAreaDot } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import type { Commitment, LifeAreaRecord } from "@/lib/domain/types";
import { formatDuration } from "@/lib/scheduling/time";
import { CalendarPlus } from "lucide-react";

/**
 * Flexible activities saved without a time (for example from onboarding).
 * The user places them; nothing is placed automatically.
 */
export function UnplacedTray({
  items,
  areas,
  disabled,
  onPlace,
}: {
  items: Commitment[];
  areas: LifeAreaRecord[];
  disabled: boolean;
  onPlace: (event: Commitment) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Needs a time"
        description="Flexible activities you mentioned that are not on the calendar yet."
      />
      <CardBody className="pt-3">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPlace(c)}
                disabled={disabled}
                className="group flex w-full items-center gap-3 rounded-xl border border-dashed border-border-strong px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-surface-2 disabled:opacity-60"
              >
                <LifeAreaDot area={findArea(areas, c.lifeAreaId)} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.title}</span>
                {c.estimatedMinutes ? (
                  <span className="text-[12px] tabular-nums text-ink-3">{formatDuration(c.estimatedMinutes)}</span>
                ) : null}
                <CalendarPlus className="size-4 shrink-0 text-ink-3 group-hover:text-accent" aria-label="Add to calendar" />
              </button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
