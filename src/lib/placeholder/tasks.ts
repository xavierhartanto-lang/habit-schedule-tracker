import type { Task } from "@/lib/domain/types";

export const SAMPLE_TASKS: Task[] = [
  { id: "t1", title: "Finish AP Chem problem set 6", area: "academics", priority: "high", status: "todo", dueAt: "2026-01-02", estimatedMinutes: 90 },
  { id: "t2", title: "Outline rebuttal for Thursday's round", area: "extracurricular", priority: "high", status: "in_progress", dueAt: "2026-01-03", estimatedMinutes: 45 },
  { id: "t3", title: "Email coach about meet schedule", area: "athletics", priority: "medium", status: "todo", dueAt: "2026-01-04", estimatedMinutes: 10 },
  { id: "t4", title: "Read chapters 7–8 of The Great Gatsby", area: "academics", priority: "medium", status: "todo", dueAt: "2026-01-05", estimatedMinutes: 60 },
  { id: "t5", title: "Order new rosin and strings", area: "creative", priority: "low", status: "todo", dueAt: null, estimatedMinutes: 10 },
];
