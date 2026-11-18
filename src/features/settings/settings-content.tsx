import { getSessionUser } from "@/lib/auth/session";
import { getPreferences, getProfile } from "@/lib/db/profiles";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { DEFAULT_PREFERENCES, DEFAULT_PROFILE } from "./defaults";
import { PreferencesForm, ProfileForm } from "./forms";

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
  const [profile, prefs] = user
    ? await Promise.all([getProfile(user.id), getPreferences(user.id)])
    : [null, null];

  return (
    <div className="space-y-6">
      {!user && (
        <div className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2">
          {configured
            ? "Sign in to edit and save your settings."
            : "Preview mode: connect Supabase to save settings. Showing defaults."}
        </div>
      )}
      <ProfileForm
        profile={profile ?? DEFAULT_PROFILE}
        email={user?.email ?? null}
        timezones={timezones()}
        disabled={!user}
      />
      <PreferencesForm prefs={prefs ?? DEFAULT_PREFERENCES} disabled={!user} />
    </div>
  );
}
