# Local NPC seam and opt-in visit memory

The integrated local seam consists of:

- `web/src/lib/precinct/npcIdentity.ts`
- `web/src/lib/precinct/npcLocalAdapter.ts`
- `web/src/lib/precinct/npcVisitMemory.ts`
- `web/src/lib/precinct/npcLocalAdapter.test.ts`
- `web/src/lib/precinct/npcVisitMemory.test.ts`

## Exact seam

`replyToLocalNpc(request)` is synchronous and returns only `{ reply, voice_id }`.

```ts
import { replyToLocalNpc, validateNpcRequest, validateNpcResponse } from "./npcLocalAdapter";

const request = {
  npc_id: "sergeant",
  message: "How do I clarify an answer?",
  history: [{ role: "user", text: "hello" }],
};
const valid = validateNpcRequest(request); // {ok:true,value} or {ok:false,error}
const response = replyToLocalNpc(request); // {reply:string,voice_id:LocalVoiceId}
validateNpcResponse(response); // boolean type guard
```

The adapter accepts `unknown` at the boundary so invalid input safely gets a fixed technique redirect, rather than an exception. Its typed `NpcRequest` has exactly `npc_id`, `message`, and `history`; each history item has exactly `role: "user" | "assistant"` and `text`. Extra fields, privileged roles, unknown identities, controls, and oversized input are rejected. Limits: 600 UTF-16 code units per message/history turn, 12 history turns, 4,096 history text units total. Responses are capped at 1,200 units.

History is validated only for seam compatibility. It is never used to answer, infer facts, update memory, or decide anything about a case. The adapter does not retain conversation state. Its only runtime dependencies are the authored dialogue catalogue and the identity/visit-memory helpers here. No transport, model, API, account, case, session, result, or score imports/calls are involved.

Supported prompts are whole authored topic IDs or whole button labels from `STAFF_CONVERSATIONS`; case/whitespace and trailing punctuation are normalized. `hi`, `hello`, `hey`, `greet`, `greeting`, and `hello again` are also supported. There is deliberately no broad substring/intent matching. Unsupported prompts, embedded instructions, and case questions receive a neutral-questioning/evidence-review redirect without echoing user text. Do not advertise this fixed authored interface as an open-ended AI character.

Stable `npc_id` values exactly match existing scene staff: `receptionist`, `sergeant`, `analyst`, `patrol`. The first two have the authored topics; the others greet and direct to reception/the sergeant. Both talking staff remain available across all graphics tiers.

`voice_id` is an opaque, local presentation alias: `local-reception-v1`, `local-sergeant-v1`, `local-colleague-v1`, or `local-guide-v1`. These are not provider voice IDs, URLs, recordings, or a claim that audio exists. The seam does not play audio or call TTS. Render text by default; any later local audio implementation needs an explicit alias-to-local-asset mapping. Never forward them to a cloud voice service as if they were valid credentials or identifiers.

## Optional local visit memory

```ts
type NpcVisitMemory = {
  version: 1;
  displayName: string | null;
  colleagues: readonly { npc_id: NpcId; visits: number }[];
};
```

This is familiarity with staff, not memory of a training case. Maximum four known colleagues, at most 999 visits each, and a 40-unit preferred name. Only Unicode letters/marks, ordinary spaces, apostrophes and hyphens are allowed in names. Unknown versions, duplicate IDs, extra fields, invalid counters and unsafe names fail closed. There are no chat transcripts, timestamps, case facts, account IDs or assessments in storage.

Default to ephemeral empty memory. Offer an explicit “Remember my name and staff visits on this device” choice before loading/saving persistent memory, with a separate preferred-name field and “Forget local staff memory” control. Never extract a name from free text, an account, or the existing session. Render the preferred name and reply as ordinary escaped text, never as HTML. Do not log request/history/name contents.

```ts
import { createLocalNpcAdapter } from "./npcLocalAdapter";
import {
  emptyNpcVisitMemory, getNpcMemoryStorage, loadNpcVisitMemory,
  withNpcDisplayName, recordNpcVisit, saveNpcVisitMemory,
} from "./npcVisitMemory";

// Run on an explicit UI action, not import/render. `remember` is the user's opt-in.
const storage = remember ? getNpcMemoryStorage() : null;
let memory = remember ? loadNpcVisitMemory(storage).memory : emptyNpcVisitMemory();
// `preferredName` comes only from the user's separate preferred-name field.
const named = withNpcDisplayName(memory, preferredName);
if (named !== null) memory = named; // Show a validation hint on null; preserve prior memory.

// Build from the PRE-VISIT snapshot: the first conversation must not claim a prior meeting.
const talk = createLocalNpcAdapter(memory);
const greeting = talk({ npc_id: "receptionist", message: "hello", history: [] });
memory = recordNpcVisit(memory, "receptionist");
if (remember) {
  const result = saveNpcVisitMemory(storage, memory);
  // If !result.ok, keep ephemeral memory and show that it could not be saved.
}
```

Increment once when a conversation explicitly opens, never per frame, proximity check, reply, or rerender. Keep the returned `talk` function for that open conversation. Create a fresh adapter from current memory for the next visit. The adapter copies/validates its snapshot and does not mutate it. Greetings alone use the name and prior-colleague flag; all technique/directions remain identical for every user.

The single dedicated storage key is `arena.precinct.npc-visits.v1`. `getNpcMemoryStorage()` is an explicit, exception-safe browser boundary and returns null during SSR or when access is blocked. `loadNpcVisitMemory(storage)` returns `{memory,status}` with `loaded`, `empty`, `invalid`, or `unavailable`; corrupt data is ignored, never silently rewritten/deleted. Input serialization is bounded before JSON parsing. `saveNpcVisitMemory(storage,memory)` returns `{ok:true}` or `{ok:false,reason:"invalid"|"unavailable"}`; quota/privacy failures do not throw. Writes store only a canonical validated copy. No automatic hydration, background saves, listeners, timers, or cross-tab sync exist. Explicit writes are last-writer-wins between tabs.

For “Forget,” call `clearNpcVisitMemory(storage)`, replace UI memory with `emptyNpcVisitMemory()`, and discard any existing adapter snapshot. Check the clear result: if storage removal fails, do not claim the stored name was deleted. Only this feature's key is removed; no `localStorage.clear()` is used. Turning off persistence must also discard the in-memory name if the user chooses to forget.

## Verification

The two focused suites cover exact request/response schemas, all authored replies, hostile/unsupported messages, ignored history, immutable name/colleague snapshots, bounded counters, corrupt/oversized storage, denied storage getters, quota failures, failed deletes, SSR, and preservation of unrelated keys. The suites run under the unchanged repository TypeScript, ESLint and Vitest gates. They passed as part of the integrated 153-test development check; complete release-gate evidence is recorded with the slice checkpoint in `NOTES.md`.

The route integrates this seam through `usePrecinctNpcController` and `ReceptionBriefingPanel`. Optional speech uses only a device-local voice after an explicit click; no browser or operating-system voice is assumed available. Browser interaction and visual acceptance are documented separately with the slice screenshots.
