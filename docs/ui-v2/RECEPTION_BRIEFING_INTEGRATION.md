# Reception, briefing and office panel

Implementation files:

- `web/src/components/precinct/ReceptionBriefingPanel.tsx`
- `web/src/components/precinct/ReceptionBriefingPanel.test.tsx`
- `web/src/hooks/usePrecinctNpcController.ts`
- `web/src/hooks/usePrecinctNpcController.test.tsx`
- `web/src/styles/precinct-staff-panel.css`

Dependencies are the separate `npcIdentity`, `npcLocalAdapter`, `npcVisitMemory` modules and the existing authored `staffDialogue`. `LocalSpeech.tsx` provides explicit, device-local speech with a subtitle fallback. The panel imports its scoped CSS; retain the existing `precinct.css` import in the route.

## Route API

```tsx
// Call once at the route level, before conditional station dialogs.
const npcController = usePrecinctNpcController();

// Inside the existing <Modal> / native <dialog>, without another modal wrapper:
<ReceptionBriefingPanel
  station="reception" // "reception" | "briefing" | "office"
  assignment={publicCaseCard}
  controller={npcController}
  onTravel={travelToHotspot}
  onCheckIn={markCheckedIn}
  onBriefed={markBriefingAcknowledged}
  checkedIn={shift.checkedIn}
  briefed={shift.briefed}
/>
```

`assignment` is the existing public `CaseCard` type from `lib/world/cases`. `checkedIn` and `briefed` are optional presentation flags; supplying route-owned flags preserves completed button labels after panel close/reopen. Make the corresponding callbacks idempotent and track briefing acknowledgement against the currently selected assignment. The public briefing card resets its local acknowledgement when `assignment.case_id` changes. This slice uses the existing bundled public assignment; later case selection must also reset the route-owned briefing flag.

Map the reception hotspot/lobby station to `reception`, briefing to `briefing`, and open office to `office`. `onTravel(hotspotId)` receives manifest hotspot IDs, not station room IDs: `case_board`, `personal_dossier`, `briefing`, or the authored topic's existing destination (`interview`, `debrief_replay`, `archive`, `trophies`). Resolve the ID against the manifest and close the panel as part of the route's ordinary travel flow. Reading a direction never triggers travel automatically.

The controller accepts one optional test-only dependency, a `() => NpcMemoryStorage | null` factory. It takes no assignment/case/session/account input. Its view is `{memory, remember, notice}`, and actions are:

- `setRemember(enabled)`: sets permission for explicit Load/Save buttons only; no IO
- `updateName(name)`: validates and updates ephemeral preferred name; boolean success
- `loadMemory()`: requires opt-in; returns loaded memory or null, preserving current memory on missing/corrupt/unavailable storage
- `saveMemory()`: requires opt-in; saves only canonical name/colleague counters and reports success/failure
- `forgetMemory()`: always clears ephemeral memory and disables persistence; attempts to remove only the dedicated key, honestly reports failed deletion
- `startVisit(npcId)`: returns `{npcId,greeting,reply(message)}` and increments the colleague once, after generating the greeting from pre-visit memory

No controller effects, automatic hydration, autosave, timers, or per-frame mutations exist. Keeping the hook in the route makes ephemeral familiarity survive closing a panel; it resets when the route unmounts unless the user explicitly saves and later loads. The persistence checkbox alone never reads/writes browser storage. Turning it off stops Load/Save but does not delete a prior stored copy; the notice explains that Forget performs deletion. Explicit loading replaces current familiarity rather than merging ambiguous visit counts.

## UI and safety behavior

- The first “Talk to…” click opens one visit. React Strict Mode mounting/rerendering cannot count visits. “Repeat greeting” repeats the same snapshot, without incrementing again. Closing/reopening the panel allows a new explicit visit and truthful returning-colleague greeting.
- Name/load/forget actions discard the old dialogue snapshot and optional speech playback. Name entry is separate from chat and limited to 40 units. No account identity is inferred.
- Reception has explicit check-in and direction buttons. Briefing displays the public title, objective, subject and facility, exact imported `EX4_TEXT`, and “Nervousness, demeanor, accent and stress are never evidence.” A separate button explicitly acknowledges the briefing and ground rule.
- Public assignment rendering is separate from `NpcConversation`; no assignment fields are forwarded into the NPC adapter/controller. Dialogue remains authored technique/directions only.
- Every response is shown as a full subtitle in a persistent polite live region. Opening dialogue keeps the same focused button mounted; topic changes do not steal focus. Optional typed prompts are capped at 600 units and checked by the exact seam validator; unsupported prompts receive the fixed technique redirect.
- `LocalSpeech` is keyed by reply text so changing responses unmounts/cancels previous playback. Voice is off until its explicit button is pressed. Voice aliases from the adapter are not passed to a cloud service. Text remains available without speech support.
- This is dialog content only. No nested dialog, autofocus, keyboard-global listeners, Escape interception, or competing focus trap is added. Keep the route's native-dialog open/close/focus-restoration behavior. All actions use native buttons/forms; normal Tab/Shift+Tab and submit behavior remains available.
- CSS reuses `precinct-primary`, `precinct-secondary`, `station-tag`, `panel-lead`, `precinct-safety` and `station-actions`, with scoped warm-neutral/petrol styles and narrow-screen, large-text and high-contrast variants.

## Validation status

The integrated focused run passes 153 tests across ten files covering the route, movement/cadence, staff directory, NPC seam, controller, dialogue panel and local speech. Tests include Strict Mode, close/reopen familiarity, keyboard focus, subtitles, public-copy separation, explicit check-in/acknowledgement/travel, opt-in name save/load/forget, unavailable local speech, and office fallback. Additional corridor/archive directions were subsequently added; the next full gate and browser smoke must include those changes.

The release checkpoint is recorded in `NOTES.md` and the slice gate/screenshot reports. An automated real-WebGL reception smoke is provided in `web/tools/precinct-reception-smoke.ts`; actual execution and visual inspection are reported separately, never inferred from unit tests.
