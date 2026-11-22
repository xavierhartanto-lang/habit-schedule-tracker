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
| `GOOGLE_CLIENT_ID` | for Google Calendar import | **no** | OAuth client ID (Web application). |
| `GOOGLE_CLIENT_SECRET` | for Google Calendar import | **no** | OAuth client secret. Also derives the key that encrypts stored Google tokens. |
| `GOOGLE_REDIRECT_URI` | no | **no** | Override for the OAuth redirect. Defaults to `<origin>/api/google/callback`. |

The service-role / secret key is **not used** and must never be given a `NEXT_PUBLIC_` prefix.

## Google Calendar

Settings → Google Calendar connects a Google account (scopes
`calendar.readonly` + `calendar.events`), lets the user pick calendars and a
life area for each, and imports events as fixed events. Google is the source
of truth. Every sync upserts events from two weeks back to six months ahead
(keyed on the Google event id, so no duplicates), removes ones deleted or
declined in Google, and runs on its own when the app is open (at most every
15 minutes) or from "Sync now".

Two-way: the assistant (and the event panel on the calendar) can remove,
move and rename Google events, one occurrence or the whole repeating series.
Google is written first, then Whitespace's copy is refreshed from Google's
answer. Every change has Undo, which restores Google too (deleted events come
back with the same id). Writes never email guests (`sendUpdates=none`).
Limits, enforced per event (`external_access`): view-only calendars can't be
changed; someone else's invite can be removed but not moved; a series can get
a new time on the same day, but its repeat day changes only in Google. Bulk
asks ("clear tomorrow") leave events with other guests alone. Connections made
before `calendar.events` was added stay read-only until the user reconnects.

Setup:

1. Google Cloud console → create a project → APIs & Services → Library →
   enable **Google Calendar API**.
2. Google Auth Platform → Get started: app name, support email, audience
   **External**. Data Access → add scopes
   `https://www.googleapis.com/auth/calendar.readonly` and
   `https://www.googleapis.com/auth/calendar.events`.
   Audience → add yourself as a test user.
3. Clients → Create client → **Web application** → Authorized redirect URI
   `http://localhost:3000/api/google/callback`.
4. Put the client ID and secret in `.env.local` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, run migrations `20261201000000_google_calendar_import.sql`
   and `20261202000000_google_calendar_write.sql`, and restart `npm run dev`.

While the Google app is in "Testing", Google expires the connection after 7
days and only listed test users can connect; reconnect from Settings. Letting
anyone else connect means publishing the app, and because `calendar.events`
is a sensitive scope, Google must verify the app first (privacy policy,
domain, demo video; it takes days to weeks).

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
    scheduling/             Calendar math, recurrence, and the scheduling engine (planner/, no LLM)
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
  The engine (`lib/scheduling/planner`) takes events, preferences and requests and returns
  proposed sessions with reasons, or an honest "doesn't fit". `checkPlacements` re-checks
  sessions against the current calendar right before anything is saved.
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
