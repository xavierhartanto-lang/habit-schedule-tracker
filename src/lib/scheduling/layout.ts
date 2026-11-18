import type { Occurrence } from "./recurrence";
import { addDaysToKey, minutesInZone, startOfDayInZone } from "./zoned";

/**
 * Places timed occurrences in a day column. Overlapping events share the
 * width side by side. Pure: used by the calendar's day and week views.
 */

export type PlacedOccurrence = {
  occ: Occurrence;
  /** Minutes from local midnight, clipped to this day. */
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
  /** The occurrence continues from the previous day / into the next. */
  clippedStart: boolean;
  clippedEnd: boolean;
};

export function layoutDay(occurrences: readonly Occurrence[], dateKey: string, timeZone: string): PlacedOccurrence[] {
  const dayStart = startOfDayInZone(dateKey, timeZone);
  const dayEnd = startOfDayInZone(addDaysToKey(dateKey, 1), timeZone);

  const items = occurrences
    .filter((o) => !o.allDay && o.start < dayEnd && o.end > dayStart)
    .map((occ) => {
      const clippedStart = occ.start < dayStart;
      const clippedEnd = occ.end > dayEnd;
      const startMin = clippedStart ? 0 : minutesInZone(occ.start, timeZone);
      let endMin = clippedEnd ? 1440 : minutesInZone(occ.end, timeZone);
      if (endMin <= startMin) endMin = Math.min(1440, startMin + 15);
      return { occ, startMin, endMin, clippedStart, clippedEnd, column: 0, columns: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Group into clusters of transitively overlapping events, then assign
  // each event the first free column within its cluster.
  let cluster: typeof items = [];
  let clusterEnd = -1;
  const flush = () => {
    const columnEnds: number[] = [];
    for (const item of cluster) {
      let col = columnEnds.findIndex((end) => end <= item.startMin);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(item.endMin);
      } else {
        columnEnds[col] = item.endMin;
      }
      item.column = col;
    }
    for (const item of cluster) item.columns = columnEnds.length;
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length && item.startMin >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  if (cluster.length) flush();
  return items;
}

/** All-day occurrences that cover `dateKey`. */
export function allDayOn(occurrences: readonly Occurrence[], dateKey: string, timeZone: string): Occurrence[] {
  const dayStart = startOfDayInZone(dateKey, timeZone);
  const dayEnd = startOfDayInZone(addDaysToKey(dateKey, 1), timeZone);
  return occurrences.filter((o) => o.allDay && o.start < dayEnd && o.end > dayStart);
}

/** Every occurrence (timed or all-day) that touches `dateKey`, in start order. */
export function occurrencesOn(occurrences: readonly Occurrence[], dateKey: string, timeZone: string): Occurrence[] {
  const dayStart = startOfDayInZone(dateKey, timeZone);
  const dayEnd = startOfDayInZone(addDaysToKey(dateKey, 1), timeZone);
  return occurrences
    .filter((o) => o.start < dayEnd && o.end > dayStart)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
}
