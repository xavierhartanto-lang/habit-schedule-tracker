# Whitespace

An AI-powered life manager for high-achieving high school students balancing
academics, extracurriculars, athletics, creative work and rest.

> The app name is set in `src/lib/config/app.ts`.

**Status:** Phase 1 foundation. Design system, app shell, page skeletons,
Supabase auth and schema. No AI functionality yet.

## Stack

- Next.js 16 (App Router, Cache Components, Turbopack)
- React 19, TypeScript
- Tailwind CSS 4
- Supabase Auth + Postgres with Row Level Security (`@supabase/ssr`)
- `lucide-react` for icons

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: the app runs in preview mode without it
npm run dev                  # http://localhost:3000
```

Without Supabase keys the app runs in **preview mode**: every page renders with
sample data, sign-in is disabled, and settings can't be saved.

Other scripts: `npm run build`, `npm run start`, `npm run lint`, `npm test` (unit tests, no network).

## Supabase setup

1. Create a project at supabase.com.
2. Copy the project URL and publishable key (Project Settings → API) into `.env.local`.
3. Apply the migration in `supabase/migrations/`:
   - **CLI:** `npx supabase link --project-ref <ref>` then `npx supabase db push`
   - **Dashboard:** paste the SQL file into the SQL Editor and run it.
4. Auth → URL Configuration: set Site URL to `http://localhost:3000` and add
   `http://localhost:3000/auth/callback` as a redirect URL.
5. Optional for faster local testing: disable "Confirm email" under Auth → Providers → Email.

The signup trigger creates a `profiles` row and a `user_preferences` row for every new user.

## Environment variables

| Name | Required | Exposed to browser | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | for auth | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | for auth | yes | Publishable key (or use `NEXT_PUBLIC_SUPABASE_ANON_KEY` on older projects) |
| `NEXT_PUBLIC_SITE_URL` | recommended | yes | Base URL for email confirmation links |
| `ANTHROPIC_API_KEY` | for AI | **no** | Server-side key for the assistant. Without it the app shows an "AI not configured" state. |
| `WHITESPACE_AI_MODEL` | no | **no** | Model override. Defaults to `claude-opus-5-5`. |

The service-role / secret key is **not used** and must never be given a `NEXT_PUBLIC_` prefix.

## Project structure

```
src/
  app/                      Routes only. Thin pages that compose features.
    (app)/                  Signed-in area with the app shell
      page.tsx              Home
      calendar/ assistant/ habits/ insights/ settings/
    (auth)/login/           Sign in / create account
    auth/callback/          Email confirmation code exchange
    auth/signout/           POST sign-out
  proxy.ts                  Session refresh + optimistic auth redirect (Next 16 "proxy", formerly middleware)
  components/
    ui/                     Design system primitives (Button, Card, Field, Badge…)
    shell/                  Sidebar, mobile top bar and tab bar
  features/<section>/       Section-specific UI, one folder per page
  lib/
    config/                 App name, navigation
    domain/                 Domain types and pure business logic
    scheduling/             Calendar math + scheduling engine contract (no LLM)
    ai/                     AI context contract (not implemented)
    auth/                   Session lookup and auth server actions
    db/                     Data access (server-only) + database types
    supabase/               Browser, server and proxy Supabase clients
    placeholder/            SAMPLE DATA ONLY, always shown with a "Sample data" badge
    hooks/ utils/
supabase/migrations/        SQL migrations
```

### Architecture rules

- **UI** (`components/`, `features/`) never queries Supabase directly. It calls `lib/db` via server components or server actions.
- **Database access** lives in `lib/db` and is `server-only`. Queries run as the signed-in user so RLS applies.
- **Auth** lives in `lib/auth`. `getSessionUser()` is the one way to ask who is signed in.
- **Business logic** lives in `lib/domain` as pure functions.
- **Scheduling** lives in `lib/scheduling` and is deterministic. It never calls an LLM.
- **AI** lives in `lib/ai`. It will read a structured `UserContext` and call the scheduling engine, never place events itself.
- **Placeholder data** lives only in `lib/placeholder` and must render with `<SampleDataBadge />`.

## Design system

Tokens are CSS variables in `src/app/globals.css`, mapped to Tailwind utilities
(`bg-surface`, `text-ink-2`, `border-border`, `bg-accent`…). Light and dark themes follow the OS.

- Neutrals: warm paper background, ink text.
- Accent: a calm iris (`--accent`), used sparingly for focus and the current state.
- Life areas each have a muted color and a soft tint (`--cat-academics`, `--cat-athletics`…).
- Fixed commitments: solid tinted block with a lock icon. Flexible work: dashed outline with a move icon.
- Font: Geist. Motion: short fade-ups only, disabled for reduced-motion users.
