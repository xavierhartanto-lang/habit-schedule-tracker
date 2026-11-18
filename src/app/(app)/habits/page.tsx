import { Button, PageHeader } from "@/components/ui";
import { GoalList } from "@/features/habits/goal-list";
import { HabitList } from "@/features/habits/habit-list";
import { Plus } from "lucide-react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Habits & Goals" };

export default function HabitsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Habits & Goals"
        description="Consistency over intensity. Track what you repeat and where it leads."
        actions={
          <>
            <Button variant="secondary" size="sm" disabled><Plus className="size-3.5" /> Habit</Button>
            <Button size="sm" disabled><Plus className="size-3.5" /> Goal</Button>
          </>
        }
      />
      <HabitList />
      <GoalList />
    </div>
  );
}
