import "server-only";

import { isAiConfigured } from "@/lib/ai/config";
import { listConversations } from "@/lib/db/conversations";
import { listMessages } from "@/lib/db/messages";
import { listPlansForConversation, toPlanView } from "@/lib/db/plans";
import { getProfile } from "@/lib/db/profiles";
import { expandEvents } from "@/lib/scheduling/recurrence";
import {
  addDaysToKey,
  dateKeyInZone,
  daysBetweenKeys,
  formatDateKey,
  formatTimeInZone,
  isoWeekdayOfKey,
  minutesInZone,
  startOfDayInZone,
} from "@/lib/scheduling/zoned";
import { dueParts } from "@/lib/domain/tasks";
import { toChatMessage, type ChatMessage } from "@/features/assistant/types";
import { HOME_DAYS_AHEAD, LOOKAHEAD_DAYS, loadHomeData } from "./home-data";
import { loadHomeIntel } from "./home-intel";
import type { HomeProactive } from "./proactive";
import { buildOpening, partOfDay, type Opening, type OpeningDeadline } from "./opening";
import { summarizeWeek, type WeekSummary } from "./week-summary";

/**
 * Everything the Home assistant panel needs, from real data only.
 * Reads cookies and the clock: render callers inside <Suspense>.
 */

export type HomeAssistantData =
  | { state: "preview"; greeting: string }
  | { state: "signed-out"; greeting: string }
  | { state: "error"; greeting: string }
  | {
      state: "ready";
      aiConfigured: boolean;
      opening: Opening;
      /** Today's assistant conversation, so Home picks up where the user left off. */
      conversationId: string | null;
      messages: ChatMessage[];
      week: WeekSummary;
      timeZone: string;
      /** "YYYY-MM-DD" in the user's time zone. */
      todayKey: string;
      /** Phase 5: the daily brief and gentle suggestions (empty when there's nothing worth raising). */
      proactive: HomeProactive;
    };

const RESUME_MESSAGES = 40;

const weekdayName = (key: string) => formatDateKey(key, { weekday: "long" });
const shortDate = (key: string) => formatDateKey(key, { month: "short", day: "numeric" });

export async function loadHomeAssistant(): Promise<HomeAssistantData> {
  const { ctx, events, openTasks, error } = await loadHomeData();
  const now = new Date();
  const hour = Math.floor(minutesInZone(now, ctx.timeZone) / 60);
  if (ctx.state !== "ready") return { state: ctx.state, greeting: partOfDay(hour) };
  if (error) return { state: "error", greeting: "Welcome back" };

  const tz = ctx.timeZone;
  const today = ctx.todayKey;
  const aiConfigured = isAiConfigured();
  const [profile, conversations, intel] = await Promise.all([
    getProfile(ctx.userId).catch(() => null),
    listConversations(ctx.userId, { kind: "assistant", limit: 1 }).catch(() => []),
    // Shared with the adaptive rail; the engine runs once per page load.
    loadHomeIntel(),
  ]);
  const proactive = intel.home;

  // ---- Occurrences: today and the next week ----
  const from = startOfDayInZone(today, tz);
  const to = startOfDayInZone(addDaysToKey(today, LOOKAHEAD_DAYS), tz);
  const occurrences = expandEvents(events, from, to, tz);

  const remainingToday = occurrences
    .filter((o) => dateKeyInZone(o.start, tz) === today && (o.allDay || o.end > now))
    .map((o) => ({
      title: o.event.title,
      start: o.start.toISOString(),
      end: o.end.toISOString(),
      allDay: o.allDay,
      time: formatTimeInZone(o.start, tz),
    }));

  // ---- Deadlines: task due dates (incl. overdue) and fixed commitments ahead ----
  const deadlines: OpeningDeadline[] = [];
  const taskDeadlines: { dateKey: string }[] = [];
  for (const t of openTasks) {
    const due = dueParts(t.dueAt, tz);
    if (!due) continue;
    const days = daysBetweenKeys(today, due.date);
    if (days < -7 || days > 13) continue;
    taskDeadlines.push({ dateKey: due.date });
    deadlines.push({
      title: t.title,
      kind: "task",
      days,
      weekday: weekdayName(due.date),
      date: shortDate(due.date),
      priority: t.priority,
    });
  }
  for (const o of occurrences) {
    // One-off fixed events only: a weekly practice isn't a deadline.
    if (o.event.kind !== "fixed" || o.event.recurrenceRule) continue;
    const key = dateKeyInZone(o.start, tz);
    const days = daysBetweenKeys(today, key);
    if (days < 1 || days > 13) continue;
    deadlines.push({ title: o.event.title, kind: "event", days, weekday: weekdayName(key), date: shortDate(key) });
  }

  const firstName = profile?.displayName?.trim().split(/\s+/)[0] ?? null;
  const opening = buildOpening({
    firstName,
    hour,
    isoWeekday: isoWeekdayOfKey(today),
    remainingToday,
    deadlines,
    empty: events.length === 0 && openTasks.length === 0,
  });

  const weekEnd = addDaysToKey(today, HOME_DAYS_AHEAD);
  const days = Array.from({ length: HOME_DAYS_AHEAD }, (_, i) => addDaysToKey(today, i));
  const week = summarizeWeek(
    days,
    occurrences.filter((o) => dateKeyInZone(o.start, tz) < weekEnd).map((o) => ({
      dateKey: dateKeyInZone(o.start, tz),
      minutes: Math.round((o.end.getTime() - o.start.getTime()) / 60000),
      kind: o.event.kind,
      allDay: o.allDay,
    })),
    taskDeadlines,
  );

  // ---- Resume today's conversation, if there is one ----
  let conversationId: string | null = null;
  let messages: ChatMessage[] = [];
  const latest = conversations[0];
  if (latest && dateKeyInZone(new Date(latest.lastMessageAt), tz) === today) {
    try {
      const [rows, plans] = await Promise.all([
        listMessages(ctx.userId, latest.id, { limit: RESUME_MESSAGES }),
        listPlansForConversation(ctx.userId, latest.id),
      ]);
      messages = rows.map((m) => {
        const plan = plans.get(m.id);
        return toChatMessage(m, plan ? toPlanView(plan) : null);
      });
      conversationId = latest.id;
    } catch {
      messages = [];
    }
  }

  return { state: "ready", aiConfigured, opening, conversationId, messages, week, timeZone: tz, todayKey: today, proactive };
}
