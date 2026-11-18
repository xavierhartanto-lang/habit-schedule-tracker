import { dueParts } from "@/lib/domain/tasks";
import { addDaysToKey, formatDateKey, formatMinutes } from "@/lib/scheduling/zoned";

/** "Today", "Tomorrow, 3 PM", "Nov 30". Shared by the task list and Home. */
export function formatDue(dueAt: string | null, timeZone: string, todayKey: string): string | null {
  const due = dueParts(dueAt, timeZone);
  if (!due) return null;
  let day: string;
  if (due.date === todayKey) day = "Today";
  else if (due.date === addDaysToKey(todayKey, 1)) day = "Tomorrow";
  else if (due.date === addDaysToKey(todayKey, -1)) day = "Yesterday";
  else
    day = formatDateKey(due.date, {
      month: "short",
      day: "numeric",
      ...(due.date.slice(0, 4) !== todayKey.slice(0, 4) ? { year: "numeric" } : {}),
    });
  if (!due.time) return day;
  const [h, m] = due.time.split(":").map(Number);
  return `${day}, ${formatMinutes(h * 60 + m)}`;
}
