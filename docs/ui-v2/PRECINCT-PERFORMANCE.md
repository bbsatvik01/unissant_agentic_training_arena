# Precinct production performance protocol

Tracking: [Arena issue #19](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/19).

## Status and scope

Target: responsive movement and stable 60 Hz presentation on a MacBook Air M5. This is an acceptance target, not a result. The dot cloud uses software WebGL; it cannot establish M5 GPU or thermal performance. A compressed GLB's bytes, mesh count and triangle count do not establish rendered-frame cost.

This change adds local, opt-in production diagnostics and a reproducible real-input benchmark. It does not introduce another renderer, animation clock, controls owner, backend request, framework, telemetry service or model call. The diagnostic object contains rendering statistics and public camera transforms only. It contains no case/actor truth, dialog text or private model payloads.

Initial source review and proposed budgets are complete. Type/lint/unit checks, production execution and target-hardware measurements must be recorded in the validation report; absence of a result means not measured.

## Latest measured checkpoint, 16 October 2026

The [controlled environment experiment](performance-evidence/low-environment-ab/README.md), [actual Studio fixed-camera sample](performance-evidence/studio-stationary/README.md) and [actual Studio keyboard sample](performance-evidence/studio-keyboard/README.md) preserve their complete production reports and failed cold/timing gates. The Studio samples averaged 0.792 and 0.910 FPS on SwiftShader. CPU callback/submission p95 was 18.6 and 17.9 ms, while whole-frame p95 was 2,471.9 and 2,371.8 ms; this separates observed counters but does not identify GPU completion time or prove a hardware bottleneck. No FPS, long-task or target-GPU improvement is established by the one-draw experimental reduction.

The invisible-floor proposal is deferred after failed real-pointer acceptance. The [reviewed successor](performance-evidence/retained-floor-integration/README.md) restores the original floor contract and has passed its focused gate, then integrated with the stationary hotspot/pose/crowd reductions. Its first full local gate failed one unchanged legacy readiness test after lint/types passed; coverage/build were not reached. Further validation remains pending. Previous measured 82/80 draw counts do not describe the retained-floor successor. Exact results, integration and full-gate status belong in the current [notes](NOTES.md), not inferred from historical reports.

## Run the same production artifact

From `web/`, with the repository's pinned Node/pnpm and installed dependencies:

```sh
pnpm run build
pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort
```

In a second terminal, for a deliberately labelled cloud/software diagnostic:

```sh
ARENA_CHROMIUM_PATH=/usr/bin/chromium node tools/precinct-performance.ts \
  --software --url=http://127.0.0.1:4173/ --scene=office --tier=low \
  --camera=third --viewport=1440x900 --dpr=2 --seconds=60 --warmup=15 \
  --out=/tmp/arena-perf-office-low
```

For the later authorized M5 hardware run, use that machine's installed Chromium/Chrome executable or Playwright browser, omit `--software`, and use a foreground headed browser. Record the verified computer model, OS/browser, power mode, battery/AC, display/refresh/scaling and ambient/thermal conditions alongside the JSON. The operator-provided machine label is not programmatically verified.

```sh
node tools/precinct-performance.ts --headed --url=http://127.0.0.1:4173/ \
  --scene=courtyard --theme=studio --tier=medium --camera=third --protocol=movement --viewport=1440x900 --dpr=2 \
  --seconds=300 --warmup=30 --machine-label='Verified MacBook Air M5; conditions in run notes' \
  --out=/tmp/arena-perf-courtyard-balanced
```

Repeat Office/Courtyard at low/Balanced/high and first-/third-person, then `--tier=adaptive`. Compare cold entry, warm steady walking, crowded sightlines, interview/observation screens and paused/free-inspection separately. This runner covers sustained lobby walking and real turning, not all stations or a live interview. Additional station/courtyard traversal and real-session checks remain necessary before release. Do not pass a development-server run off as production; the runner refuses `import.meta.env.PROD === false`.

The runner rejects remote URLs, credentials, query strings and unsupported parameters. It opens an isolated browser context with no permissions and blocks backend/external HTTP and all sockets. No pre-existing browser or user's desktop is used. It requires one Canvas, a real WebGL renderer, the requested architecture, visible page focus, actual arrow-key camera change and WASD minimap displacement. It does not use fast travel or synthesize animation frames. Walking reverses around a fixed anchor to avoid cumulative drift. Each hold has a bounded assertion timeout and releases the key in `finally`.

Measurements run at least 60 seconds after warm-up; target acceptance uses at least five minutes. Video, screenshots and devtools tracing must be disabled during the primary measurement. `after-measurement.png` is captured only after the probe stops. `performance-report.json` is saved on success and failure. Loaded JS/CSS/GLB/texture/font/manifest bytes are SHA-256 fingerprinted from actual successful browser responses before measurement; the sorted loaded-asset fingerprint identifies the exercised production artifact subset. Record the source revision/build manifest alongside it. Late resource loads invalidate steady-state evidence. A completed diagnostic is not automatically a passing frame budget. A slow result is useful evidence and is retained.

## Controlled before/after comparison

Build two disposable copies of the same final integrated source and generated scene assets. Do not compare an older architecture/capture branch against a newer scene. The instrumentation-only baseline adds the same probe and runner but retains the original Canvas DPR expression, `AdaptiveQuality` and pre-substep Controls. The optimized candidate adds the render-policy and bounded-live-step patches. Both Canvas patches are pinned to the navmesh Canvas SHA-256 `af359c64f76a41094980531e873ea363be7bdc0f7b52d623665dbe26fa69df35`; rebase explicitly if the integration source changes.

Run both with identical scene, tier, camera, viewport, emulated device DPR, browser executable/version, renderer flags, warm-up and requested duration. Use low tier for the first software A/B: the unchanged baseline automatically falls to low on software and does not honor the newer pinned-quality flag. A baseline/candidate comparison with different observed tiers is not a controlled fixed-quality comparison. On hardware, either verify one unchanged tier throughout both runs or report it separately as an adaptive-policy experiment. Compare drawing-buffer pixels too; a pixel-budget experiment intentionally changes those pixels and must say so.

The spatial route is the same repeated real-keyboard lobby walk/reverse script, with actual start/end positions and camera-turn changes retained in each JSON. Collision, frame scheduling and the live-step change can alter exact trajectories and cycle counts; inspect the recorded movement rather than assuming matched paths. A straight, fixed-heading one-second integration experiment below isolates speed correctness. Do not claim combined turn-and-walk path invariance from that experiment. Crowd elapsed-time correction can also change visible actors; compare draw calls/triangles and route records alongside frame times rather than attributing all differences to fill rate.

Use baseline → candidate → candidate → baseline order when time permits, with independent contexts and warm-up, to expose cloud contention/thermal order effects. At minimum retain one complete production run from each build for each scene and mark a single pair as diagnostic, not a statistically established gain. Preserve the same runner/probe hashes in both overlays, both loaded-asset fingerprints, the full source/patch manifest, raw JSON and captured-after-measurement image. Report p50/p95/p99/max, average rendered FPS, long tasks, input proxy, calls, triangles, DPR/pixels and duration side by side; an unsuccessful/contaminated run stays visible and cannot establish an improvement.

### Deterministic actual-Controls distance evidence

The identical `PrecinctControls.distanceEvidence.test.tsx` harness imports the real Controls from each build. It dispatches one held W input for exactly one second of supplied frame deltas, then tests one separate second of arrow rotation. Only the expected legacy result changes through a test-only Vite environment flag. These are deterministic integration measurements, not measured browser FPS.

```sh
# Run from the instrumentation-only baseline web directory.
VITE_ARENA_PERF_BASELINE=1 pnpm exec vitest run src/components/precinct/PrecinctControls.distanceEvidence.test.tsx
# Run from the optimized candidate web directory.
pnpm exec vitest run src/components/precinct/PrecinctControls.distanceEvidence.test.tsx
```

Each passing case prints an `ARENA_MOVEMENT_EVIDENCE` JSON row with actual displacement from the camera owned by Controls. Preserve the run log and report those observed values. The passing deterministic actual-Controls harness measured the following distances. These supplied-delta results are not observed browser FPS:

| Supplied frame rate | Baseline measured metres in 1 s | Candidate measured metres in 1 s |
| --- | ---: | ---: |
| 5 Hz | 0.6 | 2.4 |
| 10 Hz | 1.2 | 2.4 |
| 20 Hz | 2.4 | 2.4 |
| 30 Hz | 2.4 | 2.4 |
| 60 Hz | 2.4 | 2.4 |

`WALK_SPEED` is asserted as 2.4 m/s. Separate yaw expectations are 0.425/0.85/1.7/1.7/1.7 radians before and 1.7 radians at every listed rate after. Collision, path corners, actor motion, input edges, pause/hidden/focus/seating/replay gates and a 500 ms stall have separate regressions. The bounded live policy drops elapsed time above 250 ms and carries no backlog; it does not manufacture rendered frames during a stall.

## What the numbers mean

- Frame p50/p95/p99/max are nearest-rank intervals between actual render submissions from the existing R3F frame loop. No assumed frame rate. Average rendered FPS is submitted frames divided by measured wall-clock duration. Hidden/demand/visibility interruptions invalidate steady-state acceptance rather than disappearing silently.
- Draw calls and triangles come from `gl.info.render` after R3F renders. In the current single-pass precinct this includes any shadow passes performed by the renderer. If postprocessing/multiple `render()` calls are introduced, reset/aggregation ownership must be reviewed; default Three counters reset on each render call.
- CPU frame-and-submission time runs from an early negative-priority `useFrame` callback through `addAfterEffect`. It includes callbacks and WebGL submission, not actual GPU completion or physical display scanout. GPU milliseconds are explicitly `null`.
- Input-to-render-submission measures canvas movement key dispatch to the next rendered submission. It is a proxy, not input-to-photon. Native Event Timing duration, when supported, is a separate browser event-to-next-presentation estimate with rounding and a 16 ms threshold; it is not an unbiased latency distribution. Unsupported/zero samples mean unavailable. Physical input-to-photon remains `null`.
- Long tasks use the browser observer's >=50 ms entries. Unsupported observers are explicit.
- Renderer/vendor strings, software detection, browser/host details, actual DPR, drawing-buffer dimensions/pixels, tier sample counts, shadow enablement and geometry/texture/program counts accompany every report.
- Material texture memory is a deduplicated RGBA8-plus-mips estimate, excluding environment/render targets and driver overhead. Counts are not bytes. Compression, texture formats and unknown image dimensions remain caveats; actual GPU allocation is `null`.
- Frame metrics retain at most 36,000 samples; event/long-task metrics retain 2,048. Dropped samples are reported. No per-frame sorting, React state update, scene traversal or stringification is performed by the probe. Distribution sorting and scene inventory happen only on explicit snapshots. A retained-frame overflow invalidates acceptance.

## Proposed budgets and enforced quality policy

These are working project budgets to test, not universal Three.js limits or hardware guarantees. Triangle/call targets refer to the entire visible rendered frame, including actors and any extra passes, not the GLB alone.

| Tier | DPR cap | Drawing pixels cap | Draw calls target | Triangles target | Material texture estimate target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Low | 0.75 | 1.5 million | 140 | 500,000 | 192 MiB |
| Balanced (`medium`) | 1.25 | 2.5 million | 200 | 800,000 | 256 MiB |
| High | 1.75 | 4 million | 260 | 1,100,000 | 384 MiB |

DPR is the minimum of device DPR, the tier cap and sqrt(pixel budget / viewport area). The full-viewport envelope also conservatively bounds smaller embedded canvases. DPR stays in Canvas props; a child calling `setDpr` alone would be overwritten by later R3F Canvas reconfiguration. Resize/display-DPR subscriptions update the cap without a per-frame resize loop. CSS/HTML UI remains crisp independently of the 3D drawing buffer.

Adaptive quality waits four seconds after tier/continuous-mode/visibility transitions, then requires two >=2-second windows (minimum 30 samples each) with p95 >18.5 ms before stepping down once. There is no automatic step up, oscillation or persistent catch-up backlog. Known software renderers still immediately select low. `?precinctPerf=1&precinctPerfPinned=1` only disables automatic tier changes for controlled diagnostics; ordinary sessions adapt. Existing tier-dependent ambient staffing remains unchanged and is recorded in the report.

Warm steady-state frame-pacing acceptance: >=58 average rendered FPS, p50 <=17.5 ms, p95 <=20 ms, p99 <=1000/30 ms (33.333… ms), and <=1% intervals over 1000/30 ms. These tolerate minor scheduling jitter around a 60 Hz target; they do not redefine a visibly choppy run as 60 FPS. Compare successive sustained intervals as well as aggregate percentiles, and inspect genuine movement video recorded in a separate pass. The software runner never awards target hardware acceptance.

## Source review and prioritized optimizations

1. **Separate transfer cost from draw cost.** The supplied architecture exports are lossless Meshopt: Office 3,075,764 bytes /116,267 triangles /38 material meshes; Courtyard 3,167,788 bytes /121,656 triangles /44 material meshes. These asset audit values must be matched to the final build hashes; they are not runtime totals. Meshopt reduces transferred geometry; it does not remove actor skinning, fragment lighting, texture allocations or draw submission.
2. **Bound fill rate first.** Existing Canvas already disabled MSAA and capped DPR; this patch adds the absolute pixel ceiling and robust adaptation. Balanced remains the intended starting point for target hardware testing. Pin quality when comparing changes so automatic lowering cannot conceal a regression.
3. **Shadows and lights.** Current precinct Canvas does not enable shadow maps and no current directional/point light casts shadows. Actor `castShadow` flags alone do not turn the pass on. Keep current baked/procedural illumination until measured headroom exists. If dynamic shadows are added, prefer one tightly bounded 1024 directional/spot shadow, restrict casters, and update static maps only when needed. Point-light shadow cubemaps and screen-space AO/bloom need independent budgets. Current low uses fewer point lights; the environment is generated once and disposed correctly.
4. **Merge/instance with spatial boundaries.** Architecture already batches by material. Its large merged meshes span rooms, so frustum culling is not room occlusion culling. Avoid indiscriminately merging the whole precinct again. Compare per-room/court material batches against visible draw-call and triangle reductions. Repeated static benches, lights or columns can use instancing when geometry/material truly match; preserve stable interaction/collision identifiers. No geometry rewrite is included in this diagnostic patch.
5. **Avatar culling and work.** Staff clones share source geometry/textures, but rig/material instances remain independent and staff meshes currently force `frustumCulled=false`. Do not flip that flag blindly: skinned animated bounds must contain the actual pose. Next experiment: conservative per-rig bounds plus frustum testing while continuing authoritative animation/capture sampling; separately reduce offscreen render work without dropping recorded actors or changing recorded time. Reviewer/interview/procedural interpreters and assessment boundaries remain untouched.
6. **Textures.** JPEG/PNG network size does not imply small GPU allocation. Inventory dimensions and repeated maps before changes. A 2048x2048 RGBA8 map with mipmaps is about 21.3 MiB. Profile actor body/head/normal/alpha assets. Consider validated 1K variants for background actors and KTX2/Basis for suitable maps, with color/normal/alpha visual review. KTX2 requires locally shipped transcoder artifacts and `detectSupport(renderer)`; never just rename a PNG or assume every texture format compresses identically. Preserve licenses and original assets. No new decoder or texture pipeline has been introduced here.
7. **Avoid unnecessary frame work.** Existing Controls publishes minimap/pose at about 10 Hz and only when changed. The older WorldCanvas `?fps` probe sorts/reduces every frame; it is not the precinct probe and is not used here. The integrated successor caches hotspot line-of-sight/nearest selection only at identical XYZ and the same immutable manifest, compares emitted pose values, freezes tier-definition containers, and skips only the already-canonical stationary Low/Balanced crowd solver state. Movement, manifest changes, tier reconciliation and noncanonical values retain their normal paths; High/patrol uses the original solver. Deterministic baseline/candidate invocation tests show 200→0 line-of-sight calls and 10→0 redundant pose publications over 100 stationary frames, 300→0 repeated definition builds, and 100→0 unnecessary stationary solver calls per Low/Balanced tier. These are measured invocation reductions, not milliseconds, FPS or lower main-thread-long-task proof. Remaining per-frame allocations need profiling before further changes. Keep acceptance-critical collision/path work authoritative. Avoid introducing per-frame React state or new `requestAnimationFrame` loops.
8. **Low-FPS correctness.** The bounded live-navigation correction is integrated and covered by the green web gate at `a7626569`. It consumes up to 250 ms as at most five 50 ms live-only substeps, drops excess without backlog, preserves interaction edges/capture publication once per render and keeps recorded camera/clip interpretation unchanged. Actual-Controls deterministic tests measured 2.4 m/s walking and 1.7 rad/s turning at 5, 10, 20, 30 and 60 Hz; the legacy baseline slowed at 5/10 Hz. Separate regressions cover routes, crowds, collision, focus/pause/seating/replay and callback counts. This corrects elapsed-time consumption within the bound; it cannot manufacture rendered frames or preserve real-time speed during repeated stalls above 250 ms.

## Primary references

- [Three.js geometry merging and draw overhead](https://threejs.org/manual/pages/optimize-lots-of-objects.html)
- [Three.js responsive rendering and pixel ratio](https://threejs.org/manual/pages/responsive.html)
- [Three.js renderer counters and reset semantics](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Three.js KTX2Loader and hardware support detection](https://threejs.org/docs/pages/KTX2Loader.html)
- [Three.js texture memory](https://threejs.org/manual/pages/textures.html)
- [React Three Fiber performance pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls)
- [W3C Event Timing specification](https://www.w3.org/TR/event-timing/)

## Release evidence still required

- Type/lint/focused tests and the existing aggregate gates on the exact integrated source.
- Production artifact hashes and true software diagnostic JSON for both architecture variants.
- Real keyboard/crowd/camera footage, labelled with the renderer actually used.
- Five-minute foreground target-hardware tests at native browser/display conditions, including crowded/interview sightlines, battery/AC and warm-machine repeat.
- Regression comparison with diagnostics disabled to bound instrumentation overhead.
- Do not describe GLB compression, a passing unit test, a cloud screenshot or a software-renderer video as measured M5 60 FPS.
