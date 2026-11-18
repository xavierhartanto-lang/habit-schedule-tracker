import { Brain, ShieldCheck } from "lucide-react";
import Link from "next/link";

/** Explains what the assistant will know. Builds trust before it exists. */
export function ContextPanel() {
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 border-l border-border p-5 xl:flex">
      <div>
        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <Brain className="size-4 text-accent" /> What it will know
        </p>
        <ul className="mt-3 space-y-2 text-[13px] text-ink-2">
          <li>Your fixed commitments and practice times</li>
          <li>Flexible work and deadlines</li>
          <li>Habits and goals you are working on</li>
          <li>Preferred study hours and bedtime</li>
        </ul>
      </div>
      <div className="rounded-xl bg-surface-2 p-3.5">
        <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <ShieldCheck className="size-4 text-success" /> You stay in control
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          Suggestions never change your calendar without your OK. Turn personalization off any time.
        </p>
        <Link href="/settings#ai" className="mt-2 inline-block text-[12px] font-medium text-accent-ink hover:underline">
          AI settings
        </Link>
      </div>
    </aside>
  );
}
