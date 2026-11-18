import {
  CalendarDays,
  Home,
  LineChart,
  type LucideIcon,
  Settings,
  Sparkles,
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
  { href: "/assistant", label: "AI Assistant", shortLabel: "Assistant", icon: Sparkles, mobile: true },
  { href: "/habits", label: "Habits & Goals", shortLabel: "Habits", icon: Target, mobile: true },
  { href: "/insights", label: "Insights", icon: LineChart, mobile: true },
  { href: "/settings", label: "Settings", icon: Settings, mobile: false },
];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
