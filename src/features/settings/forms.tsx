"use client";

import { Button, Card, CardBody, CardHeader, Field, Input, Select, Switch } from "@/components/ui";
import type { Preferences, Profile } from "@/lib/domain/types";
import { useActionState } from "react";
import { savePreferences, saveProfile, type SaveState } from "./actions";

function Status({ state, pending }: { state: SaveState; pending: boolean }) {
  if (pending) return <span className="text-[13px] text-ink-3">Saving…</span>;
  if (state?.error) return <span className="text-[13px] text-danger">{state.error}</span>;
  if (state?.ok) return <span className="text-[13px] text-success">Saved</span>;
  return null;
}

export function ProfileForm({
  profile,
  email,
  timezones,
  disabled,
}: {
  profile: Omit<Profile, "id">;
  email: string | null;
  timezones: string[];
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(saveProfile, undefined);
  return (
    <Card id="profile">
      <CardHeader title="Profile" description="How the app refers to you and where you are." />
      <CardBody>
        <form action={action} className="space-y-4">
          <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input name="displayName" defaultValue={profile.displayName ?? ""} placeholder="Your name" />
            </Field>
            <Field label="Email" hint="Managed by your sign-in.">
              <Input value={email ?? ""} placeholder="Not signed in" readOnly disabled />
            </Field>
            <Field label="Grade">
              <Select name="gradeLevel" defaultValue={profile.gradeLevel ?? ""}>
                <option value="">Prefer not to say</option>
                {[9, 10, 11, 12].map((g) => <option key={g} value={g}>Grade {g}</option>)}
                <option value="13">Gap year / post-grad</option>
              </Select>
            </Field>
            <Field label="School">
              <Input name="school" defaultValue={profile.school ?? ""} placeholder="Optional" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Time zone">
                <Select name="timezone" defaultValue={profile.timezone}>
                  {timezones.map((tz) => <option key={tz} value={tz}>{tz.replaceAll("_", " ")}</option>)}
                </Select>
              </Field>
            </div>
          </fieldset>
          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            <Status state={state} pending={pending} />
            <Button type="submit" size="sm" disabled={disabled || pending}>Save profile</Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function PreferencesForm({ prefs, disabled }: { prefs: Preferences; disabled: boolean }) {
  const [state, action, pending] = useActionState(savePreferences, undefined);
  return (
    <form action={action} className="space-y-6">
      <fieldset disabled={disabled} className="space-y-6">
        <Card id="preferences">
          <CardHeader title="Planning preferences" description="The shape of a normal day for you." />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="Day starts">
              <Input type="time" name="dayStartTime" defaultValue={prefs.dayStartTime} />
            </Field>
            <Field label="Day ends" hint="Nothing gets planned after this.">
              <Input type="time" name="dayEndTime" defaultValue={prefs.dayEndTime} />
            </Field>
            <Field label="Week starts on">
              <Select name="weekStartsOn" defaultValue={String(prefs.weekStartsOn)}>
                <option value="1">Monday</option>
                <option value="0">Sunday</option>
              </Select>
            </Field>
          </CardBody>
        </Card>

        <Card id="ai">
          <CardHeader
            title="Privacy & AI personalization"
            description="Decide what the assistant can learn. You can change this any time."
          />
          <CardBody className="divide-y divide-border pt-2">
            <Switch
              name="aiPersonalizationEnabled"
              label="Personalize suggestions"
              description="Let the assistant use your schedule, habits and goals to tailor its suggestions."
              defaultChecked={prefs.aiPersonalizationEnabled}
            />
            <Switch
              name="aiMemoryEnabled"
              label="Remember context between conversations"
              description="Keep useful details, like practice times, so you don't repeat yourself."
              defaultChecked={prefs.aiMemoryEnabled}
            />
            <Switch
              name="shareUsageAnalytics"
              label="Share anonymous usage data"
              description="Helps improve the product. Never includes your schedule or messages."
              defaultChecked={prefs.shareUsageAnalytics}
            />
          </CardBody>
        </Card>
      </fieldset>
      <div className="flex items-center justify-end gap-3">
        <Status state={state} pending={pending} />
        <Button type="submit" size="sm" disabled={disabled || pending}>Save preferences</Button>
      </div>
    </form>
  );
}
