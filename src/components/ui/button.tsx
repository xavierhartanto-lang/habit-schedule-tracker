import { cn } from "@/lib/utils/cn";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover shadow-[0_6px_16px_-8px_var(--accent)]",
  secondary: "bg-surface-2 text-ink border border-transparent hover:border-border hover:bg-surface",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-2 active:bg-surface-2",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 pointer-coarse:h-10 pointer-coarse:px-3.5",
  md: "h-10 px-4 text-sm gap-2 pointer-coarse:h-11",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(
    "inline-flex select-none items-center justify-center rounded-xl font-semibold whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClasses(variant, size, className)} {...props} />;
}
