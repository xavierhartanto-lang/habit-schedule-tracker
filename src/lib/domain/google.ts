import type { Commitment } from "./types";

/**
 * What Whitespace may do to an event imported from Google Calendar.
 * "delete" removes it from the user's calendar; "edit" also moves and
 * renames it (events they organize, or whose organizer lets guests edit).
 */
export function isGoogleEvent(e: Pick<Commitment, "externalSource">): boolean {
  return e.externalSource === "google";
}

export function googleCan(e: Pick<Commitment, "externalSource" | "externalAccess">, need: "delete" | "edit"): boolean {
  if (e.externalSource !== "google") return false;
  return e.externalAccess === "edit" || (need === "delete" && e.externalAccess === "delete");
}

/** Why Whitespace can't make a change to a Google event, for the reply. */
export function googleRefusal(e: Pick<Commitment, "title" | "externalAccess">, need: "delete" | "edit"): string {
  if (!e.externalAccess || e.externalAccess === "read") {
    return `${e.title} is on a Google calendar Whitespace can only view (a calendar shared with the user read-only, or Google edit access isn't granted yet). Say it has to be changed in Google Calendar; if it's their own calendar, reconnecting Google in Settings lets Whitespace change it.`;
  }
  return need === "edit"
    ? `${e.title} is someone else's invite in Google Calendar, so only its organizer can move or rename it. Offer to remove it from their calendar instead.`
    : `${e.title} can't be changed from Whitespace.`;
}
