import { getSessionUser } from "@/lib/auth/session";
import { getPreferences, getProfile } from "@/lib/db/profiles";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { Bell, ChevronRight, Shapes, UserRound } from "lucide-react";
import Link from "next/link";
import { DEFAULT_PREFERENCES, DEFAULT_PROFILE } from "./defaults";
import { PreferencesForm, ProfileForm } from "./forms";
import { AssistantForm } from "./assistant-form";
import { getAssistantSettings } from "@/features/proactive/actions";
import type { AssistantSettings } from "@/features/proactive/types";

const DEFAULT_ASSISTANT: AssistantSettings = { proactivity: "balanced", quietHoursStart: "22:00", quietHoursEnd: "07:00" };

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", DEFAULT_PROFILE.timezone];
  }
}

/** Reads the session and persisted settings. Render inside <Suspense>. */
export async function SettingsContent() {
  const configured = isSupabaseConfigured();
  const user = configured ? await getSessionUser() : null;
  const [profile, prefs, assistant] = user
    ? await Promise.all([
        getProfile(user.id),
        getPreferences(user.id),
        getAssistantSettings().catch(() => null),
      ])
    : [null, null, null];

  return (
    <div className="space-y-6">
      {!user && (
        <div className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2">
          {configured
            ? "Sign in to edit and save your settings."
            : "Preview mode: connect Supabase to save settings. Showing defaults."}
        </div>
      )}
      <Link
        href="/about-you"
        className="group flex items-center gap-3 rounded-2xl border border-border bg-surface px-5 py-4 shadow-card transition-colors hover:border-border-strong"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <UserRound className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">What Whitespace knows</span>
          <span className="block text-[13px] text-ink-3">Review and edit your commitments, goals, routines and preferences.</span>
        </span>
        <ChevronRight className="size-4 text-ink-3 transition-transform group-hover:translate-x-0.5" />
      </Link>
      <Link
        href="/areas"
        className="group flex items-center gap-3 rounded-2xl border border-border bg-surface px-5 py-4 shadow-card transition-colors hover:border-border-strong"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Shapes className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Life areas</span>
          <span className="block text-[13px] text-ink-3">Create, rename, recolor and remove the areas you organize around.</span>
        </span>
        <ChevronRight className="size-4 text-ink-3 transition-transform group-hover:translate-x-0.5" />
      </Link>
      <Link
        href="/school-schedule"
        className="group flex items-center gap-3 rounded-2xl border border-border bg-surface px-5 py-4 shadow-card transition-colors hover:border-border-strong"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Bell className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">School schedule</span>
          <span className="block text-[13px] text-ink-3">Bell times, late starts and A/B days. Plans stay out of class.</span>
        </span>
        <ChevronRight className="size-4 text-ink-3 transition-transform group-hover:translate-x-0.5" />
      </Link>
      <ProfileForm
        profile={profile ?? DEFAULT_PROFILE}
        email={user?.email ?? null}
        timezones={timezones()}
        disabled={!user}
      />
      <AssistantForm
        settings={assistant?.ok ? assistant.settings : DEFAULT_ASSISTANT}
        disabled={!user || (assistant !== null && !assistant.ok)}
      />
      <PreferencesForm prefs={prefs ?? DEFAULT_PREFERENCES} disabled={!user} />
    </div>
  );
}
