"use client";

import { Badge, Button, Card, CardBody, CardHeader, LifeAreaOptions, Select, buttonClasses } from "@/components/ui";
import { useNow } from "@/lib/hooks/use-now";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";
import { CalendarSync, Check, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { disconnectGoogle, setGoogleCalendarArea, setGoogleCalendarSelected, syncGoogleNow } from "./actions";
import { GOOGLE_RETURN_MESSAGES } from "./constants";
import type { GoogleCalendarChoice, GoogleStatus } from "./types";

function ago(iso: string | null, now: Date | null): string {
  if (!iso) return "Not synced yet";
  if (!now) return "Synced";
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 1) return "Synced just now";
  if (min < 60) return `Synced ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `Synced ${h} h ago`;
  return `Synced ${Math.round(h / 24)} d ago`;
}

export function GoogleCalendarCard({
  status,
  areas,
  disabled,
}: {
  status: GoogleStatus;
  areas: LifeAreaRecord[];
  disabled: boolean;
}) {
  const params = useSearchParams();
  const returned = GOOGLE_RETURN_MESSAGES[params.get("google") ?? ""];
  const connected = status.state === "connected";

  return (
    <Card id="google-calendar" className="scroll-mt-6">
      <CardHeader
        title="Google Calendar"
        description="Your Google events, on Whitespace's calendar. Ask Whitespace to draft an email and it sends only after you press Send."
        action={connected ? <Badge className="font-normal text-success"><Check className="size-3" /> Connected</Badge> : undefined}
      />
      <CardBody className="space-y-4">
        {returned && (
          <p role="status" className={cn("text-[13px]", returned.tone === "success" ? "text-success" : "text-danger")}>
            {returned.text}
          </p>
        )}
        {status.state === "connected" ? (
          <Connected status={status} areas={areas} disabled={disabled} />
        ) : (
          <NotConnected state={status.state} disabled={disabled} />
        )}
      </CardBody>
    </Card>
  );
}

function NotConnected({ state, disabled }: { state: Exclude<GoogleStatus["state"], "connected">; disabled: boolean }) {
  if (state === "not_configured") {
    return (
      <p className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2">
        Not set up yet. Add <code className="font-mono text-[12px]">GOOGLE_CLIENT_ID</code> and{" "}
        <code className="font-mono text-[12px]">GOOGLE_CLIENT_SECRET</code> to <code className="font-mono text-[12px]">.env.local</code>, then restart the app.
      </p>
    );
  }
  if (state === "needs_migration") {
    return (
      <p className="rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2">
        Needs the database update <code className="font-mono text-[12px]">20261201000000</code>. Run it in Supabase, then refresh.
      </p>
    );
  }
  if (state === "unavailable") {
    return <p className="text-[13px] text-danger">Couldn&apos;t load your Google connection. Refresh to try again.</p>;
  }
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[13px] text-ink-2">Classes, games and meetings from Google show up here, kept in sync.</p>
      {disabled ? (
        <Button size="sm" disabled>
          <CalendarSync className="size-3.5" /> Connect Google Calendar
        </Button>
      ) : (
        // A plain link: connecting is a full-page trip to Google and back.
        <a href="/api/google/connect" className={buttonClasses("primary", "sm")}>
          <CalendarSync className="size-3.5" /> Connect Google Calendar
        </a>
      )}
    </div>
  );
}

function Connected({
  status,
  areas,
  disabled,
}: {
  status: Extract<GoogleStatus, { state: "connected" }>;
  areas: LifeAreaRecord[];
  disabled: boolean;
}) {
  const now = useNow();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string; summary?: string }>, okText?: string) =>
    start(async () => {
      setMessage(null);
      const r = await fn();
      if (!r.ok) setMessage({ ok: false, text: r.error ?? "Something went wrong." });
      else if (r.summary || okText) setMessage({ ok: true, text: r.summary ?? okText! });
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-[13px]">
          {status.email && <p className="truncate font-medium text-ink">{status.email}</p>}
          <p className="text-ink-3">{ago(status.lastSyncedAt, now)} · Refreshes on its own every 15 min</p>
        </div>
        <Button variant="secondary" size="sm" disabled={disabled || pending} onClick={() => run(syncGoogleNow)}>
          <RefreshCw className={cn("size-3.5", pending && "animate-spin")} /> {pending ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {!status.canWrite && (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <span>Whitespace can only read your Google Calendar. Reconnect so it can change events, and send an email after you approve it.</span>
          <a href="/api/google/connect" className={buttonClasses("secondary", "sm", "shrink-0")}>
            Reconnect
          </a>
        </div>
      )}

      {status.canWrite && !status.canSend && (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <span>Email isn&apos;t allowed yet. Reconnect Google and allow sending. Whitespace still waits for you to press Send.</span>
          <a href="/api/google/connect" className={buttonClasses("secondary", "sm", "shrink-0")}>
            Reconnect
          </a>
        </div>
      )}

      {status.lastError && !message && (
        <p className="flex items-start gap-1.5 text-[13px] text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {status.lastError}{" "}
            {status.lastError.startsWith("Google access expired") && (
              <a href="/api/google/connect" className="font-semibold underline underline-offset-2">Reconnect</a>
            )}
          </span>
        </p>
      )}
      {message && (
        <p role="status" className={cn("text-[13px]", message.ok ? "text-success" : "text-danger")}>
          {message.text}
        </p>
      )}

      <div>
        <p className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Calendars to import</p>
        {status.calendars.length === 0 ? (
          <p className="text-[13px] text-ink-3">No calendars yet. Press Sync now.</p>
        ) : (
          <ul className="divide-y divide-border">
            {status.calendars.map((c) => (
              <CalendarRow key={c.id} calendar={c} areas={areas} disabled={disabled || pending} onRun={run} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {confirming ? (
          <>
            <span className="mr-auto text-[13px] text-ink-2">Remove every imported event from Whitespace?</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-danger hover:bg-danger/90"
              disabled={pending}
              onClick={() => run(disconnectGoogle)}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled={disabled || pending} onClick={() => setConfirming(true)}>
            <Unplug className="size-3.5" /> Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

function CalendarRow({
  calendar: c,
  areas,
  disabled,
  onRun,
}: {
  calendar: GoogleCalendarChoice;
  areas: LifeAreaRecord[];
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, okText?: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <span className="relative inline-flex shrink-0">
          <input
            type="checkbox"
            className="peer sr-only"
            checked={c.selected}
            disabled={disabled}
            onChange={(e) => {
              const on = e.target.checked;
              onRun(() => setGoogleCalendarSelected(c.id, on), on ? `${c.name} imported.` : `${c.name} removed from Whitespace.`);
            }}
          />
          <span className="h-5 w-9 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-disabled:opacity-50" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out peer-checked:translate-x-4" />
        </span>
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? "var(--ink-3)" }} aria-hidden />
        <span className="min-w-0 truncate text-sm text-ink">
          {c.name}
          {c.primary && <span className="ml-1.5 text-[12px] text-ink-3">Main</span>}
        </span>
      </label>
      {c.selected && (
        <Select
          aria-label={`Life area for ${c.name}`}
          className="h-8 w-full text-[13px] sm:w-44"
          value={c.lifeAreaId ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value || null;
            onRun(() => setGoogleCalendarArea(c.id, v));
          }}
        >
          <LifeAreaOptions areas={areas} noneLabel="No life area" />
        </Select>
      )}
    </li>
  );
}
