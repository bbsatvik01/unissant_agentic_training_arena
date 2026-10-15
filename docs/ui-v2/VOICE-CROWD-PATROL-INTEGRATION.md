# Voice, crowd and patrol v2 integration addendum

Status: SOURCE ONLY. No tests, types, lint, build, browser, audio, Blender or renderer were run for this addendum. This does not inherit a passing QA claim from the separate voice package. Parent owns final integration and the exclusive CPU slot.

## Bases and ownership

This separate package merges `/workspace/shared/precinct-crowd-next` and `/workspace/shared/precinct-patrol-v2-next` over the finalized voice `PrecinctCanvas.tsx` and `PrecinctStaff.tsx` from `/workspace/shared/precinct-local-voice-next`. It never edits those packages, the genuine repository, the shared slice-five integration, or any backend/generated contract. Exact base/result hashes, immutable upstream copies and per-file actions are pinned in `VOICE-CROWD-PATROL-MANIFEST.json`; all package artifacts are listed in `SHA256SUMS`.

Use `voice-crowd-patrol.patch` only after the finalized voice patch is integrated onto the slice-five baseline. Its Canvas and Staff hunks are based on the exact voice result, not the earlier slice-five versions. Registry and replay changes use the patrol package's existing slice-five bases. Newly added source/test files can be copied only when absent, or verified identical by hash. Apply modifications narrowly if another owner has already added changes. Full source files here are review references, not permission to overwrite newer owner changes.

The original crowd patch's first four hunks applied with exact context. Its final two Canvas hunks conflicted with the voice subscription/speechPaused lines and were manually merged by exact unique source replacement. No reject or backup files are included. The generated addendum patch contains the resulting reviewed source rather than those rejected hunks.

Reviewer-v2 is separately owned by `/workspace/shared/precinct-review-panel-next`. Preserve that worker's future additive registry/replay/Canvas hunks. In this package `proceduralActors.ts`, `PrecinctActorReplay.tsx`, their patrol changes and pure v2 evaluator remain byte-identical to the existing patrol addendum. No registry redesign is attempted here. A review chair/person must enter the effective collision manifest or explicit people list, not just the drawn scene, to obstruct navigation. This package adds no reviewer actor or chair.

## Preserved ownership and behavior

- The existing Controls priority -2 frame callback remains the sole live player/camera owner. Its route-owned `onBeforeFrame` canonical-clock seam remains first. It resolves player movement with `moveWithPeople`, then advances the shared crowd ref exactly once before camera/root sampling. No added frame callback, RAF, interval, timer, clock, renderer or per-frame React state.
- Existing `replayActive` effect guard/dependencies and the frame's early replay return remain intact. Recorded/free replay returns before people/crowd processing and cannot reconcile or move live actors. The crowd adapter also retains its explicit replay bypass.
- Dialog/inactive, actual pause, background and reduced-motion gates freeze live crowd movement/waiting. Resuming advances no more than the existing 0.05-second bounded frame delta. The normal body remains paused behind dialogs while explicit receptionist/sergeant audio can still drive its mouth.
- The existing true audio activity subscription and final Canvas invalidation remain unchanged. The `speechPaused={props.paused}` prop is preserved separately from `paused={props.paused || !props.active}`. Analyser ownership and exact finite static audio remain in the finalized voice package.
- V1 staff uses the exact unchanged V1 body evaluator and the same voice mouth application after the body. The finite live v2 patrol branch reads the shared collision-resolved root/distance snapshot, applies the existing pure patrol evaluator, explicitly closes its mouth (no patrol clip exists), then captures the actual applied root. Recorded patrol applies only the exact held root/versioned clip/time and explicitly closes its mouth before returning. No analyser can leak through either patrol early-return branch.
- The original 18 v1 identities, 143 v1 catalogue entries and all frozen v1 evaluators retain their meaning. The pre-authored patrol addendum adds only `precinct.staff.v2.patrol.{walk,idle,still}` for `staff:patrol`. No navigation state, speed or packed phase is encoded into PoseData.
- Physical evidence callbacks, observation anchor, seated camera/eye heights, current replay/free-camera behavior and voice-scoped UI/subtitles are preserved by basing Canvas on the finalized voice file and applying crowd-only hunks.

The crowd solver is a deterministic collision-validated waypoint graph plus swept discs, not a polygon navigation mesh. It supports local reciprocal avoidance/waiting but can wait indefinitely in impossible single-file conflicts. That limitation and the separate true-navmesh requirement remain open. Low rendering tier retains only reception and sergeant; the moving patrol exists only at High rendering quality. Do not demonstrate low-tier navigation and claim the patrol was tested.

## Authored checks and next acceptance gate

The package includes the unchanged original crowd and patrol focused tests, plus new `PrecinctControls.crowd.test.tsx` integration regressions:

1. One Controls callback calls the real crowd adapter once after the canonical clock and before the camera sample, with the existing capped delta.
2. Recorded and free replay do not invoke or reconcile live crowd, including a graphics-tier change.
3. Dialog inactivity, actual pause and reduced motion freeze state, and resume has no elapsed-time catch-up.
4. Player walking uses the real people sweep against a stationary colleague. Only the independent crowd update is stubbed in that test; the pure solver has its separate geometry/reciprocal-traffic suite.

All four tests are authored and UNRUN. They do not prove WebGL behavior or physical collision in a browser. Preserve and rerun unchanged original V1 evaluator, actor-root/sampler, Controls/replay and audio-mouth/activity tests alongside the new suite. Run strict types and zero-warning lint after the combined registry/reviewer merge, then the broader test/build/coverage gate when authorized.

Real-browser acceptance remains: patrol root/body capture and replay through actual walking, collision avoidance, waiting, stop/resume and backwards seek; player/patrol separation at walls and occupied doorways; no foot-through-wall or stale gait at stop; no crowd step during replay; and reception audio/mouth motion while the dialog freezes the body/crowd. See the frozen voice package's browser proposal for real Web Audio/actual morph observation. Do not claim natural speech quality, precise phoneme synchronization, biomechanical realism, foot locking, navmesh implementation or physical gamepad testing from this source merge.
