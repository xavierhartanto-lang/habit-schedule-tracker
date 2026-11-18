"use client";

import { Button, Field, Input } from "@/components/ui";
import { signIn, signUp, type AuthFormState } from "@/lib/auth/actions";
import { cn } from "@/lib/utils/cn";
import { useActionState, useState } from "react";

export function LoginForm({ next, configured }: { next: string; configured: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [signInState, signInAction, signInPending] = useActionState<AuthFormState, FormData>(signIn, undefined);
  const [signUpState, signUpAction, signUpPending] = useActionState<AuthFormState, FormData>(signUp, undefined);

  const state = mode === "signin" ? signInState : signUpState;
  const action = mode === "signin" ? signInAction : signUpAction;
  const pending = signInPending || signUpPending;

  return (
    <div>
      <div role="tablist" className="mb-6 grid grid-cols-2 rounded-lg border border-border bg-surface-2 p-0.5">
        {(["signin", "signup"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              "h-8 rounded-md text-[13px] font-medium transition-all",
              mode === m ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {m === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <fieldset disabled={!configured || pending} className="space-y-4">
          {mode === "signup" && (
            <Field label="Name">
              <Input name="name" autoComplete="name" placeholder="What should we call you?" />
            </Field>
          )}
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required placeholder="you@school.edu" />
          </Field>
          <Field label="Password">
            <Input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
          </Field>
        </fieldset>

        {state?.error && <p className="text-[13px] text-danger">{state.error}</p>}
        {state?.message && <p className="text-[13px] text-success">{state.message}</p>}
        {!configured && (
          <p className="text-[13px] text-ink-3">Sign in is unavailable until Supabase keys are added.</p>
        )}

        <Button type="submit" className="w-full" disabled={!configured || pending}>
          {pending ? "One moment…" : mode === "signin" ? "Sign in" : "Create account"}
        </Button>
      </form>
    </div>
  );
}
