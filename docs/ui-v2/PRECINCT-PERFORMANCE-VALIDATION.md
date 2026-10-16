# Precinct performance validation

Tracking: [issue 19](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/19).

## Verified so far

The isolated production candidate passes strict application and tools TypeScript, zero-warning lint for all 20 changed source paths, and 194 assertions across 29 focused runtime suites. The instrumentation-only baseline passes the same strict checks, 14-path zero-warning lint, and 174 assertions across 26 focused suites. Both production builds completed successfully. Existing large-chunk warnings remain visible; no test, rule, acceptance threshold or coverage floor was weakened.

The actual Controls harness demonstrates the low-frame-rate movement correction. Each observation supplies exactly one second of frame deltas to the real Controls component and dispatches real keyboard events in jsdom. These are deterministic movement measurements, not browser frame-rate results.

| Supplied frame rate | Baseline straight walk | Candidate straight walk | Baseline separate yaw | Candidate separate yaw |
| --- | ---: | ---: | ---: | ---: |
| 5 Hz | 0.600 m | 2.400 m | 0.425 rad | 1.700 rad |
| 10 Hz | 1.200 m | 2.400 m | 0.850 rad | 1.700 rad |
| 20 Hz | 2.400 m | 2.400 m | 1.700 rad | 1.700 rad |
| 30 Hz | 2.400 m | 2.400 m | 1.700 rad | 1.700 rad |
| 60 Hz | 2.400 m | 2.400 m | 1.700 rad | 1.700 rad |

Walking and turning were measured in separate phases. Combined-turn-and-walk path invariance was not measured. The candidate's five bounded steps preserve up to 250 ms of live elapsed time; excess time is dropped without backlog. Sixteen focused Controls regressions cover walking/yaw, path and actual crowd synchronization, long stalls, collision, command/interaction edge consumption, replay and pause/focus/hidden/seated/reduced-motion gates. The raw capture clock and registered recorded interpreters are unchanged.

## Production browser evidence

The first native cloud run launched Chromium 154.0.8037.57 with an actual ANGLE SwiftShader WebGL 2 renderer. It failed the runner's original five-second entry-readiness assertion before warmup or measured movement. It therefore supplies no steady-state frame-time or FPS evidence. The report's zero measured frames are an unstarted measurement, not a claim that the renderer displayed zero frames.

The original failure is retained. A diagnostic-only rerun preserved its 5.065-second entry-gate failure and recorded successful local GLB requests completing 9.36–9.92 seconds after process start, with initial avatar textures completing by 10.69 seconds. By the failure screenshot, the original Office architecture and enabled entry button were visible; the bounded follow-up confirmed readiness. No local request failed and no application error was recorded. This establishes a slow initial load on this software renderer. It does not attribute that delay to PMREM, shader work, decoding, route interception or another specific cause. Snapshot work itself adds diagnostic overhead.

A separately labelled `--slow-start-diagnostic` mode preserves the original failure JSON/HTML/PNG, the failed cold-start predicate and a nonzero overall exit. After a bounded 60-second readiness observation, it may collect the unchanged warmed steady-state benchmark. A completed steady sample is reported independently as `steady-state-completed-cold-start-failed`; it never converts the failed cold gate into a pass. The ordinary runner still fails immediately at its original five-second gate. Application bundles, measured routes, warmup and rendering thresholds are unchanged.

## Closed Office software pair

Both production runs completed valid, foreground, continuous steady-state samples with real arrow turns and walking. Both failed the timing budget and their original cold-start gates. Overall exit codes remain 1. No runtime/network error, context loss, hidden/demand frame, visibility interruption or dropped retained sample was recorded. Chromium 154.0.8037.57, Linux x64 Xeon 8573C and ANGLE SwiftShader are the measured environment, not the target laptop.

| Counter | Instrumentation-only baseline | Candidate |
| --- | ---: | ---: |
| Measured duration | 70.0733 s | 61.6425 s |
| Real rendered frames | 53 | 52 |
| Average rendered FPS | 0.75635 | 0.84357 |
| Frame interval p50 / p95 / p99 | 1248.8 / 2076.2 / 2761.8 ms | 1164.1 / 1436.9 / 3340.9 ms |
| CPU callbacks + render submission p50 / p95 | 9.7 / 21.4 ms | 8.5 / 25.5 ms |
| Draw calls p50 / max | 78 / 78 | 78 / 78 |
| Triangles p50 / max | 140,375 / 140,375 | 140,375 / 140,697 |
| DPR / drawing-buffer pixels | 0.75 / 729,000 | 0.75 / 729,000 |
| Input-to-render-submission p50 / p95 | 1171.8 / 2573.3 ms (8 samples) | 1041.3 / 1285.8 ms (26 samples) |
| Browser Event Timing p50 / p95 | 5040 / 7256 ms (8 samples) | 4672 / 5560 ms (25 samples) |
| Long-task count / maximum | 6 / 716 ms | 3 / 80 ms |
| Walking legs / arrow turns | 6 / 2 | 24 / 2 |

All measured frame intervals exceeded 50 ms. GPU execution time and physical input-to-photon latency were not measured. Browser Event Timing is rounded/thresholded and is not a physical display measurement. CPU callback/submission duration is also not GPU duration. With only 51–52 measured frame intervals, high percentiles are sparse observations rather than stable tail estimates.

Baseline legs were 0.84 m. Candidate legs were mostly 1.20 m, with observed return overshoot/drift retained in the raw trajectory. At these extreme frame intervals, the candidate's 250 ms cap deliberately drops excess elapsed time: the 2.4 m/s deterministic result at 5–60 Hz does not mean real-time walking is restored at less than 1 FPS. Candidate p99 worsened in this single pair. Neither the small average difference nor its p95 difference establishes a rendering-speed improvement.

Scene inventory after the run was 78 meshes, 27 uncullable meshes and 72 unique materials. Shadows were globally disabled. The 101.9 MiB material-texture figure is an RGBA8+mip estimate over 19 Texture objects, not measured VRAM. Three may share a texture Source/GPU allocation across clones. The observed 78 calls and 140k triangles fit the provisional low-tier budgets, but that alone plainly does not guarantee frame pacing on a software renderer.

Byte-preserved raw [baseline steady-state](performance-evidence/office-baseline-steady-state.json), [candidate steady-state](performance-evidence/office-candidate-steady-state.json), [baseline cold failure](performance-evidence/office-baseline-cold-start.json), [candidate cold failure](performance-evidence/office-candidate-cold-start.json) and [supplied-delta movement](performance-evidence/supplied-delta-movement.json) evidence accompanies this report. Post-measurement screenshots were inspected; they show the actual third-person investigator in the original Office. Capture was outside the measured interval.

Courtyard software profiling is explicitly unmeasured. Further pairs are deferred while the recorder receives the next exclusive lane. Neither SwiftShader nor supplied-delta movement tests establish MacBook Air M5 performance. Actual M5 hardware, native browser, foreground/power/thermal conditions and a sustained run of at least 300 seconds remain the target acceptance requirements.

## Reproducibility and interpretation

The source snapshot is identified by SHA-256 `2e70b3a6758c36a35a51ce2c9999226570389c78770f6355c1101af19db4d425`; the baseline production build fingerprint is `77f4dc3a3243b72562f33aee7fa5adfb9247f9c5b0263c5dbcc9ed8fa305f6a3` and candidate fingerprint is `6fe9efd2b4d2ae3f551e3c455a02db837ccf82d23d984be8ec4e2fe2b227e439`. Full source, overlay and build manifests, command logs, exit codes and raw movement rows are retained with the isolated QA artifacts. The snapshot includes final navigation and recording reconciliation; later independent lint typing and initial failed-WebGL fallback fixes are outside these frozen A/B bundles.

The two copies have identical measurement code. The baseline retains the pre-policy DPR, adaptive quality and pre-substep Controls. Both use the same scene, viewport, renderer, quality and keyboard route protocol. The speed correction changes exact viewpoints and the number of movement cycles, so paired measurements are end-to-end same-input diagnostics. Aggregate frame-time or draw-call differences cannot isolate a rendering-speed gain. This protocol contains no separate fixed-camera segment.

The 27 pinned interpretation dependencies in each scene remain byte-identical across the source and both copies, with zero changed dependencies. Office and Courtyard scene adapter digests and actual navigation provenance bundles are unchanged. The live timing seam does not change recorded actor/camera interpretation or silently reuse an old scene identity for a changed frozen interpreter.
