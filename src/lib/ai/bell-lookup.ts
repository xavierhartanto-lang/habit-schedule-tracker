import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { bellScheduleSchema, newDayTypeId, type BellSchedule } from "@/lib/domain/school-schedule";
import { WEEKDAYS, type Weekday } from "@/lib/domain/types";
import { fallbackParams, getAiClient } from "./client";
import { AiError, toAiError } from "./errors";

/**
 * Best-effort bell schedule lookup for onboarding.
 *
 *   1. A web-search call finds the school's published bell schedule and
 *      writes plain notes with exact times and the pages they came from.
 *   2. A structured-output call turns those notes into a schedule.
 *
 * The result is only ever a pre-fill for an editable card: nothing is
 * saved here, and anything not traced to a page the search actually
 * opened is discarded instead of shown as fact.
 */

export type BellLookupResult =
  | {
      found: true;
      schedule: BellSchedule;
      schoolName: string | null;
      /** Pages the times came from (only URLs the search actually returned). */
      sources: string[];
      /** Anything the user should double-check, in one short sentence. */
      caveat: string | null;
    }
  | { found: false; reason: string };

const SEARCH_SYSTEM = `You find a US high school's official daily bell schedule for the current school year.

Search the web. Prefer the school's own website or the district's website. Open the most relevant page to read exact times. Be quick: a few searches at most.

Then write short notes:
- The school's full name and the page URL(s) the times came from.
- Each distinct day type (regular day, late start, early release, block/A-B days) with the weekdays it applies to, and every period with exact start and end times in 24h HH:MM, including lunch.
- Whether the school rotates A/B days.
- The school year the schedule is for, if shown.

Report only times you read on a page. Never estimate or fill gaps. If you can't find a schedule for this exact school, or the times are ambiguous (several lunches, unclear grade levels), say NOT FOUND and why in one sentence.`;

const STRUCTURE_SYSTEM = `You convert research notes about a school bell schedule into JSON.

Rules:
- Use only times stated in the notes. Never invent or estimate a time.
- found = false when the notes say NOT FOUND, give no exact times, or are about a different school.
- confidence: high = official school/district page for the current year with exact times; medium = official page but year or day assignment unclear; low = anything else.
- Times are 24h "HH:MM". days use mo,tu,we,th,fr,sa,su.
- kind: "class" for instructional periods (including advisory/homeroom/flex), "lunch" for lunch, "break" for nutrition break or passing blocks listed as their own row.
- When the school has several lunch waves, use the first one and mention it in caveat.
- If a day type's weekdays aren't stated, assume Monday–Friday for the main schedule and leave others with an empty days list.
- sourceUrls: only URLs written in the notes.
- caveat: one short sentence on what to double-check, or empty.`;

const WireSchema = z.object({
  found: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  schoolName: z.string(),
  rotation: z.enum(["same", "ab"]),
  dayTypes: z.array(
    z.object({
      label: z.string(),
      days: z.array(z.enum(WEEKDAYS as [Weekday, ...Weekday[]])),
      periods: z.array(
        z.object({
          label: z.string(),
          start: z.string(),
          end: z.string(),
          kind: z.enum(["class", "lunch", "break"]),
        }),
      ),
    }),
  ),
  sourceUrls: z.array(z.string()),
  caveat: z.string(),
});

const MAX_CONTINUATIONS = 3;

export async function lookupBellSchedule(input: {
  school: string;
  district: string | null;
  signal?: AbortSignal;
}): Promise<BellLookupResult> {
  const school = input.school.trim().slice(0, 120);
  const district = input.district?.trim().slice(0, 120) || null;
  if (school.length < 2) return { found: false, reason: "No school name." };

  const { client, model } = getAiClient();

  // ---- 1. Search ----
  const query = `School: ${school}${district ? `\nDistrict / city: ${district}` : ""}\nToday: ${new Date().toISOString().slice(0, 10)}`;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: query }];
  const seenUrls = new Set<string>();
  let notes = "";

  try {
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 8_000,
          output_config: { effort: "low" },
          system: SEARCH_SYSTEM,
          tools: [
            { type: "web_search_20260209", name: "web_search", max_uses: 4 },
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
          ],
          messages,
          ...fallbackParams(model),
        },
        { signal: input.signal, timeout: 120_000 },
      );
      collectUrls(response.content, seenUrls);
      if (response.stop_reason === "refusal") throw new AiError("refused");
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      notes = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }
  } catch (error) {
    throw toAiError(error);
  }

  if (!notes || /\bNOT FOUND\b/.test(notes)) {
    return { found: false, reason: "No published schedule turned up for that school." };
  }

  // ---- 2. Structure ----
  let parsed: z.infer<typeof WireSchema> | null;
  try {
    const response = await client.beta.messages.parse(
      {
        model,
        max_tokens: 8_000,
        output_config: { effort: "low", format: zodOutputFormat(WireSchema) },
        system: STRUCTURE_SYSTEM,
        messages: [{ role: "user", content: `School asked about: ${school}${district ? ` (${district})` : ""}\n\nNotes:\n${notes}` }],
        ...fallbackParams(model),
      },
      { signal: input.signal },
    );
    if (response.stop_reason === "refusal") throw new AiError("refused");
    parsed = response.parsed_output ?? null;
  } catch (error) {
    if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
      throw new AiError("invalid_output", { cause: error });
    }
    throw toAiError(error);
  }

  return fromWire(parsed, seenUrls);
}

/** Pure: validates the model's JSON against what the search actually saw. Exported for tests. */
export function fromWire(wire: z.infer<typeof WireSchema> | null, seenUrls: ReadonlySet<string>): BellLookupResult {
  if (!wire || !wire.found) return { found: false, reason: "No published schedule turned up for that school." };
  if (wire.confidence === "low") return { found: false, reason: "What turned up wasn't reliable enough to use." };

  const sources = wire.sourceUrls.filter((u) => isHttpUrl(u) && seenUrls.has(normalizeUrl(u))).slice(0, 3);
  if (!sources.length) return { found: false, reason: "Couldn't trace those times to a real page." };

  const candidate = {
    rotation: wire.rotation,
    source: "lookup" as const,
    sourceUrls: sources,
    dayTypes: wire.dayTypes.slice(0, 5).map((dt, i) => ({
      id: i === 0 ? "regular" : newDayTypeId(),
      label: dt.label.trim().slice(0, 40) || (i === 0 ? "Regular day" : `Schedule ${i + 1}`),
      days: Array.from(new Set(dt.days)),
      periods: dt.periods.slice(0, 14).map((p) => ({ ...p, label: p.label.trim().slice(0, 40) || "Period" })),
    })),
  };
  // A weekday claimed by two day types: keep it on the first.
  const claimed = new Set<Weekday>();
  for (const dt of candidate.dayTypes) {
    dt.days = dt.days.filter((d) => (claimed.has(d) ? false : (claimed.add(d), true)));
  }

  const checked = bellScheduleSchema.safeParse(candidate);
  if (!checked.success) return { found: false, reason: "The schedule that turned up didn't add up." };

  return {
    found: true,
    schedule: checked.data,
    schoolName: wire.schoolName.trim() || null,
    sources,
    caveat: wire.caveat.trim().slice(0, 200) || null,
  };
}

function collectUrls(content: readonly Anthropic.Beta.BetaContentBlock[], into: Set<string>) {
  for (const block of content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === "web_search_result") into.add(normalizeUrl(r.url));
    } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
      into.add(normalizeUrl(block.content.url));
    }
  }
}

export function normalizeUrl(u: string): string {
  return u.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

function isHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
