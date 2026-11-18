"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthFormState = { error?: string; message?: string } | undefined;

function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function signIn(_: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Supabase is not configured yet." };

  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (error) return { error: error.message };
  redirect(safeNext(formData.get("next")));
}

export async function signUp(_: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "Supabase is not configured yet." };

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      data: { display_name: String(formData.get("name") ?? "").trim() || null },
    },
  });
  if (error) return { error: error.message };
  if (!data.session) return { message: "Check your email to confirm your account." };
  redirect("/");
}
