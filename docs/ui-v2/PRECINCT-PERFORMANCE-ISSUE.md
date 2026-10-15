# Measure production precinct performance and fix bounded low-FPS navigation

## Why

The target is smooth 60 FPS interaction on a MacBook Air M5. Existing cloud recordings use software WebGL and are visibly choppy; they cannot establish M5 performance. Lossless Meshopt GLB size reductions improve transfer size but do not prove draw-call, fill-rate, skinning or texture-memory budgets.

The precinct currently lacks a production render benchmark. Its adaptive quality sampler can count loading, hidden-tab and demand-render gaps, and step down after a single slow window. Live navigation also caps each frame at 50 ms: below 20 FPS it drops elapsed simulation time and slows walking, turning and crowd motion. The existing swept wall/person collision allows a bounded substep solution without changing replay interpretation.

## Work

- [ ] Add local opt-in diagnostics using the existing R3F frame ownership and post-render counters: interval p50/p95/p99/max, rendered FPS, actual draw calls/triangles, long tasks, DPR/drawing pixels, GPU renderer string, tier distribution and bounded sample retention.
- [ ] Clearly distinguish CPU/render-submission timing, browser Event Timing estimates and unavailable physical input-to-photon/GPU execution time. Report unavailable data as unavailable.
- [ ] Add a production-only, loopback-only benchmark with warmed assets, real WASD/arrow holds and assertions for visible minimap displacement/camera rotation. Reject missing renders, hidden/demand-contaminated measurements, development builds and unlabelled software-renderer runs. Save failure evidence too.
- [ ] Bound Retina DPR and absolute drawing pixels for low/Balanced/high, with warm-up and consecutive-window adaptive quality. Publish working draw/triangle/texture budgets and measured deviations.
- [ ] Separately integrate at most five <=50 ms live-navigation substeps, consuming at most250 ms per render and dropping excess without backlog. Poll input/consume travel and interaction edges once; integrate player/path/crowd together; publish camera/pose/capture once per existing render. Preserve recorded-camera/replay early exits, original capture clocks and registered clip interpreters.
- [ ] Review actual shadow/light setup, material merging/instancing, large-mesh culling, skinned bounds, texture dimensions/compression and avoidable per-frame allocations/React work. Apply measured optimizations without deleting authoritative actor/capture behavior or changing assessment boundaries.

## Acceptance

- Exact integrated source passes typecheck, strict lint, focused diagnostics/navigation regressions and existing applicable aggregate gates.
- Office and Courtyard produce reproducible production JSON from actual keyboard movement, with renderer/browser/viewport/DPR/duration and source/build identity recorded. No synthetic frame rates or fast-travel stand-ins.
- Diagnostics do not create another Canvas, renderer, animation clock, input owner, model/API call or external telemetry. No hidden facts, truth labels, typed dialog content or private payloads enter reports.
- 5/10/20/30/60 Hz live walking, turning and route progress remain wall-clock correct within defined tolerances; stalls consume at most250 ms. Collision, crowd avoidance, pause/hidden/focus/seated/reduced-motion gates, input-edge deduplication and once-per-frame camera/capture publication remain covered. Replay samples and original clocks remain unchanged.
- Working frame-pacing target: >=58 rendered FPS, p50 <=17.5 ms, p95 <=20 ms, p99 <=33.34 ms and <=1% intervals over 33.34 ms during foreground continuous movement. Report a missed budget honestly.
- Later authorized, verified MacBook Air M5 testing must run a foreground native browser for at least five minutes, with power/thermal/display conditions recorded, crowded/interview sightlines exercised and diagnostics-disabled overhead comparison. Until then, M5 60 FPS remains unverified.

## Tests and evidence

- Pure bounded metrics: nearest-rank percentiles, empty/invalid samples, retention/drop counts, hidden/demand contamination, start/stop resets and unavailable GPU/physical latency.
- Quality: Retina/pixel caps, resize/DPR changes, warm-up, slow-window hysteresis, hidden/demand resets and no step-up oscillation.
- Probe: samples only after a real render callback, actual counters, privacy of key/text input and lifecycle cleanup.
- CLI: production/loopback guards, parameter bounds, software/hardware labelling, real movement/turn assertions and incomplete/slow-run rejection.
- Live substeps: 5–60 Hz parity,250 ms stall cap/no backlog, wall/person collision, path completion/null-route hold, crowd synchronization, once-only input/capture callbacks, paused/seated/hidden/focus/reduced-motion and replay regression suites.
- Production build plus Office/Courtyard software diagnostics; later five-minute target-hardware results and separately captured genuine movement video.

Current checkpoint: source authoring only. No new type/lint/unit/build/browser results or M5 hardware measurements are claimed by this issue.
