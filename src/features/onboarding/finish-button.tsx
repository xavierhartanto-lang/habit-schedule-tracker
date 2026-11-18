"use client";

import { buttonClasses } from "@/components/ui/button";
import { finishOnboarding } from "@/features/assistant/actions";
import { useState, useTransition } from "react";

/** Ends setup (finished or skipped) and goes home. Setup can be reopened anytime. */
export function FinishButton({
  label,
  variant = "primary",
  className,
}: {
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={className}>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await finishOnboarding();
            if (result?.error) setError(result.error);
          })
        }
        className={buttonClasses(variant, "sm", "w-full")}
      >
        {pending ? "One moment…" : label}
      </button>
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
