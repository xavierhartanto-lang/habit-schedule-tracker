import type { LifeArea } from "./types";

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
