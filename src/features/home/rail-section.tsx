import { cn } from "@/lib/utils/cn";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One section of Home's side rail. Deliberately not a card: a quiet label,
 * an optional link, and the content. Sections are separated by space alone.
 */
export function RailSection({
  title,
  meta,
  href,
  hrefLabel,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  href?: string;
  hrefLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = `rail-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={cn("min-w-0", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-[13px] font-medium text-ink">
          {title}
          {meta && <span className="ml-2 font-normal tabular-nums text-ink-3">{meta}</span>}
        </h2>
        {href && (
          <Link
            href={href}
            className="rounded text-[12px] text-ink-3 transition-colors hover:text-accent-ink"
          >
            {hrefLabel}
          </Link>
        )}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Quiet one-line empty or error state inside a rail section. */
export function RailNote({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" }) {
  return (
    <p
      className={cn(
        "rounded-lg border border-dashed border-border px-3 py-3 text-[13px] leading-relaxed",
        tone === "danger" ? "text-danger" : "text-ink-3",
      )}
    >
      {children}
    </p>
  );
}
