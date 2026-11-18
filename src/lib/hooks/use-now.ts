"use client";

import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  const id = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(id);
};

let cached: { minute: number; date: Date } | null = null;
const getSnapshot = () => {
  const minute = Math.floor(Date.now() / 60_000);
  if (!cached || cached.minute !== minute) cached = { minute, date: new Date() };
  return cached.date;
};
const getServerSnapshot = () => null;

/**
 * Current time on the client, refreshed each minute.
 * Returns null during server prerender so the static shell never bakes in a time.
 */
export function useNow(): Date | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
