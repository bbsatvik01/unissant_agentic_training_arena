# Public desk, notebook and route ownership

Tracking: [issue 10](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/10).

The desk is integrated into the existing precinct route. One `usePrecinctSession` instance owns the current public packet. One scoped `usePrecinctNotebook` instance lives outside the station modal so closing the desk does not erase working notes. The single Canvas, native dialog and existing trial reducer remain authoritative.

## Route seams

- One `usePrecinctSession({ reducedMotion, paused, audioInRoom })` lives in the existing route. `audioInRoom` is derived from the actual current room. No second canvas, iframe, automatic network connection, autoplay or microphone capture is added.
- Public assignments are explicitly selected through `PrecinctCaseChoicePanel`. The temporary panel is content only and uses the session's `cases`, `selectedCase`, `packetState`, and `selectCase`. It never loads a recording or starts an interview. The full case-board station can replace this component; retain the route's `selectCase` wrapper so case-specific acknowledgements reset.
- Reception still checks in and offers case-free staff conversation before selection. `ReceptionBriefingPanel.assignment` now permits `null`; an unselected briefing offers the case board instead of inventing an assignment. Once selected, the exact existing briefing labels, ground rule, local speech, NPC boundary and acknowledgement flow remain. The existing route test adds the now-required explicit public selection before briefing.
- The desk consumes only `packet`, `packetState`, `selectedCase`, and current `released` records. Missing/unavailable or mismatched packets display an honest status and a case-board button. The existing route modal still owns focus, dismissal, movement suppression and comfort settings.
- The step-three objective completes only through “Mark case file reviewed”. Opening the desk, tabs, sources, or writing a note does not advance it. Completion becomes “Prepare your interview” at 3/6 completed; it does not manufacture interview, finding, scoring or debrief progress. Recorded-file browsing cannot complete this step.
- `/session` and its existing fallback links remain intact.

## Notebook lifetime and privacy

`usePrecinctNotebook` mounts at route level, outside the desk modal. It returns a stable external-store snapshot and actions plus a `key` for the dossier's transient page/composer state. Closing and reopening a desk retains added notes; case/source/session/user changes construct an empty memory-only controller. It does not keep an invisible per-case controller cache.

The scope is `[browser-preparation for idle preparation, otherwise authenticated user id or browser-preparation, source, sessionKey]`, combined with the actual selected/packet case ID. Idle preparation stays in the same browser workspace when the user explicitly connects the local backend, rather than disappearing merely because a profile becomes available. A pre-run offline preparation workspace is per public case on this browser profile; live work is per actual session. A previously saved preparation copy can therefore be found after reselecting that case, but only through an explicit Save/Restore action. This is device storage, never account sync; the existing notebook disclosure warns that other people using that browser profile may see saved notes. Live sessions have authenticated-user and actual-session scopes. Disconnecting clears the selected case and the preparation workspace; unrelated cases, runs and recordings never receive those notes.

No construction, route render, panel open, scope change, normal note edit, or new public release acquires/reads/writes localStorage. The existing explicit Save/Restore/Forget controls and validation/conflict/error semantics are preserved. Released-source changes update only the allowlist; they do not discard notes or create a new controller. The workspace adapter clamps note times to the latest restored note time so a clock moving backwards does not make valid edits fail.

The v1 recording source gets a read-only empty workspace that refuses all mutation and persistence actions. `DossierPanel.notebookReadOnly` suppresses its composer, note count, note text and storage controls even if a caller mistakenly passes a working snapshot. It explains that v1 contains no notebook history. It never substitutes live/device notes for missing recorded history. The later v2 replay projection should replace this explicit empty state only when actual recorded notebook input events are available.

## Explicit preparation-to-run transfer (required final-route wiring)

A case's preparation notes must not disappear merely because an explicitly started new interview receives a session ID. This package retains an offer only when the final route arms it as part of that intentional NEW run start. It does not infer a transfer from a coincidentally matching case in a historical session.

Wrap the final session panel's `startInterview(kind)` callback:

- First retain the session controller's existing `canStart`, mode and running/starting guards. Do not arm a handoff for a rejected/no-op start.
- For a NEW `practice`, `assessment` or `voice` start from `source === "idle"`, call `notebook.prepareForNewRun()` immediately before the existing `session.startInterview(kind)`.
- Before `resume`, call `notebook.discardPreparation()`; Resume is an existing historical run.
- Starting from a recording also discards the offer. An actual different run key clears a previously bound offer. If retrying the same pending new start after a start error, do not call `prepareForNewRun` again from the now-live empty notebook; the already-armed offer may remain until the first actual run is ready.
- Supply hook context `caseId: session.selectedCase?.case_id ?? null`, `source: session.source`, and `runKey: session.source === "live" && session.live.phase === "running" ? session.sessionKey : null`. The route supplies these hook options. The interview control wrapper remains a required next-slice integration.

An armed offer survives the same-case pending-start and packet-loading states. It binds only to the first actual same-case running session. The desk then shows “Carry preparation notes into this run” with its note count, plus an explicit discard button. Nothing is copied until that button is clicked. Acceptance atomically validates the whole document against the new run's current public sources, retains original note IDs, kinds, text, citations and times, and refuses to overwrite a nonempty notebook or alter an enabled device notebook. It never reads/writes device storage. A refusal leaves both current notes and the offer intact. Successful acceptance emits `notebook.carry` with the resulting document, which the v2 world-capture adapter should record as an explicit notebook replacement. The note clock stays at or beyond the carried timestamps.

Any different case, unselected case, recording source, different actual run, explicit discard, or return to idle after live cancels the offer. Notes are not silently carried into a historical recording, Resume, or later run. New pure/hook/controller/panel tests cover the intent, pending transition, acceptance, cancellation, overwrite refusal, original metadata, and no-storage boundaries.

## Route telemetry seam

`PrecinctRoute` accepts optional `onDossierUiEvent(event, { caseId, sessionKey })`. Every existing dossier event is forwarded to it. `notebook.change` now includes the exact accepted `document` alongside its command, so capture can preserve original creation times and atomically replace the notebook without consulting a stale React render. No transport, global event log, automatic storage or network is added. The world-capture integration supplies timestamps/batching and owns panel open/close/default-page events. Do not pass raw recordings, debriefs, requestable records or hidden fields to the dossier/NPC/cast.


## Verification

Before integration, the final source passed app TypeScript, strict ESLint, and 123 tests in 11 focused/regression suites. `notebookController.ts`, `notebookWorkspace.ts` and `preparationHandoff.ts` each reached 100% statements, branches, functions and lines under the unchanged scoped coverage check (143 statements, 59 branches, 39 functions, 101 lines). See [coverage summary](DESK-COVERAGE.json). No lint suppression, timeout extension or weakened assertion was used.

The required final interview-start wrapper and v2 capture composition are later-slice seams. The combined full web gate and real browser screenshots for this desk checkpoint are recorded separately in [NOTES.md](NOTES.md); focused checks are not a substitute for those acceptance checks.
