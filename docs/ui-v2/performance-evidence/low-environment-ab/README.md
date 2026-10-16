# Controlled Low-tier environment experiment

Issue [#19](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/19), 15 October 2026, 22:45–23:02 UTC.

## Result and decision

In this four-run **retain → omit → omit → retain** experiment, removing the environment map reproducibly improves the cloud software renderer: retained 0.873–0.924 FPS; omitted 3.462–3.560 FPS. The ratio of median run FPS is **3.91×**. The median of the two per-run frame-p95 values falls from **1,870.9 ms to 490.9 ms**. These are medians of run summaries, not pooled percentiles or a statistical confidence interval.

**Every run still fails both the unchanged five-second cold-entry gate and the frame-pacing gate.** Each overall runner exit is 1. The warmed measurement is complete, not a release pass. This identifies a repeatable cost associated with the environment/shader configuration on this renderer; it does not identify the whole bottleneck or establish a MacBook Air M5 speedup.

The genuine app's default lighting is unchanged. The opt-in experiment is isolated, and omission visibly darkens the materials. Broad visual acceptance, real navigation, interview/replay parity and native target-hardware evidence are still required before using it as a shipping quality policy. Current work first validates behavior-preserving invisible-draw and stationary-work reductions.

## What was controlled

- One frozen production bundle based on `8eedd7564570c41def9892e4c1ddd4099b090872` plus the separately hashed experiment/runner overlay. This is not the later `a7626569` audio code.
- Courtyard **interior** at the same actual third-person camera and quaternion, Low tier, reduced motion, Office default HUD/theme. This is neither a courtyard exterior walkthrough nor a Studio timing result.
- CSS 1440×900, device DPR 1, actual DPR 0.75, 1080×675 drawing buffer (**729,000 pixels**), no shadows or antialiasing change.
- Every observed frame: **83 draw calls / 143,282 triangles**. The camera, viewport, tier and scene-asset checks were identical; no drift was observed.
- Same loaded-asset fingerprint in all four runs. This hashes requested supported asset types, not the complete deployable dist; the independent production inventory records the full build.
- Fresh owned browser/profile, a common 60-second warmup and at least 60 seconds of actual measurement per run. No screenshot, video or trace during the timed interval. Final stills were taken after measurement.
- Chromium 154 / ANGLE SwiftShader, Xeon cloud host; no hardware GPU or native M5 test. Scripts used pinned Node 24.21.0, one owned preview/browser pair at a time, bounded execution and explicit cleanup.
- No API, external network or socket attempts; no runtime errors, hidden/demand frames, visibility interruptions, or owned cleanup failures. No unrelated GUI state was inspected or closed.

## Actual observations

| Sample | Frames | Duration s | FPS | Frame p50 ms | p95 ms | p99 ms | CPU callback/submission p95 ms | Long-task count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| retain-1 | 53 | 60.695 | 0.873 | 964.6 | 1809.2 | 3955.3 | 15.6 | 7 |
| omit-1 | 209 | 60.371 | 3.462 | 269.0 | 480.6 | 694.6 | 13.5 | 0 |
| omit-2 | 216 | 60.673 | 3.560 | 260.6 | 501.2 | 793.1 | 11.0 | 4 |
| retain-2 | 56 | 60.608 | 0.924 | 1052.0 | 1932.6 | 3047.6 | 18.5 | 1 |

The environment-active assertion is true in both retained samples and false in both omitted samples. The renderer reports 15 vs 9 cached programs, 94 vs 81 geometries, and 76 vs 74 textures after the respective runs. These are renderer counters, not draw calls, actual VRAM, shader-instruction totals or measured GPU execution time. The omission path disposes the environment resources. The common startup begins at Medium before selecting Low, so this experiment **does not measure avoiding initial PMREM creation**.

Owned native process sampling also observes one Chromium child using roughly 6–7 CPU cores over its sampled lifetime, in both conditions. Subprocess roles were not recorded, so this is not asserted to be a verified GPU-process attribution. Those samples include setup/warmup and cannot be divided by timed frame counts to claim per-frame cost. No competing-process cause is established.

The short CPU callback/submission window excludes browser compositing, GPU execution, scheduler delays, and some React/layout work. GPU time and actual input-to-photon latency remain unavailable. This fixed-camera protocol produces no movement latency sample. Long-task counts vary across repeats and do not support a general long-task reduction claim.

## Visual tradeoff

Both actual repeat stills were inspected. Layout, character position and HUD remain consistent. Omission produces darker/richer teal and gold, a darker jacket and reduced reflected brightness. The ground rule remains visible. Low-tier world-label aliasing remains; this is not polished final-quality acceptance. These back-facing interior stills do not prove face, glass, evidence-table, exterior or interview appearance.

- [Retained environment, after timing](retained.png)
- [Omitted environment, after timing](omitted.png)

## Provenance and reproduction

[Machine-readable summary](summary.json) links each exact raw measurement and native-launch hash. Every original failed cold-entry/timing status is retained in the raw reports. The native launch reports retain bounded owned process/host samples and cleanup results. The four raw report directories are named by sample below this directory.

[Provenance](provenance/) contains the original before/overlay hashes, exact two source patches (losslessly gzip-archived; expanded-source hashes in `ARCHIVED-PATCHES.json`), interpretation-byte preservation proof, full source/build/test-input inventories, validation result, and reviewed native runner/config. The runner's absolute local QA path is part of the original provenance, not a portable M5 launcher. A reproduction elsewhere must deliberately re-establish and hash the equivalent isolated source/build inputs rather than silently changing that frozen configuration. The original raw artifacts outside Git are also preserved.

The isolated focused gate passed strict app/tools typing, zero-warning lint, 140 tests in 18 suites and a production build. Earlier missing-fixture/CSV attempts remain recorded in the validation artifact manifest. This focused gate is not a fresh full-app `pnpm check`. No assertion, timing threshold, coverage floor or scanner was relaxed.

Next: validate safe CPU/draw reductions, explicitly select/verify Studio in the benchmark, then create an immutable candidate and use the [M5 validation kit](../../m5-validation/README.md). No demo-ready claim precedes a sustained native MacBook Air M5 walkthrough and the required visual/interaction acceptance.

## Local-log policy correction

Four local `runner.log` files were mistakenly included in `a88f5c2`. They are removed from the current snapshot; their originals remain outside Git and their identities are recorded in [the correction record](LOCAL-LOG-REMOVAL.json). They are not renamed or re-encoded into replacement log artifacts. The structured measurement/native-process reports retain the actual results. The unchanged push-clean gate also checks history, so this additive correction does not clear those four historical entries or the earlier oversized GLBs. Publication recovery still needs the owner’s pending decision.
