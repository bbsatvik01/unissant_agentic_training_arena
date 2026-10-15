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

The prior full web gate and screenshots remain the verified slice-01 checkpoint. PR-wide CI is **not yet green**: the replacement asset commit must receive a fresh remote Python result, and the database job was still running at the last check. The local checkout lacks the full Python environment and pinned gate binaries; no full local `make py-check` pass is claimed. Uncommitted reception work is being validated separately for issue 8.
