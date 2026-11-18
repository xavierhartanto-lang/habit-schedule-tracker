import type { AreaColor, LifeArea, LifeAreaRecord } from "./types";

/**
 * Legacy fixed categories. Records now point at a user-defined life area
 * (LifeAreaRecord); these remain for AI proposals and sample screens.
 */
export const LIFE_AREAS: Record<LifeArea, { label: string; color: string; soft: string }> = {
  academics: { label: "Academics", color: "var(--cat-academics)", soft: "var(--cat-academics-soft)" },
  extracurricular: { label: "Extracurricular", color: "var(--cat-extracurricular)", soft: "var(--cat-extracurricular-soft)" },
  athletics: { label: "Athletics", color: "var(--cat-athletics)", soft: "var(--cat-athletics-soft)" },
  creative: { label: "Creative", color: "var(--cat-creative)", soft: "var(--cat-creative-soft)" },
  personal: { label: "Personal", color: "var(--cat-personal)", soft: "var(--cat-personal-soft)" },
  rest: { label: "Rest", color: "var(--cat-rest)", soft: "var(--cat-rest-soft)" },
};

export const LIFE_AREA_ORDER: LifeArea[] = [
  "academics",
  "extracurricular",
  "athletics",
  "creative",
  "personal",
  "rest",
];

// ---------- User-defined life areas ----------

/** Palette users pick from. Values are CSS variables in globals.css. */
export const AREA_COLORS: readonly AreaColor[] = [
  "blue",
  "violet",
  "green",
  "amber",
  "pink",
  "slate",
  "teal",
  "orange",
  "cyan",
  "brown",
];

export const AREA_COLOR_LABELS: Record<AreaColor, string> = {
  blue: "Blue",
  violet: "Violet",
  green: "Green",
  amber: "Amber",
  pink: "Pink",
  slate: "Slate",
  teal: "Teal",
  orange: "Orange",
  cyan: "Cyan",
  brown: "Brown",
};

export const LIFE_AREA_NAME_MAX = 40;

/** Strong and soft colors for an area, or neutral grey when uncategorized. */
export function areaColors(area: Pick<LifeAreaRecord, "color"> | null | undefined): {
  color: string;
  soft: string;
} {
  if (!area) return { color: "var(--area-none)", soft: "var(--area-none-soft)" };
  return { color: `var(--area-${area.color})`, soft: `var(--area-${area.color}-soft)` };
}

export function isAreaColor(value: unknown): value is AreaColor {
  return typeof value === "string" && (AREA_COLORS as readonly string[]).includes(value);
}

/** Looks up an area by id. Unknown or null ids read as uncategorized. */
export function findArea(
  areas: readonly LifeAreaRecord[],
  id: string | null | undefined,
): LifeAreaRecord | null {
  if (!id) return null;
  return areas.find((a) => a.id === id) ?? null;
}

/** Resolves a record's area: prefers lifeAreaId, falls back to the legacy enum. */
export function areaOf(
  areas: readonly LifeAreaRecord[],
  record: { lifeAreaId?: string | null; area?: LifeArea | null },
): LifeAreaRecord | null {
  if (record.lifeAreaId) return findArea(areas, record.lifeAreaId);
  if (record.area) return areas.find((a) => a.legacyKey === record.area) ?? null;
  return null;
}

export type LifeAreaInput = { name: string; color: AreaColor };

export function validateLifeAreaInput(
  raw: unknown,
): { ok: true; value: LifeAreaInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing life area." };
  const input = raw as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, error: "Give the area a name." };
  if (name.length > LIFE_AREA_NAME_MAX) {
    return { ok: false, error: `Keep the name under ${LIFE_AREA_NAME_MAX} characters.` };
  }
  if (!isAreaColor(input.color)) return { ok: false, error: "Pick a color." };
  return { ok: true, value: { name, color: input.color } };
}
