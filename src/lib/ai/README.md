# AI layer (not implemented)

This folder will hold everything model-related: prompt assembly, provider
client, tool definitions and response parsing. It must:

- Run on the server only. Never expose provider keys to the client.
- Read user data through `UserContextBuilder` (see `context.ts`), never ad-hoc queries.
- Respect `Preferences.aiPersonalizationEnabled` and `aiMemoryEnabled`.
- Never place events itself. It calls the scheduling engine in `lib/scheduling`.
