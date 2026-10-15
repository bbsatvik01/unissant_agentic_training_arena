# UI v2 implementation notes

## 2026-10-15 — slice 01, precinct shell and movement

Issue: https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/7

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
- Full `pnpm check`, rendered browser validation, and both requested screenshot sizes are in progress. No check has been weakened or waived.

### Review workflow

GitHub permits one open pull request for a given head/base pair. The explicit `ui-v2` integration branch therefore uses one evolving draft against `main` while that draft is open, with a separate issue and tested checkpoint for each slice. No merge is authorized. After the user merges a reviewed slice, the next slice can receive a new draft PR. This avoids silently changing the requested branch strategy.

### Rendering verification

The managed cloud browser exposes no WebGL context. Its entry, directory, keyboard E interaction, native-dialog focus, and accessibility settings were checked through the explicit original-render fallback. An isolated fresh Chromium launched from the same cloud desktop verifies actual WebGL separately with the software renderer. Initial software runs exposed slow frame delivery; the runtime now detects software rendering, selects Low, uses lower DPR and fewer local lights, stops unnecessary drawing during menus/pause, and avoids duplicate stationary pose updates. Hardware-GPU frame-rate measurements remain distinct from this software-rendered functional check.
