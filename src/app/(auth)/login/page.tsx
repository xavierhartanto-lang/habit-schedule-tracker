import { Brand } from "@/components/shell/brand";
import { LoginForm } from "@/features/auth/login-form";
import { APP_TAGLINE } from "@/lib/config/app";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Sign in" };

async function Form({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const params = await searchParams;
  const raw = typeof params.next === "string" ? params.next : "/";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  return <LoginForm next={next} configured={isSupabaseConfigured()} />;
}

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-sm animate-fade-up">
        <Brand />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-ink">{APP_TAGLINE}</h1>
        <p className="mt-1.5 text-[15px] text-ink-2">
          School, practice, projects and rest, planned in one place.
        </p>
        <div className="mt-8 rounded-2xl border border-border bg-surface p-6 shadow-card">
          <Suspense fallback={<div className="h-64" />}>
            <Form searchParams={props.searchParams} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
