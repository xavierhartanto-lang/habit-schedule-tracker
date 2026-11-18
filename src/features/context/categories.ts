import type { ContextCategory } from "@/lib/domain/types";
import { Clock3, Heart, Repeat, SlidersHorizontal, Users, type LucideIcon } from "lucide-react";

/** Labels and copy for each context item category on the review page. */
export const CATEGORY_COPY: Record<
  ContextCategory,
  {
    anchor: string;
    title: string;
    singular: string;
    description: string;
    empty: string;
    placeholder: string;
    icon: LucideIcon;
  }
> = {
  activity: {
    anchor: "activities",
    title: "Activities",
    singular: "Activity",
    description: "Clubs, teams and projects you are part of.",
    empty: "No activities yet. Mention your clubs or projects to the assistant, or add them here.",
    placeholder: "Robotics club, school newspaper, volunteering",
    icon: Users,
  },
  interest: {
    anchor: "interests",
    title: "Interests",
    singular: "Interest",
    description: "Hobbies and things you enjoy.",
    empty: "No interests yet.",
    placeholder: "Film photography, chess, cooking",
    icon: Heart,
  },
  routine: {
    anchor: "routines",
    title: "Routines",
    singular: "Routine",
    description: "Patterns in your week, like sleep, workouts or commute.",
    empty: "No routines yet.",
    placeholder: "Asleep by 11, gym before school",
    icon: Repeat,
  },
  working_time: {
    anchor: "working-times",
    title: "Working times",
    singular: "Working time",
    description: "When you do your best focused work.",
    empty: "No working times yet. Tell the assistant when you focus best.",
    placeholder: "Deep work after dinner",
    icon: Clock3,
  },
  preference: {
    anchor: "preferences",
    title: "Scheduling preferences",
    singular: "Preference",
    description: "Rules for how your time should be planned.",
    empty: "No preferences yet.",
    placeholder: "No homework after 10 PM, keep Sundays light",
    icon: SlidersHorizontal,
  },
};
