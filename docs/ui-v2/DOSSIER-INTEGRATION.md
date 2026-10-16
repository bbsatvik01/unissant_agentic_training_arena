# Slice 3: readable desk dossier and working notebook

Tracking issue: [#10](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/10).

The dossier and scoped working notebook are integrated into the precinct desk. The route now owns their lifecycle through one canonical session runtime; reducers, wire contracts, package policies, backend and donor reference remain unchanged. `/session` remains untouched. See `DESK-ROUTE-INTEGRATION.md` for route ownership and the current verification status.

## Files

- `web/src/components/precinct/DossierPanel.tsx` and its component tests
- `web/src/styles/dossier.css` (imported by the panel)
- `web/src/lib/precinct/dossier.ts` and tests: public sources and conservative timeline projection
- `web/src/lib/precinct/notebook.ts` and tests: bounded immutable notes and defensive import
- `web/src/lib/precinct/notebookController.ts` and tests: observable session state and opt-in local persistence
- `web/src/test/dossier-fixtures.ts`: small public-only synthetic test inputs

## Dossier boundary

`DossierPanel` accepts:

- `packet: RecordingCase`
- `released: readonly SnapshotRelease[]`
- `notebook: NotebookSnapshot`
- `notebookActions: NotebookActions`
- `onUiEvent(event: DossierUiEvent): void`
- optional `onPresentEvidence(source: DossierSourceRef): void`

Do not pass a complete recording, hidden case fields, evaluator state, un-emitted future releases, or requestable-but-unreleased records. All table/body values render as text, without markdown or HTML interpretation. A source identity is `{kind: "document" | "record", id}`, so identical document/record IDs cannot alias.

The six tabs are Overview, Documents, Subject, Evidence, Timeline, and Notebook. The document reader includes original public documents plus already-released records, preserving the entire body and table. The profile uses only public subject name, position, setting, and case ID. The ground rule imports the existing exact `EX4_TEXT`.

The timeline deliberately retains source order. It projects labeled table columns `Time`, `Date`, `Date/Time`, `Date time`, `Timestamp`, `Created`, `Raised`, `Cleared`, `Start time`, and `End time`, plus a separately labeled released-record date metadata entry. Time strings and every row cell remain verbatim, with source ID and one-based row citations. It never mines dates from narrative prose or titles, invents dates/time zones, interprets door behavior, infers violations, or merges unrelated undated events into a supposed chronology. No photo, biometric, nervousness, demeanor, accent, or stress inference is added.

## Parent notebook wiring

Create one controller per stable user/session-or-trial scope and case, outside render churn:

```tsx
const controller = createNotebookController({
  caseId: packet.case_id,
  scope: `${userId}:${sessionId}`, // use real runtime identity, never a global constant
  sources: dossierSources(packet, released).map((source) => source.ref),
  storage: () => window.localStorage,
  now: () => Date.now(), // or a monotonic notebook clock retained across restores
  createId: () => crypto.randomUUID(),
});
```

Use `useSyncExternalStore(controller.subscribe, controller.getSnapshot)` in the parent. Each `getSnapshot` result remains stable until a state change. As public releases change, call `controller.setSources(dossierSources(packet, released).map(source => source.ref))` from the runtime's source update lifecycle or an effect. Do not create a new controller on every release. IDs and note times are injected so mutation commands can be replayed exactly; production IDs must remain unique across reloads. Keep the notebook clock at or after saved note creation times when restoring a session. The parent world-event timestamp remains separate from each note’s timestamp.

Render the panel with `notebook={snapshot}` and `notebookActions={controller.actions}`. Keep the controller alive when closing the desk so session notes survive modal dismissal. Key the panel by the notebook/runtime scope when switching sessions or cases to reset its unsaved composer and selected page. A mismatch between packet case ID and notebook case ID is refused by the UI.

For replay, the parent must project notebook state from recorded input events at the replay cursor, rather than loading the live session's device notes. The controller is for the live/practice working notebook. Do not use a live controller with a full future-source allowlist while replaying an earlier point. Read-only replay presentation/actions can be supplied through the same interface in the replay slice.

The parent owns `dialog`, `showModal`, focus restoration, Escape handling, world pause/movement suppression, and panel open/close telemetry. The component adds no nested dialog or trap. Existing `.large-text`, `.high-contrast`, reduced-motion, and forced-colors modes are respected. Reading size offers 100–150% scaling, with horizontal table scrolling. Scoped `.precinct-dialog:has(.dossier-panel)` widens only this modal; `.precinct-dialog--dossier` is an optional explicit fallback class.

## Notebook behavior

- Note kinds: observation, question, timeline note, possible contradiction. A contradiction stays a trainee hypothesis, never a truth label.
- Limits: 60 entries, 2,000 characters each, 8 distinct currently available public source citations, 180-character IDs, 180,000-character persisted payload.
- Empty note text, unknown or duplicate citations, bad times, duplicate IDs, oversized imports, malformed JSON, wrong schema, and wrong case imports are rejected as a whole. An uncited working question is allowed.
- Initial state is memory-only. Construction and all ordinary note edits do not acquire or read browser storage.
- `Save on this device` explicitly opts in. If current notes are empty, it can restore a valid saved copy. If both current and saved notes differ and are nonempty, it refuses to overwrite either; the trainee chooses Restore or Forget.
- `Restore saved copy` has an inline confirmation, replaces current notes only after successful validation, and enables saving. `Turn saving off` leaves existing saved data alone.
- `Clear session notes` has an inline confirmation. When saving is enabled, it writes the cleared notebook; when disabled, an older saved copy remains.
- `Forget saved copy` has a separate inline confirmation, removes only this scope/case key, verifies its removal, disables saving, and retains current memory notes.
- Read/write/delete failures are surfaced. An in-memory edit remains successful even if its subsequent device save fails, with visible persistent error status. No failure claims that stale data was erased or current data was saved. Storage objects can throw on acquisition, as in blocked/private browser contexts.
- Device storage is not account sync and may be readable by other people using the browser profile; the UI says so.

## World/replay telemetry handoff

`onUiEvent` emits typed data for page openings, source openings, reading-scale changes, presenting already-public evidence, notebook composer changes, successful mutation commands, and persistence outcomes. The parent supplies timestamp and wraps these into its `ui`/`input` world event contract. There are no network calls in this package.

Successful mutation commands carry deterministic IDs, times, text, types, and source references. Persistence events include the resulting document on success so a restore can be replayed without consulting local storage. Composer updates can be frequent: use the parent's ordered batching and backpressure policy. Do not silently drop the final draft/mutation event. Panel open/close and initial/default-page events belong to the parent lifecycle.

`onPresentEvidence` is only shown when supplied; it does not pretend that a world evidence table exists yet. The parent must record its evidence-table operation separately if necessary. Source opening moves focus to the Documents tab so a citation click does not leave focus in a newly hidden panel.

## Verification status

Verified on 15 October 2026 in an isolated source overlay, using the actual repository's pinned `web/node_modules/node/bin/node` (v24.21.0):

- Full copied app-source typecheck: `tsc -p tsconfig.app.json --noEmit`, exit 0.
- ESLint on all nine authored TypeScript/TSX files, `--max-warnings 0`, exit 0.
- Four focused test files: **37 passed**, exit 0.
- Scoped coverage for `dossier.ts`, `notebook.ts`, and `notebookController.ts`: **100% statements (214/214), branches (126/126), functions (48/48), and lines (154/154)**. Repository coverage thresholds were retained.
- All ten authored source/style files were byte-compared against the tested overlay and match.

The checks caught and fixed readable accessible-name spacing and a real persistence conflict bug caused by comparing JSON with differing property order. Notebook serialization now reconstructs a canonical public-note field order before saving or comparing copies.

The subsequent route/read-only/preparation-transfer integration passed 123 tests and its final strict lint/types; see [route ownership and integration checks](DESK-ROUTE-INTEGRATION.md).

Combined `pnpm check`, production build and visual/browser acceptance are recorded in [NOTES.md](NOTES.md). Browser QA covers 1440×900 and 1920×1080, all six tabs, original tables, 150% reading size plus larger text, high contrast, keyboard-only navigation, repeated close/reopen and explicit notebook persistence. Focused component tests alone do not establish actual renderer acceptance.
