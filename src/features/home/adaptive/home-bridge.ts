"use client";

import type { Nudge, ProactiveChip } from "../proactive";

/**
 * The rail hands a suggestion's button to Home's conversation, which runs
 * it exactly like a chip in the chat: the result comes back there as a
 * normal approval card. Nothing is changed from the rail itself.
 */
export const HOME_ACT_EVENT = "whitespace:home-act";

export type HomeActDetail = { chip: ProactiveChip; nudge: Nudge | null };

export function sendToHomeChat(detail: HomeActDetail): void {
  window.dispatchEvent(new CustomEvent<HomeActDetail>(HOME_ACT_EVENT, { detail }));
}
