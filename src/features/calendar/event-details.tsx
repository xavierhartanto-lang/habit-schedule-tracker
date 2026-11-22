"use client";

import { Badge, Button, LifeAreaLabel } from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { describeRecurrence, parseRRule, type Occurrence } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, formatDateKey, formatTimeInZone } from "@/lib/scheduling/zoned";
import { buttonClasses } from "@/components/ui";
import { CalendarSync, ExternalLink, Lock, MapPin, MoveVertical, PenLine, Repeat, Trash2, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { removeEvent, type DeleteScope } from "./actions";

export function describeWhen(occ: Occurrence, timeZone: string): string {
  const startKey = dateKeyInZone(occ.start, timeZone);
  const day = (k: string) => formatDateKey(k, { weekday: "long", month: "long", day: "numeric" });
  if (occ.allDay) {
    const lastKey = addDaysToKey(dateKeyInZone(occ.end, timeZone), -1);
    return lastKey > startKey ? `${day(startKey)} – ${day(lastKey)} · All day` : `${day(startKey)} · All day`;
  }
  const endKey = dateKeyInZone(occ.end, timeZone);
  const start = formatTimeInZone(occ.start, timeZone);
  const end = formatTimeInZone(occ.end, timeZone);
  return endKey === startKey ? `${day(startKey)} · ${start} – ${end}` : `${day(startKey)} ${start} – ${day(endKey)} ${end}`;
}

export function EventDetails({
  occurrence: occ,
  conflicts,
  areas,
  timeZone,
  disabled,
  onEdit,
  onDone,
}: {
  occurrence: Occurrence;
  conflicts: string[];
  areas: LifeAreaRecord[];
  timeZone: string;
  disabled: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const e = occ.event;
  const imported = e.externalSource === "google";
  const rule = parseRRule(e.recurrenceRule);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const remove = (scope: DeleteScope) =>
    start(async () => {
      setError(null);
      const r = await removeEvent({ id: e.id, scope, occurrenceDate: occ.date });
      if (r.ok) onDone();
      else setError(r.error);
    });

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm text-ink-2">
        <p>{describeWhen(occ, timeZone)}</p>
        {rule && (
          <p className="flex items-center gap-1.5 text-[13px] text-ink-3">
            <Repeat className="size-3.5" /> {describeRecurrence(rule)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <LifeAreaLabel area={findArea(areas, e.lifeAreaId)} />
          <Badge className="font-normal">
            {e.kind === "fixed" ? (
              <>
                <Lock className="size-3" /> Fixed
              </>
            ) : (
              <>
                <MoveVertical className="size-3" /> Flexible
              </>
            )}
          </Badge>
          {imported && (
            <Badge className="font-normal">
              <CalendarSync className="size-3" /> Google Calendar
            </Badge>
          )}
        </div>
        {e.location && (
          <p className="flex items-center gap-1.5 text-[13px]">
            <MapPin className="size-3.5 text-ink-3" /> {e.location}
          </p>
        )}
        {e.notes && <p className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[13px]">{e.notes}</p>}
        {conflicts.length > 0 && (
          <p className="flex items-start gap-1.5 text-[13px] text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            Overlaps with {conflicts.join(", ")}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}

      {imported ? (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-[13px] text-ink-3">From Google Calendar. Change it there and Whitespace updates on its own.</p>
          {e.externalUrl && (
            <div className="flex justify-end">
              <a href={e.externalUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
                <ExternalLink className="size-3.5" /> Open in Google Calendar
              </a>
            </div>
          )}
        </div>
      ) : confirming ? (
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-[13px] font-medium text-ink">{rule ? "Delete which events?" : "Delete this event?"}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            {rule ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => remove("single")} disabled={pending}>
                  This event
                </Button>
                <Button variant="secondary" size="sm" onClick={() => remove("following")} disabled={pending}>
                  This and following
                </Button>
                <Button size="sm" className="bg-danger hover:bg-danger/90" onClick={() => remove("all")} disabled={pending}>
                  All events
                </Button>
              </>
            ) : (
              <Button size="sm" className="bg-danger hover:bg-danger/90" onClick={() => remove("all")} disabled={pending}>
                {pending ? "Deleting…" : "Delete"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={disabled}>
            <Trash2 className="size-3.5" /> Delete
          </Button>
          <Button size="sm" onClick={onEdit} disabled={disabled}>
            <PenLine className="size-3.5" /> Edit
          </Button>
        </div>
      )}
    </div>
  );
}
