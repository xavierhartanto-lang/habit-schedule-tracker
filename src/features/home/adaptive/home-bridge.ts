"use client";

import type { Nudge, ProactiveChip } from "../proactive";

/**
 * Home's buttons hand their work to the assistant sheet, which runs it
 * exactly like a chip in the chat: the result comes back there as a normal
 * approval card. Nothing is changed from Home itself.
 */
export const HOME_ACT_EVENT = "whitespace:home-act";
/** Opens the assistant sheet without asking it to do anything. */
export const HOME_OPEN_EVENT = "whitespace:home-open";

export type HomeActDetail = { chip: ProactiveChip; nudge: Nudge | null };

export function sendToHomeChat(detail: HomeActDetail): void {
  window.dispatchEvent(new CustomEvent<HomeActDetail>(HOME_ACT_EVENT, { detail }));
}

export function openHomeAssistant(): void {
  window.dispatchEvent(new Event(HOME_OPEN_EVENT));
}
