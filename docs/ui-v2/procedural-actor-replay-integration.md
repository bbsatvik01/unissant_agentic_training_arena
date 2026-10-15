# Original procedural actor capture/replay integration

Status: source authored and frozen for the sequential QA slot. No executed QA pass or browser verification is claimed yet. This package changes only staged `web/src` and `docs/ui-v2` files. No actual repository, asset, generated contract, backend, dependency, build configuration, git, external service, or paid-model changes were made.

## Apply order and exact manifest

Apply verified `precinct-cast-next`, `precinct-monitors-next`, `precinct-scene-integration`, and the current `precinct-replay-next` source first, then this package's files at matching paths. `procedural-actor-replay-SHA256.txt` is the exact source merge manifest. It includes every staged source/test file and SHA-256; no unstated runtime files are required. Parent retains route integration, full unchanged gate, and real-browser visual acceptance.

Replacements:

- `components/precinct/PrecinctCanvas.tsx`
- `components/precinct/PrecinctControls.test.tsx`
- `components/precinct/PrecinctInterviewCast.tsx`
- `components/precinct/PrecinctStaff.tsx`
- `components/precinct/WalkingAvatar.tsx`
- `components/precinct/seatedAvatarRig.ts`

All remaining source files in the exact manifest are additions. The existing standing/seated Rocketbox assets and licence still apply; all procedural motion is original and no downloaded clip is introduced.

## Route ownership contract

`PrecinctCanvasProps` adds:

```ts
actorCapture?: {
  readonly scope: string;
  readonly onActorSample: (sample: PoseData) => void;
};
replayActors?: ReadonlyMap<string, PoseData>;
replayCamera?: {
  readonly ownership: "recorded" | "free";
  readonly sample: CameraData | null;
};
```

- Omit `actorCapture` until capture is explicitly enabled. Use a stable, scope-bound callback and change scope for a new capture/case. The route stamps canonical `t_ms` using its existing recording clock; actors never stamp timestamps, send APIs, start timers, or subscribe to the session.
- The callback must become inert when that exact capture ends, is stopped, changes case, or yields to replay. Guard against late cleanup from the old scope. Paused capture acceptance follows the canonical recorder's pause policy. Do not redirect an old cleanup callback into the new capture.
- `replayActors === undefined` means live scene. An explicit map means display-only playback, including an empty map that displays no actors. It suppresses all live actor mounting, all actor capture, and camera capture. The sole replay reducer remains the existing canonical WorldReplayState reducer.
- Feed the held actor map and camera sample from the same canonical cursor as agent-work geometry, transcript, captured input display, and recorded notebook. Unknown, mismatched, malformed, out-of-bounds, non-unit-quaternion and unregistered clip samples are refused by `proceduralClip`/`isProceduralActorSample` and never become asset URLs. A missing sample does not invent a person, default pose, or camera.
- Existing `Controls` alone applies camera override. Recorded ownership applies the exact validated sample and holds it until another arrives. Free ownership explicitly lets current viewer inputs orbit the camera; it never applies recorded key events, moves the trainee, calls interaction handlers, consumes travel commands, or writes the live notebook. Returning to live mode restores the untouched live navigation state and discards commands/held keys from replay.
- Keep Canvas mounted across transitions. Controls priority -2 runs before walking/seated body priority -1. All priorities remain nonpositive, so no callback takes ownership of rendering.

No separate Canvas, iframe, reducer, timer, external transport, model or audio generator is added.

## Finite v1 actor and clip contract

The runtime registry lives in `lib/precinct/proceduralActors.ts`; `ProceduralClipId` is the finite template-literal union and `PROCEDURAL_CLIPS_V1` enumerates it (143 clips including absence).

Actors (18):

- `staff:receptionist`, `staff:sergeant`, `staff:analyst`, `staff:patrol`
- `subject:jordan-pell`, `subject:mara-quell`, `subject:avery-lindqvist`, `subject:dana-okafor`, `subject:rafael-strand`, `subject:priya-halloran`, `subject:glen-mattick`, `subject:sami-varga`, `subject:elise-dunmore`
- `coach:question`, `coach:flags`, `coach:follow_up`
- `investigator:walking`, `investigator:seated`

Clip families:

- `precinct.staff.v1.{receptionist|sergeant|analyst|patrol}.{moving|still}`
- `precinct.seated.v1.{registered seated key}.{idle|listening|speaking|thinking|typing}.{moving|still}`. Registered seated keys are the nine subject slugs above, `investigator`, and `coach-question|coach-flags|coach-follow_up`.
- `precinct.walking.v1.investigator.{idle|walk|run|still}`
- `precinct.actor.v1.absent`, valid only for a registered actor; it hides that actor until a later valid visible sample.

Every visible sample contains only the existing exact PoseData fields: actor_id, actual WORLD root position, normalized WORLD root quaternion, and animation `{clip,time}`. Time is seconds consumed by the selected versioned evaluator. There is no JSON-packed state, arbitrary clip suffix, path, private role, demeanor, outcome or inference in any ID.

The registry pins public persona avatar, posture, gesture, seed and gaze. All currently supported public names map exactly. An unknown future name has no v1 subject renderer; do not silently substitute Jordan Pell. Add a new explicit versioned mapping if authoring a future persona.

Frozen v1 behavior is in `proceduralStaffV1.ts`, `proceduralSeatedV1.ts`, `proceduralWalkingV1.ts`, `standingAvatarRigV1.ts`, `seatedAvatarRig.ts`, and `seatedBodyV1.ts`. Preserve these evaluators for old clips when authoring v2. Staff and seated evaluation retain the original existing pure behavior, including fixed public gaze, neutral fitting and deterministic blinking.

## Authored walking change requiring visual review

The old independent R3F breathing clock and continuous velocity-dependent amplitude have been removed. Original v1 now has four finite cycles. Walk uses nominal 2.1 m/s and stride 2.115 m; run uses 4.2 m/s and stride 2.43 m. Actual collision-resolved per-frame horizontal distance advances canonical locomotion time. Actual speed selects walk/run (run threshold 2.7 m/s); zero distance selects idle, and paused/reduced-motion selects still. Teleports do not become locomotion distance.

Only the single captured clip time drives both stride and breathing. Walk/run transitions convert that time to preserve stride phase; idle/still transitions reset it. Idle time advances by bounded frame delta (maximum 0.05 s), while still is exactly neutral at time zero. This intentionally changes authored walking motion. Do not describe it as a preserved historical old gait or as a glTF AnimationClip. Parent must review walk, run, stopping, wall sliding, first/third person and reduced motion in the browser.

## Lifecycle, visibility and audio

Samples are taken after actual bones are posed and after the root hierarchy is final. The walking root includes Controls' parent transform and the Rocketbox +π convention. Sampling is capped to the existing 10 Hz cadence; clip/lifecycle changes emit immediately. Cleanup emits the finite absent clip once using the LAST actual root/time, never a manifest anchor. Cleanup before a first pose emits nothing. Old scopes retain their own callback identity.

An explicit capture keeps the investigator rig mounted but invisible in live first person, so the actual body exists to sample. Without capture, it retains the ordinary first-person culling behavior. Playback uses held sample times even under low quality; recorded high-tier staff remain present. Local first-person body culling follows the recorded camera proximity to an investigator root; free viewing displays captured bodies. That visibility choice does not erase captured state.

The previous live scene could show a seated investigator while the same trainee walked observation. Canvas now supplies `investigatorPresent={interview.seated}`; the seated trainee exists only during actual seated mode. Walking and seated IDs are still distinct so older/other captures containing both retain both independent facts rather than overwrite one. Verify this transition visually.

Only real live `audioMouth`/audio-aligned supplied weights can move seated lips. Body replay closes the mouth because no aligned recorded audio/viseme channel is present. Deterministic blink is preserved. This package therefore claims body/root replay only, not facial-audio replay. Speech text and public lifecycle never synthesize lip movement.

## Required acceptance

Focused tests cover finite registry rejection, all staff/persona driven bone quaternions and WORLD roots, patrol waits/turns/cycle boundaries, walk/run/stop/collision paths, paused/reduced motion, held and backwards samples, empty/absent maps, low-quality retention, first-person capture mounting, independent scope cleanup and single camera ownership. Test execution and coverage results are recorded separately after the CPU slot.

Parent must additionally run the unchanged full app gate and real browser verification: visual canonical gait, camera capture/replay/seek/free transitions, first-person head culling, seated/exploration restoration, actor disappearance after case/room/tier changes, low-tier replay presence, no duplicate investigator while walking observation, real mouth source and closed replay mouth, unchanged monitors and their CSP decoding, no second Canvas/camera writer, and GPU/resource behavior after repeated case/replay switches.

## Local world-only time and accepted input hooks

The Canvas also accepts `onBeforeFrame?: (deltaSeconds: number) => void` and `onControlInput?: (sample: Extract<InputData, {action: "key" | "click"}>) => void`. `onBeforeFrame` is the first operation in the existing Controls frame callback at priority -2, before camera or actor sampling; no second RAF, listener, loop or timer is created. Delta is finite/nonnegative and is not artificially capped. It can run on a paused demand frame or while paused free-view frames render. The route therefore owns capture opt-in, canonical time advancement, pause/freeze policy and lifecycle guards. It must not infer an unpaused interval merely because a frame rendered.

The input callback originates only in already-existing accepted control handlers after the active/pause/native-target guards. Held key presses are deduplicated; keyup/focus/blur/lock/transition cleanup emits a release only for a key previously accepted. The release retains the callback identity from the accepted press, so an old scope cannot send release into a new scope. Native textarea/input/dialog keystrokes are never recorded. Accepted floor clicks use public target `precinct:floor`; accepted pointer-look clicks use `precinct:look`. Coordinates are not encoded into target IDs. No recorded input is executed. `onControlInput` is suppressed during replay. `onBeforeFrame` still runs during replay so the existing canonical monitor presentation can update from the replay clock; the route must not advance the local capture clock or write capture events in that branch.

These hooks support explicit local-world-only capture. Live backend world-event capture must remain disabled until a server/client time-origin alignment contract is proven; actor precision alone does not prove timestamp alignment with server frames.
