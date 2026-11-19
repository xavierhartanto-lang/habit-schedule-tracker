"use client";

import { cn } from "@/lib/utils/cn";

/** Small segmented control (tabs-like) for views and filters. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex rounded-lg border border-border bg-surface-2 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 flex-1 whitespace-nowrap rounded-md px-3 text-[13px] font-medium pointer-coarse:h-9 pointer-coarse:active:scale-[0.97] transition-[background-color,color,box-shadow] duration-150",
            value === o.value ? "bg-surface text-ink shadow-card ring-1 ring-inset ring-border" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
