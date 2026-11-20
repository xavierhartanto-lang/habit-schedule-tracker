import { Suspense, type ReactNode } from "react";
import { MobileTabBar, MobileTopBar } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { SidebarAccount, SidebarAccountSkeleton } from "./sidebar-account";
import { TimeZoneSync } from "./timezone-sync";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:pl-[15.75rem]">
      <Sidebar
        footer={
          <Suspense fallback={<SidebarAccountSkeleton />}>
            <SidebarAccount />
          </Suspense>
        }
      />
      <MobileTopBar />
      <main className="mx-auto w-full max-w-6xl lg:max-w-[1360px] px-4 pb-[calc(var(--tabbar-h)+2.5rem)] pt-6 sm:px-6 lg:px-4 lg:pb-3 lg:pt-3 has-[[data-fullbleed]]:max-w-none has-[[data-fullbleed]]:p-0">
        {children}
      </main>
      <MobileTabBar />
      <TimeZoneSync />
    </div>
  );
}
