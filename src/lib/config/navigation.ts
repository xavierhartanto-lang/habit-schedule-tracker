import {
  CalendarDays,
  CircleCheck,
  Home,
  Shapes,
  LineChart,
  type LucideIcon,
  Settings,
  Sparkles,
  UserRound,
  Target,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar. Settings lives in the top bar instead. */
  mobile: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: Home, mobile: true },
  { href: "/calendar", label: "Calendar", icon: CalendarDays, mobile: true },
  { href: "/tasks", label: "Tasks", icon: CircleCheck, mobile: true },
  { href: "/habits", label: "Habits & Goals", shortLabel: "Habits", icon: Target, mobile: true },
  { href: "/assistant", label: "AI Assistant", shortLabel: "Assistant", icon: Sparkles, mobile: true },
  { href: "/insights", label: "Insights", icon: LineChart, mobile: false },
  { href: "/areas", label: "Life areas", icon: Shapes, mobile: false },
  { href: "/about-you", label: "What Whitespace knows", shortLabel: "About you", icon: UserRound, mobile: false },
  { href: "/settings", label: "Settings", icon: Settings, mobile: false },
];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
