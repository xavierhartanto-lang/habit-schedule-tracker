import { cn } from "@/lib/utils/cn";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const control =
  "h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "pr-8", className)} {...props} />;
}

/** Accessible switch built on a native checkbox so it works in plain forms. */
export function Switch({
  name,
  label,
  description,
  defaultChecked,
  disabled,
}: {
  name: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 py-3">
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-ink-3">{description}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          disabled={disabled}
          className="peer sr-only"
        />
        <span className="h-5 w-9 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-disabled:opacity-50" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}
