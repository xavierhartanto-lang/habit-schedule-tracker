import { cn } from "@/lib/utils/cn";
import type { TextareaHTMLAttributes } from "react";

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={3}
      className={cn(
        "w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink pointer-coarse:text-base placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus:border-accent/70 focus:outline-none focus:ring-[3px] focus:ring-accent/15 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
