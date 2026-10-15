# UI v2 implementation notes

## 2026-10-15 — slice 01, precinct shell and movement

Issue: https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/7

Draft PR: https://github.com/bbsatvik01/unissant_agentic_training_arena/pull/9

Branch `ui-v2` starts from the genuine `main` history at `1ef9a9f`. Work is performed on the dot cloud computer. No cloud models, paid services, credentials in source, or backend edits are used.

### Architecture

- `/` is the precinct, rendered with the repository's React Three Fiber/Three.js runtime.
- `/session` retains the existing working session route with its reducers, generated contracts, API transport, recording playback, and training panels intact.
- `PrecinctCanvas` owns rendering and a frame-local movement controller; it has no API or case access.
- Pure `src/lib/precinct` functions handle swept collision, route finding, controller dead zones, and camera-mode policy.
- The editable original Blender scene lives in `assets-src`; the material-batched runtime GLB and collision/navigation manifest live in `web/public/world`.
- Existing MIT Rocketbox investigator geometry uses an original, speed-driven walking pose. It never takes truth, deception, case facts, or score as input.

### Playable controls

WASD moves; arrows look; Shift sprints; E interacts; V switches first/third person, adding free orbit only while paused; M opens the map; Esc pauses. Right-click enables pointer-lock mouse look. Left-click the floor routes around obstacles. Number keys 1–0 fast travel. A connected controller uses sticks and A. Reduced motion, larger text, high contrast, and low/balanced/high rendering tiers are exposed in settings.

### Boundaries and next slice

This slice makes the architecture and movement playable. Station panels honestly identify their orientation-slice state and preserve a link to the existing session rather than pretending backend integration is complete. Reception/briefing, dossier/notebook, interview/observation, debrief/replay, and board/archive/lab connections remain the next slices.

The ground rule is retained verbatim. Nervousness, demeanor, accent, and stress are never evidence. Ambient behavior does not encode hidden case facts.

### Validation

- Asset validator: 121 colliders, 12 unobstructed hotspots, 30 connected navigation nodes, 8 clear door portals; original GLB approximately 5.48 MB / 116,034 triangles / 38 material groups.
- Pure movement: 28 tests, 100% lines/functions, 98.54% statements, 96.33% branches in the focused run.
- Whole-app typecheck and focused movement/renderer lint passed during development.
- New render-clock regression: 20 cadence tests, 100% coverage. R3F resets its absolute clock on demand/continuous transitions; delta-based sampling keeps navigation/minimap updates immediate after menus.
- Complete `pnpm check` passed on pinned Node 24.21.0: lint, typecheck, 77 files / 1,417 tests in both ordinary and coverage runs, and production build. Coverage: 98.18% statements, 94.61% branches, 99.13% functions, 99.60% lines. The [gate summary](slice-01-check.json) records this checkpoint.
- Test concurrency is capped at one worker to fit the shared cloud/laptop budget. Only the unchanged, dependency-free generated validator ESM is loaded natively during tests, avoiding a 2 MB Vite wrapper under precise coverage. The isolated CSP test still blocks `Function`/`eval` before its first import. Its former 5-second timeout now passes; no test, timeout, assertion, isolation rule, lint rule, or coverage threshold is removed or relaxed. Regeneration in watch mode requires a fresh test process.
- Clean isolated WebGL smoke: 21 checks per viewport, 42/42 passed, no console errors, page errors, failed requests or HTTP errors. All ten screenshots have the exact requested dimensions.
- [Five views at each resolution](screenshots/slice-01/README.md) and the [machine-readable report](screenshots/slice-01/smoke-report.json) are committed. The welcome, first-person, third-person, map and accessibility views were visually inspected.
- Remaining visual polish: low-tier in-world lettering is visibly aliased; readable text overlays/atlases are next. This is an early playable environment, not a claim of finished photorealism.

### Review workflow

GitHub permits one open pull request for a given head/base pair. The explicit `ui-v2` integration branch therefore uses one evolving draft against `main` while that draft is open, with a separate issue and tested checkpoint for each slice. No merge is authorized. After the user merges a reviewed slice, the next slice can receive a new draft PR. This avoids silently changing the requested branch strategy.

### Rendering verification

The managed cloud browser exposes no WebGL context. Its entry, directory, keyboard E interaction, native-dialog focus, and accessibility settings were checked through the explicit original-render fallback. An isolated fresh Chromium launched from the same cloud desktop verifies actual WebGL separately with the software renderer. Initial software runs exposed slow frame delivery; the runtime now detects software rendering, selects Low, uses lower DPR and fewer local lights, stops unnecessary drawing during menus/pause, and avoids duplicate stationary pose updates. Hardware-GPU frame-rate measurements remain distinct from this software-rendered functional check.

### Next checkpoint

[Issue 8](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/8) covers reception, fictional staff, explicit local visit memory and an evidence-first public briefing. NPC, monitor and world-replay code is prepared separately and is not presented as shipped in this slice. Docker/Postgres are unavailable here, so development uses bundled recordings and explicit local mocks; no real-model or hosted backend is started.

## 2026-10-15 — asset-gate and wayfinding checkpoint

PR title is now `feat(web): add UI v2 playable precinct and movement`; the new title-lint run passed. The remote `make py-check` failure at `5279845` was caused by 528 Ruff violations in the four added authoring scripts, not evidence of a secret leak or a frontend regression. The seven current authoring/audit scripts now pass pinned Ruff 0.16.8 check and format-check across the whole checkout (465 files), with no root configuration changes. Typed helpers and explicit validation guards preserve geometry and keep validation active under optimized Python. [Verification details](asset-script-gate-check.json) record normalized AST comparisons, actual GLB/manifest checks and limitations.

The editable Blender source and runtime export now contain larger width-fitted bold wayfinding. All non-performance manifest fields, 255 non-typography construction calls, 38 material groups and zero textures are retained. The scene is 5.67 MB / 116,267 triangles. See the [signage review](signage-readability-review.md). Integrated low-tier visual acceptance is pending the reception screenshot pass; hardware-GPU acceptance remains unmeasured.

The prior full web gate and screenshots remain the verified slice-01 checkpoint. At `e7da5df`, remote web, database, title and security checks pass. Python passes Ruff, format, mypy, no-rigging, silent-except, roles, cost parity, Supabase config, ratchet and dependency policy, then fails **push-clean**: both historical precinct GLBs exceed the repository's 5,242,880-byte committed-file cap. The brief's 25 MB LFS threshold is less strict than this existing repository policy; the asset validator mistakenly used that larger budget. Shrinking HEAD or adding LFS now cannot erase oversized historical blobs, because the unchanged gate scans every added/modified version in `main..HEAD`. No history rewrite, force push or gate relaxation is permitted. A compliant compressed snapshot is committed in local checkpoint `82dbfe0` while the owner decides whether to authorize a clean replacement branch/PR. Python tests and coverage were not reached; the database job subsequently passed. All remote checks at `e7da5df` are terminal, with only this historical-size failure.

The local checkout lacks the full Python environment and pinned gate binaries; no full local `make py-check` pass is claimed. The separate main-baseline missing-Docker test failure is outside this UI change and is not used to excuse our current asset-policy failure. Reception work for issue 8 is being validated separately.

## 2026-10-15 — slice 02, reception and briefing (verified local checkpoint)

Tracking: [issue 8](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/8).

- Two fictional speaking colleagues use the existing MIT Rocketbox assets and original neutral motion; high/balanced tiers add office/patrol staff. Staff animation receives presentation controls only.
- Explicit check-in and public-briefing acknowledgement advance the route's orientation state. Reception gives directions to the case board, desk, briefing, interview, replay, recognition wall and archive.
- A bounded, exact local NPC seam accepts authored topics and gives a safe redirect for unsupported prompts. The public assignment never enters this seam. This is fixed scripted dialogue, not an open-ended model.
- Optional local staff familiarity stores only an explicitly entered preferred name and bounded colleague visit counts. Load/save require opt-in and explicit actions; forgetting targets only this feature's key. No transcripts, case facts, identity inference or automatic storage writes.
- Every reply is a subtitle. Optional read-aloud chooses only installed device-local voices after a click; absent voices are reported honestly. Public briefing and conversation share single-speaker cancellation.
- The first actual-WebGL pass completed 36/36 functional checks and ten screenshots with zero page/console/network errors. Visual inspection caught a partially occluded sergeant and a scrolled-off panel heading; the standing/travel anchors and sticky dialog heading were corrected. These initial images are not the final visual acceptance.
- The complete unchanged `pnpm check` passes on pinned Node 24.21.0 and pnpm 11.0.8: lint, typecheck, 84 files / 1,500 tests in both ordinary and coverage runs, and production build. Coverage is 98.27% statements, 94.91% branches, 99.18% functions and 99.63% lines. [Gate summary](slice-02-check.json). No assertion, timeout, isolation rule, lint rule or coverage floor changed.
- The corrected actual-WebGL run passes 38/38 checks with zero page/console/network errors; [five views at both requested resolutions](screenshots/slice-02/README.md) were all visually inspected. No request invokes an API or leaves the local preview. Local speech correctly reports no installed voice and retains the full subtitle. Hardware FPS, physical gamepad, audible local voice playback and dynamic multi-NPC avoidance remain unverified; the patrol follows a collision-clear fixed corridor path.
- Lossless `EXT_meshopt_compression` reduces the runtime to 3,075,764 bytes. All 112 decoded buffer views and all 38 Three.js-loaded meshes are byte-identical to the signage export. The editable Blender source, materials, colliders and navigation are unchanged. The existing bundled decoder is wired locally; the existing meshoptimizer 1.1.1 version is now an exact web authoring devDependency, with no nested package manifest or policy exception. See [compression evidence](precinct-compression-review.md).
- Asset decoding/validation, strict Ruff/format, dependency policy, no-rigging and current snapshot file-size checks pass. The separate historical-size Git blocker remains; a smaller current snapshot cannot remove prior oversized blobs.

Upcoming tracked checkpoints: [dossier/notebook #10](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/10), [interview/observation #11](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/11), [debrief/world replay #12](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/12), and [training stations #13](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/13). These are not claimed as shipped by the reception checkpoint.


## 2026-10-15 — slice 03, desk and notebook (verified local checkpoint)

Tracking: [issue 10](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/10).

The route now mounts one canonical session runtime and an independently scoped working notebook. Public case selection is explicit. The desk has six accessible pages, original public text/tables, source-led timestamps, a metadata-only subject profile, and cited working notes. Case-file review advances orientation only through an explicit confirmation. Notes survive closing the desk, remain memory-only by default, and can be saved/restored/forgotten through scoped explicit controls. Case/source/user/run changes reset the workspace. A tested preparation-to-new-live-run offer preserves note metadata without automatic copying; its start-button wrapper will be wired with the interview station in the next slice.

The complete unchanged `pnpm check` passed on pinned Node 24.21.0: lint, typecheck, 99 files / 1,626 tests in both ordinary and coverage runs, and production build. Coverage is 98.48% statements, 95.28% branches, 99.39% functions and 99.69% lines. See the [gate summary](slice-03-check.json). Actual WebGL acceptance passes 38/38 checks with ten clean images at both requested resolutions, all visually inspected. Keyboard tabs, source tables/citations, scoped opt-in save/forget, reopen retention, large-text/high-contrast 150% reading, explicit progress and the ground rule are verified. A four-pixel inherited-header overflow and a missing font glyph were fixed before the corrected pass. No API or external requests occurred. See [screenshots and browser evidence](screenshots/slice-03/README.md).

The first full-gate coverage attempt encountered four unchanged five-second test timeouts and a worker-start failure while independent simple cloud filesystem commands also stalled. After recovery, all 64 tests in the four affected suites passed in a focused diagnostic, followed by the entire fresh green gate above. The diagnostic's expected whole-library coverage-floor failure was not treated as a full-gate pass. No application source, assertion, timeout, isolation rule, lint rule or coverage threshold changed between the failed and successful complete runs.

No-rigging, dependency policy, current-working-snapshot push-clean checks (1,322 files) and `git diff --check` also pass. The runtime GLB and editable Blender hashes remain identical to the verified compressed slice-two assets. These current-file checks do not pass or bypass the separate historical-blob gate.

This checkpoint remains local while the historical oversized-blob publication decision is pending. The last remote head is `e7da5df`; the preceding local reception checkpoint is `82dbfe0`. Exact `main` remained `1ef9a9f03ad895b70e32bb05392726fd0c889bdb` when checked at 12:01 UTC. No replacement branch, rewrite, force push or merge was performed. See [session runtime](SESSION-RUNTIME.md).
