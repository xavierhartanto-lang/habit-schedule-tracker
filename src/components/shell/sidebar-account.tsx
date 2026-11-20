import { getSessionUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/db/profiles";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { LogOut } from "lucide-react";

/** Signed-in account summary for the sidebar footer. Render inside <Suspense>. */
export async function SidebarAccount() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="rounded-xl border border-dashed border-white/15 p-3 text-[12px] leading-relaxed text-sidebar-ink-2">
        <span className="font-medium text-sidebar-ink">Preview mode.</span> Add Supabase keys to enable sign in.
      </div>
    );
  }

  const user = await getSessionUser();
  if (!user) return null;
  const profile = await getProfile(user.id);
  const name = profile?.displayName ?? user.email ?? "You";

  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-2 py-2">
      <span className="brand-gradient grid size-8 place-items-center rounded-full text-[13px] font-semibold text-white">
        {name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-sidebar-ink">{name}</p>
        {user.email && <p className="truncate text-[12px] text-sidebar-ink-2">{user.email}</p>}
      </div>
      <form action="/auth/signout" method="post">
        <button
          type="submit"
          aria-label="Sign out"
          className="grid size-8 place-items-center rounded-lg text-sidebar-ink-2 transition-colors hover:bg-sidebar-hover hover:text-sidebar-ink"
        >
          <LogOut className="size-4" />
        </button>
      </form>
    </div>
  );
}

export function SidebarAccountSkeleton() {
  return <div className="h-12 animate-pulse rounded-xl bg-sidebar-hover" />;
}
