# Observation review-panel v2: source-only addendum

Status: authored source and test cases only. No TypeScript, lint, tests, coverage, build,
Blender generation, browser, visual or performance check has run on this addendum.
The shared CPU/browser acceptance slot is held by the parent. This is not evidence of
rendered presence, correct chair contact, typing realism, convincing handover, or release readiness.
The genuine repository and the slice-five base are untouched.

## Public lifecycle and honest scope

The actual `WorkFrame` contract exposes a public `refereeState`. Its `refereeFor` adapter
uses the explicit `DebriefScoring` response `{status:"scoring"}`; it does not infer work from
a delay, a finding label, or a flag. Publication requires completed server state and the
same session's `debriefReady` matching the public debrief. The new route projection adds
an explicit current-run `view.status === "ended"`, available public debrief and cleared
`assessmentActive` gate. No debrief payload reaches the actor.

The new fictional review colleague listens while no honest work status exists, performs
small neutral work gestures only on that explicit public working state, and can hand a
blank slip during the existing 1.4-second `debrief.ready` arrival interval after publication.
The scored and unscored publication branches have identical posture and timing.
No late/missing timestamp is fabricated. If the debrief document arrives after that interval,
the handover is omitted. No event currently describes a real human review-panel action or
paper transfer. This is explicitly a public-publication illustration, not such an event.
Existing coach handing/pointing-to-idle rules remain unchanged; flag-driven pointing is absent.

Pending/current assessment intent wins over a stale practice work frame. Review presence
is absent until the current assessment ends and its actual debrief is published. The scene
also withholds imported reviewer samples during that interval; all three coaches remain
withheld throughout assessment, including post-publication. No active-assessment score or
review-progress body cue is introduced. The current `replayActive` control guard is untouched.

## Geometry and navigation

Read directly from `assets-src/build_precinct.py` in the genuine repo:

- Existing observation worktop: authoring (8.1,16.65,0.78), size (6.8,0.6,0.065).
  Runtime X span 4.7..11.5; center Z -16.65. It remains the only worktop.
- Existing chair centers X 6.2, 8.1 and 10, runtime Z -17.5. These belong to the three coaches.
- Authored cushion center 0.47, thickness 0.1, top 0.52. Frozen seated pelvis fitting is 0.62.
- One original compact backed four-leg chair is added at runtime [4.95,0,-17.5], facing +Z.
  It is not a floating seat, duplicate of any of the three chairs, or a new observation desk.
- A conservative combined chair/person collider is appended to the effective manifest:
  min [4.55,0,-17.9], max [5.35,1.5,-16.99]. Controls receives this effective manifest,
  so walking, click-to-walk and patrol/crowd routing can see it. Existing manifest data,
  station anchors, camera height and navigation nodes are unchanged.
- The courtyard author confirmed the annex stays at runtime Z >= 0. Apply this runtime
  overlay after Office/Courtyard selection in both variants; do not bake or translate it.

The neutral blank paper follows the actual rendered right-hand bone. It has no text,
label, score or private content. Screen, floor, worktop, door and hand/clothing clearance
remain unverified until rendered QA. Its simple geometry is intentional source-stage scope.

## Versioned replay and ownership

`reviewer:observation-v2` has exactly six allowed clips:
`precinct.reviewer.v2.{listening,working,handover}.{moving,still}`. The shared world-event
validator runs before exact finite ID lookup. Unknown IDs, versions, paths, mismatched actors
and invalid transforms fail closed. Reviewer absence uses the existing finite absence marker.

The v1 catalogues retain their original contents; all v1 actor definitions, pose evaluators,
rig fitting, time evaluators and historical coach mapping are unchanged. The only shared
registry edits are the new import, union variants, exact new-actor recognition and dispatch.

Live and replay call the same `applyReviewerBodyV2` on the same versioned fitting. Live uses
only the existing canonical scene clock and existing `useActorSampler`/actual WORLD root
at the established sampling cadence; clip transitions sample immediately. Handover time is
relative to its public arrival, so a recorded sample is self-contained. Replay applies the
sample's root, pose, exact time and still variant directly, with no new reducer, timer,
requestAnimationFrame, player or camera. A frozen dummy clock is not advanced or read for
pose evaluation when a recorded sample exists. No mouth/audio weights are accepted; every
review frame explicitly closes the mouth, including replay and reduced motion.

## Narrow integration over the other addenda

The supplied patch is against `/workspace/shared/precinct-slice-five-integration`, not the
genuine slice-four checkout. Its manifest pins base/final hashes for each changed source.
Apply only after parent review, over the assembled candidate; never replace the later route,
Canvas, registry or replay renderer wholesale with these sparse overlay copies.

Preserve the already-authored patrol-v2 import, `PatrolClipIdV2` union, `patrol-v2` variant
and dispatch in `proceduralActors.ts`. Add this review variant alongside them. In
`PrecinctActorReplay.tsx`, retain patrol-v2 rendering and add reviewer-v2 before the existing
family branches. The finite v1 parity test's new reviewer guard is additive; preserve any
patrol-v2 handling there. No v1 evaluator is edited.

Canvas additions are restricted to imports, memoized effective collider overlay, explicit
assessment withholding, one chair, one live reviewer and replay withholding prop. Preserve
staff voice props, patrol and crowd person collision hooks, the courtyard asset/catalog
choice, and one existing Controls/camera owner. Compute the reviewer collider overlay after
any world-choice manifest selection, then pass the effective manifest to Controls.

Route additions are one import, one public projection, and the `reviewer`/`assessmentActive`
scene fields. Preserve publication walls, world sampling, capture and training-station work.
No contract/schema, backend, dependencies, asset binary, network, secret or deployment change.

## Authored tests and remaining acceptance

New suites cover:

1. Canonical waiting/scoring/publication and equal scored/unscored motion; forbidden flag,
   label, score, demeanor, count and transfer values cannot affect lifecycle.
2. Pending/stale/current assessment absence and published-only release; imported coach and
   reviewer samples do not mount when withheld.
3. Exact finite v2 registry and unchanged v1 enumerations; missing/invalid IDs fail closed.
4. Actual applied bone quaternion/world-position parity, WORLD root parity under transformed
   parents, backwards seeks, held samples, still variants and explicit closed mouth.
5. Existing actual actor sampler clip transitions and single absence emission on closure.
6. Original chair height and idempotent collider overlay.

Run these along with v1 procedural parity, registry, actor sampler, route/replay, controls,
work-model and assessment regression suites after all addenda are combined. Then strict
whole-app types, touched-file lint, full required test/coverage and production build remain
necessary. Do not count authored tests as passes.

Rendered acceptance must inspect chair/feet/knees/bench/hand contact and the paper handoff,
verify one reviewer at all tiers, walk/click/gamepad collision around its actual footprint,
check the observation entry/sightline and both Office/Courtyard variants, pause/resume/reduced
motion, real accepted text session through publication, assessment transition with a stale
practice frame, published/unscored/deferred debrief, v1 replay without invented reviewer,
v2 sampled replay/backward seek, and no mouth movement without an analyser (there is none).
