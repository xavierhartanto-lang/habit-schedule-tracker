import { APP_NAME } from "@/lib/config/app";
import { cn } from "@/lib/utils/cn";
import Link from "next/link";

/** The app mark: an indigo tile with the horizon glyph. `onDark` for the sidebar panel. */
export function Brand({ onDark = false }: { onDark?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg px-1 py-1">
      <span aria-hidden className="brand-gradient grid size-7 place-items-center rounded-[9px] text-white shadow-[0_4px_12px_-4px_rgb(79_70_229/0.6)]">
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 10.5c1.5-3 3-4.5 5-4.5s3.5 1.5 5 4.5" />
          <circle cx="8" cy="6" r="0.6" fill="currentColor" />
        </svg>
      </span>
      <span className={cn("text-[16px] font-bold tracking-[-0.02em]", onDark ? "text-sidebar-ink" : "text-ink")}>{APP_NAME}</span>
    </Link>
  );
}
