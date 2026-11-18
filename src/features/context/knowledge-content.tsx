import { getSessionUser } from "@/lib/auth/session";
import { listCommitments } from "@/lib/db/commitments";
import { listContextItems } from "@/lib/db/context-items";
import { listGoals } from "@/lib/db/goals";
import { getPreferences, getProfile } from "@/lib/db/profiles";
import type { Commitment, ContextCategory, ContextItem, Goal } from "@/lib/domain/types";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { DEFAULT_PREFERENCES, DEFAULT_PROFILE } from "@/features/settings/defaults";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { CATEGORY_COPY } from "./categories";
import { formatTimeRange } from "./format";
import { CommitmentSection, ContextItemSection, GoalSection } from "./sections";

type Loaded = {
  commitments: Commitment[];
  goals: Goal[];
  items: ContextItem[];
};

const EMPTY: Loaded = { commitments: [], goals: [], items: [] };

/** Order the sections appear on the page. */
const LAYOUT: ({ kind: "commitments" } | { kind: "goals" } | { kind: "item"; category: ContextCategory })[] = [
  { kind: "commitments" },
  { kind: "item", category: "activity" },
  { kind: "goals" },
  { kind: "item", category: "routine" },
  { kind: "item", category: "working_time" },
  { kind: "item", category: "preference" },
  { kind: "item", category: "interest" },
];

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2">
      {children}
    </div>
  );
}

/** Reads the session and everything saved about the user. Render inside <Suspense>. */
export async function KnowledgeContent() {
  const configured = isSupabaseConfigured();
  const user = configured ? await getSessionUser() : null;

  let data = EMPTY;
  let loadError = false;
  let timeZone = DEFAULT_PROFILE.timezone;
  let prefs = DEFAULT_PREFERENCES;

  if (user) {
    try {
      const [commitments, goals, items, profile, preferences] = await Promise.all([
        listCommitments(user.id),
        listGoals(user.id),
        listContextItems(user.id),
        getProfile(user.id),
        getPreferences(user.id),
      ]);
      data = { commitments, goals, items };
      timeZone = profile?.timezone ?? timeZone;
      prefs = preferences ?? prefs;
    } catch {
      loadError = true;
    }
  }

  const disabled = !user || loadError;
  const all = [...data.commitments, ...data.goals, ...data.items];
  const fromChat = all.filter((x) => x.source === "conversation").length;
  const byCategory = (c: ContextCategory) => data.items.filter((i) => i.category === c);

  const counts: { anchor: string; label: string; n: number }[] = LAYOUT.map((s) =>
    s.kind === "commitments"
      ? { anchor: "commitments", label: "Commitments", n: data.commitments.length }
      : s.kind === "goals"
        ? { anchor: "goals", label: "Goals", n: data.goals.length }
        : { anchor: CATEGORY_COPY[s.category].anchor, label: CATEGORY_COPY[s.category].title, n: byCategory(s.category).length },
  );

  return (
    <div className="space-y-6">
      {!user && (
        <Notice>
          {configured
            ? "Sign in to see and edit what Whitespace knows about you."
            : "Preview mode: connect Supabase to save and edit what Whitespace knows."}
        </Notice>
      )}
      {loadError && (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[13px] text-danger">
          Could not load your saved information. Refresh to try again.
        </div>
      )}

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold tracking-tight text-ink">
              {all.length === 0
                ? "Nothing saved yet"
                : `${all.length} ${all.length === 1 ? "thing" : "things"} saved`}
            </p>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {all.length === 0
                ? "Facts you confirm in a chat, or add yourself, show up here."
                : `${fromChat} from chats you confirmed, ${all.length - fromChat} added by you.`}
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-surface-2 px-3.5 py-3 sm:max-w-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <p className="text-[12px] leading-relaxed text-ink-2">
              {prefs.aiMemoryEnabled
                ? "The assistant only uses what is on this page. Edit or delete anything."
                : "Memory is off, so the assistant ignores facts learned in chats."}{" "}
              <Link href="/settings#ai" className="font-medium text-accent-ink hover:underline">
                AI settings
              </Link>
            </p>
          </div>
        </div>

        <nav aria-label="Sections" className="-mx-1 mt-4 flex flex-wrap gap-1.5 border-t border-border pt-4">
          {counts.map((c) => (
            <a
              key={c.anchor}
              href={`#${c.anchor}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-ink"
            >
              {c.label}
              <span className={c.n ? "text-ink-3" : "text-ink-3/60"}>{c.n}</span>
            </a>
          ))}
        </nav>
      </section>

      {LAYOUT.map((s) => {
        if (s.kind === "commitments") {
          return <CommitmentSection key="commitments" items={data.commitments} timeZone={timeZone} disabled={disabled} />;
        }
        if (s.kind === "goals") {
          return <GoalSection key="goals" items={data.goals} disabled={disabled} />;
        }
        return (
          <div key={s.category}>
            <ContextItemSection category={s.category} items={byCategory(s.category)} disabled={disabled} />
            {s.category === "preference" && (
              <p className="mt-2 px-1 text-[12px] text-ink-3">
                Your day runs {formatTimeRange(prefs.dayStartTime, prefs.dayEndTime)}.{" "}
                <Link href="/settings#preferences" className="font-medium text-accent-ink hover:underline">
                  Change in Settings
                </Link>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
