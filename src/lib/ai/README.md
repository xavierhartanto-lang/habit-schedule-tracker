# AI layer

Everything model-related lives here. Server only: never import these modules
from a client component, and never expose `ANTHROPIC_API_KEY`.

| File | Purpose |
| --- | --- |
| `config.ts` | Reads `ANTHROPIC_API_KEY` / `WHITESPACE_AI_MODEL`. `isAiConfigured()`, `getAiStatus()` (safe for the client). |
| `client.ts` | Cached Anthropic SDK client. Throws `AiError("not_configured")` without a key. |
| `errors.ts` | `AiError` with a fixed set of codes and user-safe messages. `toAiError()` maps SDK errors. |
| `prompts.ts` | System prompts (onboarding, assistant, extraction), `PromptContext`, onboarding topic coverage. Pure. |
| `extraction.ts` | Structured-output schema, validated `ExtractedItem` types, `validateExtraction()`. Pure. |
| `service.ts` | `streamReply()` and `extractFacts()`: what route handlers call. |
| `context*.ts` | User context builder (data layer). |

## Rules

- No fake AI. Without a key, show the "not configured" state.
- Read user data through the context builder, never ad-hoc queries.
  Respect `aiPersonalizationEnabled` / `aiMemoryEnabled`.
- Extracted facts are proposals. Nothing is saved until the user confirms.
- Every extracted item must quote the user's own words (`evidence`).
  Items that don't, or that have malformed times/dates, are dropped.
- The AI never creates or moves events. Scheduling stays in `lib/scheduling`.
- Names of new tasks, events, sessions, habits and goals go through
  `lib/assistant/naming.ts` after the planner model: title case, no filler or
  dates, specifics only when the user said them or saved context establishes
  them, and existing names reused exactly. Sessions for a task use the task's name.

## Using it from a route handler

```ts
import { streamReply, extractFacts } from "@/lib/ai/service";
import { toAiError } from "@/lib/ai/errors";

try {
  for await (const chunk of streamReply({ mode, context, history })) send(chunk);
} catch (e) {
  send({ error: toAiError(e).toJSON() }); // { code, message, retryable }
}
```

Run `extractFacts()` on the user's message in parallel with the reply.
