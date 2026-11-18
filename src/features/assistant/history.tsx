import { SampleDataBadge } from "@/components/ui";
import { SAMPLE_THREADS } from "@/lib/placeholder";
import { cn } from "@/lib/utils/cn";
import { Plus } from "lucide-react";

export function ConversationHistory() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border lg:flex">
      <div className="flex items-center justify-between px-4 py-3.5">
        <p className="text-[13px] font-semibold text-ink">Conversations</p>
        <button aria-label="New conversation" disabled className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface-2">
          <Plus className="size-4" />
        </button>
      </div>
      <ul className="flex-1 space-y-0.5 px-2">
        {SAMPLE_THREADS.map((t, i) => (
          <li key={t.id}>
            <div
              className={cn(
                "rounded-lg px-3 py-2",
                i === 0 ? "bg-surface-2 text-ink" : "text-ink-2",
              )}
            >
              <p className="truncate text-[13px] font-medium">{t.title}</p>
              <p className="text-[11px] text-ink-3">{t.when}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="px-4 py-3">
        <SampleDataBadge />
      </div>
    </aside>
  );
}
