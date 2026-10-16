# Precinct render-cost audit

Source: `ui-v2`, `a7626569ce7764b3d81cd884ff3c2768c6c5c069`. Read-only review, 15 October 2026. Paths below are relative to the Arena checkout. No application files changed; no build, browser, tests, downloads, or paid services ran for this audit.

## Recommendation

First test three small, behavior-preserving changes: stop drawing the invisible click plane, reject distant hotspots before doing line-of-sight checks, and avoid rebuilding stationary crowd state. In parallel with later hardware profiling, isolate the Office HUD's backdrop blur. Conservative actor culling offers a larger rendering opportunity but needs pose-bound verification. None of these is a measured speedup yet.

Existing software-renderer results cannot establish MacBook Air M5 performance. The supplied recent diagnostic was below 1 FPS at roughly 77 calls / 138,642 triangles / 729,000 pixels; its roughly 20 ms CPU callback/submission p95 leaves substantial time unattributed. The checked-in older pair has different exact counters (78 calls / 140,375 triangles; `docs/ui-v2/PRECINCT-PERFORMANCE-VALIDATION.md`). Do not combine these runs or infer that JavaScript, PMREM, or GPU execution alone explains the stalls.

## Smallest safe changes, ranked

### 1. Make the click-only floor non-rendering

- Source: `web/src/components/precinct/PrecinctCanvas.tsx:442–450`; a 28×36 metre default plane has `transparent`, `opacity={0}`, and `depthWrite={false}`. Its material remains visible, so it enters the render list despite adding no visible color. Default floor dimensions: `web/src/lib/precinct/worldVariant.ts:15`.
- Candidate: retain the mesh and pointer handler but set its material `visible={false}`. Pinned Three source checks material visibility before submitting (`web/node_modules/three/src/renderers/WebGLRenderer.js:1912–1958`), while `Mesh.raycast` does not reject invisible materials (`…/objects/Mesh.js:238–280`; `…/core/Raycaster.js:240–258`). This is stronger than merely disabling color writes.
- Expected effect: remove one call / two triangles when currently submitted, plus avoid its transparent raster/blend work. Magnitude unmeasured; this cannot plausibly explain the entire stall by itself.
- Risk/validation: low, but verify actual R3F floor clicks, route generation, and board/screen event precedence in both worlds. Existing DOM-mocked Controls tests do not prove WebGL raycasting. Compare pixels and counters at one fixed camera.

### 2. Eliminate irrelevant hotspot visibility tests

- Source: `PrecinctCanvas.tsx:418–419` tests visibility for every hotspot before `nearestHotspot` rejects points beyond their interaction radius. `web/src/lib/precinct/movement.ts:120–131,155–160` shows that radius and nearest-distance checks can happen first without changing the selected result.
- Candidate: one loop in Controls: preserve manifest-order ties, reject beyond-radius/non-nearest candidates, then call line-of-sight. Skip the search when seated. Optionally cache by actual XYZ, hotspot/collider identity, and seating state; yaw is not an input to current selection.
- Expected effect: fewer collider scans and arrays. Static manifests contain 12 hotspots and 121 Office / 196 Courtyard colliders, before runtime overlays; each visibility test also checks endpoint walkability. Current code repeats this even while the player stands still.
- Risk/validation: low if radius/tie semantics remain exact. Test blocked nearest vs visible second-nearest, equal-distance ties, radius boundaries, fast travel, seating transitions, and geometry replacement. Prefer exact caching over a new polling delay that could make E use a stale hotspot.

### 3. Cache live crowd definitions and preserve stationary state

- Source: `PrecinctCanvas.tsx:360–395` constructs people and advances the crowd for each of up to five live substeps. `web/src/lib/precinct/staffCrowd.ts:8–11,25–37` rebuilds definitions, people, and world objects; `crowdNavigation.ts:193–246` creates maps, sorted arrays, proposals, and fresh positions even for stationary people. Low and Balanced include no patrol (`staff.ts:23–34`).
- Candidate: cache immutable definitions by tier in the live adapter; after required tier reconciliation, return the existing valid all-stationary state. Build `staffCrowdPeople` only when an actual movement/path step needs it, or reuse it while its state is unchanged. Do not change high-tier patrol integration or frozen procedural evaluators.
- Expected effect: reduce repeated CPU work and garbage at Low/Balanced; especially useful with multi-step stalled frames. No measured allocation or timing total yet.
- Risk/validation: low-to-moderate. Verify high→medium→high transitions, paused/reduced-motion reconciliation, people collision, patrol yielding, and existing substep/distance tests. Preserve immutable snapshots and the no-replay-simulation gate.

### 4. Test Office backdrop blur separately

- Source: `web/src/styles/precinct.css:1` applies 14px backdrop blur to `.precinct-objective` and `.precinct-minimap`, plus 12px to `.precinct-interact`. These overlay the moving Canvas (`web/src/routes/PrecinctRoute.tsx:483–500`). Office is the default theme (`:159`). Studio already sets these blurs to none (`web/src/styles/precinct-theme.css:104,111,117`).
- Candidate experiment: disable only those blur declarations in the same Office layout, with an opaque color if needed for readability. Comparing whole themes would change too many variables.
- Expected effect: potentially reduce browser compositor work that draw/triangle counters and the CPU submission timer do not describe. This is a hypothesis, not evidence that blur caused the software stalls.
- Risk/validation: low implementation risk, visible styling change. Check text contrast and visual approval; measure actual frame pacing and a separate browser trace. Keep the environment/light experiment independent.

### 5. Minor allocation cleanup, then larger actor work

- `PrecinctCanvas.tsx:397,405–410` creates a travel object and third-person vector each frame. Reuse scratch data only where no retained capture snapshot can alias it. `:460` evaluates `createStaffCrowd` on every React render despite `useRef` retaining only the first value. Small, straightforward reductions; do not expect a dramatic FPS change.
- Every staff mesh disables frustum culling (`PrecinctStaff.tsx:73–79`), as do seated/walking resources (`seatedAvatarRig.ts:50–55`). Off-camera actors can therefore still incur skinning, morph, and draw work unless an ancestor is hidden. Static GLB headers show 18 primitives / 16,292 triangles across the two Low staff, with 31 morph targets per primitive and ~80 joints per rig; these are asset totals, not runtime savings. See `static-inventory.json`.
- Next larger candidate: conservative per-actor bounds or live render-only visibility, while preserving authoritative simulation/capture. Never blindly enable bind-pose culling: the existing comment documents seated-head clipping risk. Test all walk/seated/reviewer poses and camera modes. Per-frame full skinned-bound recomputation itself has cost; use validated envelopes where possible. [Three.js SkinnedMesh guidance](https://threejs.org/docs/pages/SkinnedMesh.html).

## Actor and material work requiring extra care

- Staff apply the complete standing rig on every frame, even when paused/still (`PrecinctStaff.tsx:124–154`). `standingAvatarRigV1.ts:34–68` repeatedly obtains world quaternions and performs two whole-rig matrix updates per application. A live-wrapper unchanged-pose fast path could retain mouth updates and capture sampling. Frozen evaluator changes require explicit compatibility/version handling.
- Capture sampling calls `readActorRoot` before its 10 Hz publication check (`actorSamples.ts:7–10,30–35`). That helper updates descendants and allocates vector/quaternion/arrays every sampled frame, even though only the root is recorded. This is capture-on cost, not necessarily the no-capture lobby benchmark. Avoid simply skipping reads: cleanup emits the last actual root (`:38–41`). The helper, rig files, and assets are hash-pinned by `web/tools/replay-scene-manifest.test.ts:15–37`; do not silently regenerate identities to make tests pass.
- Reviewer hand world transforms run even when its paper is hidden (`PrecinctReviewPanel.tsx:62–69`); this can be gated on paper visibility. Interview/reviewer updates are already tier-throttled (`PrecinctInterviewCast.tsx:62–75`, `interviewStage.ts:107–109`), so do not duplicate that work.
- The observation monitor is already one atlas at 1/2/4 Hz, not four renderers. Each new decoded atlas creates/disposes a texture (`localSvgTexture.ts:26–39`) and sets material `needsUpdate` (`ObservationWorkScreens.tsx:41–44`). Only the initial no-map→map transition needs a shader-feature change; later same-format swaps are a candidate for avoiding material invalidation. Reuse texture storage only after testing latest-wins cancellation, tier dimensions, paused seeks, and assessment entry. This is an interview-phase issue, not a lobby explanation.

## Observation blind spots and overhead

1. **The short CPU window is not a frame breakdown.** The timer begins in `useFrame(-100)` and ends at the global after-effect (`PrecinctPerformanceProbe.tsx:21,88–98`). React work, queued input, layout/paint, browser composition, GPU work, and scheduling outside that interval are unattributed. The probe's own metric writes happen after its end timestamp. Frame intervals reveal the gap, but do not identify its cause. A separate trace and, where supported, asynchronous GPU timing are needed; never use a blocking GPU finish in the primary run.
2. **The runner itself polls.** Real-key movement polls the minimap DOM every 100 ms; turns poll status through browser evaluation (`web/tools/precinct-performance.ts:192–212`). This is a potential external scheduling cost. Compare identical polling in A/B runs, and bound it with a separately labelled no-poll fixed-camera segment. Do not duplicate the already-assigned fixed-camera experiment.
3. **Snapshots are not free.** Explicit snapshots traverse the scene and query the context (`PrecinctPerformanceProbe.tsx:29–31`). Each metric sorts filtered copies four times (`renderMeasurements.ts:27–30`, `renderQuality.ts:18–21`). Normal benchmark snapshots are outside steady-state; keep them there. A status read is cheaper and is not equivalent to a full snapshot.
4. **Memory accounting omits major categories.** Material-texture estimates exclude environment/render targets and also miss skeleton/morph textures managed by the renderer (`inspectPrecinctRenderer.ts:10–35`). They deduplicate by Texture object, not necessarily actual shared GPU allocation. Static actor headers expose 31 morph targets, invisible in triangle counts. Unique material count is not shader-program count. No VRAM claim is supported.
5. **Input and long-task coverage is selective.** Input proxy begins at JS key dispatch, excludes queueing before it, and ends before presentation; Event Timing is thresholded; long tasks miss sub-50ms work and do not attribute GPU/compositor stalls (`PrecinctPerformanceProbe.tsx:41–58,81–97`). No samples means unavailable, not instantaneous.
6. **The current benchmark covers lobby walking.** It does not exercise a live interview, atlas updates, capture-on cost, replay seeks, or sustained warm-M5 thermals. Also, adaptive quality needs at least 30 samples twice (`renderQuality.ts:48–53`), so a very slow unknown renderer may take far longer than four seconds to step down. Known SwiftShader is already forced Low. Do not change quality semantics without a separate test.

## Existing work to preserve

- DPR/pixel caps, disabled MSAA, globally disabled shadow maps, Low-tier light/staff reduction, demand-mode pause, 10 Hz change-filtered pose publication, bounded live-navigation substeps, and opt-in diagnostics already exist. Actor `castShadow` flags do not imply active shadow passes (`PrecinctCanvas.tsx:482–490`; checked-in performance protocol §106–115).
- RoomEnvironment/PMREM is created once per Canvas effect, not each frame (`PrecinctCanvas.tsx:125–140`). The retain/omit fixed-camera experiment already has a separate owner; wait for that result rather than duplicate it. Removing the environment affects PBR/mirror appearance and cannot be assumed safe from source alone.
- Architecture is already material-batched. Re-merging the whole world can worsen culling. Spatial batches/instancing and texture variants belong after the smaller experiments and need authored-asset regeneration, not hand-edited generated files.
- Follow the existing production protocol, separate timing from footage/trace capture, retain failures, pin one variable per comparison, and require native foreground M5 measurement before claiming smooth target-hardware performance.

Primary guidance consulted: [R3F allocation/lifecycle pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls), [Three.js draw/merge tradeoffs](https://threejs.org/manual/pages/optimize-lots-of-objects.html), [material visibility and update semantics](https://threejs.org/docs/pages/Material.html), and [world-matrix update controls](https://threejs.org/docs/pages/Object3D.html). These support the mechanisms; the expected gains above remain project-specific hypotheses pending measurement.
