# Performance A/B integration handoff

Tracking: [issue 19](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/19).

Status: isolated strict app/tools, changed-source lint, baseline 174/174 and candidate 194/194 focused assertions and both production builds passed. The native Office A/B pair produced valid steady-state software counters after separately retained cold-start failures; both frame-pacing budgets failed. Courtyard remains unmeasured. See `PRECINCT-PERFORMANCE-VALIDATION.md` for measured movement, retained failures and the pending browser evidence. Hardware acceptance remains unverified.

## Package layout

`PACKAGE-MANIFEST.json` is the authoritative file/patch list with SHA-256 hashes and target overlays. It records the baseline and expected assembled Canvas hashes. References to the staging package describe handoff artifacts, not paths to add to the application repository.

- Shared files (`applyTo: baseline,candidate`) contain the identical read-only probe, metrics, inventory, runner and deterministic distance harness.
- Candidate-only files contain the new quality policy and live-step helper/tests.
- `instrumentation-baseline/patches/instrumentation-only-canvas.patch` adds only a probe import and opt-in mount. It retains the original DPR prop, `AdaptiveQuality`, Controls, frame ownership and capture/replay semantics.
- `patches/precinct-performance-canvas.patch` contains the render-policy/probe seam, rebased onto the same final navmesh Canvas as the baseline overlay.
- `live-step-delta/patches/live-navigation-substeps.patch` changes only the live Controls timing block/import and the existing crowd test's old per-frame-call expectations. Copy its new helper and tests from the manifest separately.
- Whole Canvas files are review references. Do not replace another worker's Canvas with them.

## Assemble two copies of one final source

1. Wait for the final navmesh/station/recording integration and an explicit CPU lane. Create two disposable QA roots from the exact same source and scene assets. Keep both outside the genuine repository until reviewed.
2. Verify Canvas SHA-256 `af359c64f76a41094980531e873ea363be7bdc0f7b52d623665dbe26fa69df35` and crowd-test SHA-256 `fbe247b6e4cf1bf02b0ac9470be5cf9d8cb1a4bf64122bf95461d41a470e6464`. If different, inspect and rebase narrow hunks; do not use an older full file to force the expected hash.
3. Copy manifest-listed shared files into both roots. Copy candidate-only files into the candidate root. Copy documentation separately as appropriate.
4. Apply only the instrumentation-only patch to the baseline. Apply the render-policy patch then the live-navigation patch to the candidate. The latter two seams are disjoint; preserve all navmesh and capture changes.
5. Verify expected resulting Canvas hashes against the manifest. Baseline is `56fcf410905e83365381ae865fd64f3a86d687ae45dbc2448f2d96f8b66b1a35`; combined candidate is `ded1bcc3ef847d1d8e8cd3b5a27a9df13bb1207c26e59d5c658d54cf20008904`. These are source-assembly checks, not runtime validation.
6. Run strict app and tools types, focused ESLint and focused tests. Preserve command lines, logs and exit codes. Include Controls/crowd/path/navmesh, recorded camera, actor/capture and diagnostic suites. Run the identical distance test in both roots using the baseline flag only for the baseline. The protocol has the exact commands and expected values; report actual emitted JSON rows after execution.
7. Only after these gates pass, build production once per root and serve it locally. Run the exact same benchmark/probe versions against both artifacts, with at least 60 seconds per cloud run and no capture during measurement. Begin with Office and Courtyard at low/third-person/1440x900/device DPR 2/software; low avoids the unchanged baseline's forced software downgrade confounding tier comparisons.
8. Preserve raw JSON, loaded-resource hashes, run notes and post-measurement images from both. Compare actual renderer, observed tier/pixels, scene bytes, browser version, route and duration before interpreting differences. Follow the complete protocol in `PRECINCT-PERFORMANCE.md`.

Do not copy baseline-only Canvas changes into the shipping candidate. Do not publish a cloud software result as M5 performance. Do not infer real frame pacing from the deterministic frame-delta harness.
