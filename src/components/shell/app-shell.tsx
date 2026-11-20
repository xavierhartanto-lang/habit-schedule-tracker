import { Suspense, type ReactNode } from "react";
import { MobileTabBar, MobileTopBar } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { SidebarAccount, SidebarAccountSkeleton } from "./sidebar-account";
import { TimeZoneSync } from "./timezone-sync";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:pl-64">
      <Sidebar
        footer={
          <Suspense fallback={<SidebarAccountSkeleton />}>
            <SidebarAccount />
          </Suspense>
        }
      />
      <MobileTopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-[calc(var(--tabbar-h)+2.5rem)] pt-6 sm:px-6 lg:px-10 lg:pb-12 lg:pt-10 has-[[data-fullbleed]]:max-w-none has-[[data-fullbleed]]:p-0">
        {children}
      </main>
      <MobileTabBar />
      <TimeZoneSync />
    </div>
  );
}
