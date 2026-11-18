"use client";

import type { LifeAreaRecord } from "@/lib/domain/types";
import { createContext, useContext, type ReactNode } from "react";

const LifeAreasContext = createContext<LifeAreaRecord[]>([]);

/** Makes the user's life areas available to the edit forms on this page. */
export function LifeAreasProvider({ areas, children }: { areas: LifeAreaRecord[]; children: ReactNode }) {
  return <LifeAreasContext.Provider value={areas}>{children}</LifeAreasContext.Provider>;
}

export function useLifeAreas(): LifeAreaRecord[] {
  return useContext(LifeAreasContext);
}
