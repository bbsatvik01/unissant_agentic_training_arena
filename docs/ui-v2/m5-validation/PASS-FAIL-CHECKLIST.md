# Acceptance checklist

For every item record PASS / FAIL / NOT MEASURED, an evidence path, reviewer and date. A required NOT MEASURED blocks that scope. “Completed,” exit 0, a nice screenshot, asset compression, and passing CI are never substitutes for the checks below.

## Artifact and machine

- [ ] Exact final source/dirty-state identity and successful production build are tied to the full immutable dist inventory; received bytes match.
- [ ] Runner/helper/probe hashes match recorded source; no thresholds, quality settings or failures were silently changed/removed.
- [ ] Required notices are present; private material and unrelated files are excluded from the handoff.
- [ ] Physical MacBook Air M5 and native browser process are verified; no remote/cloud/software renderer is represented as the target.
- [ ] Native GPU evidence corroborates report renderer/vendor; no software renderer/context loss or unresolved generic renderer.
- [ ] Native display/refresh/scaling/zoom/DPR, requested emulated viewport/DPR, measured drawing-buffer pixels and tier are distinguished.
- [ ] Power, AC/battery percentage, thermal/ambient/rest history, background load and cold/warm order are recorded.

## Each primary run

- [ ] `options.seconds >= 300`, `options.headed == true`, `options.software == false`; no startup diagnostic mode substituted for acceptance.
- [ ] Original `readiness.initialReady == true`; scene-selection time is not misrepresented as the initial Office cold gate.
- [ ] `report.production == true`, `report.durationMs >= 300000`, `report.framesRendered > 1` and `evaluation.complete == true`.
- [ ] Correct `report.sceneAsset`; expected tier/pixel caps throughout (`report.tierFrames`, `report.dpr`, `report.drawingBufferPixels`). Adaptive history reported separately.
- [ ] Real keyboard movement has nonzero measured displacement and both arrow turns have camera rotation; no teleport/fabricated frames.
- [ ] `errors` and `blockedRequests` are empty; no late asset arrivals, context loss, hidden frames, demand frames, visibility interruptions or dropped frame samples.
- [ ] `evaluation.timingPassed == true` AND every threshold below passes. **The runner does not require this boolean to exit 0.**
  - `report.averageRenderedFps >= 58`
  - `report.frameIntervalMs.p50 <= 17.5 ms`
  - `report.frameIntervalMs.p95 <= 20 ms`
  - `report.frameIntervalMs.p99 <= 1000/30 ms` (the source uses 33.333… ms, not rounded 33.34)
  - `report.intervalsOver33_34Ms <= report.frameIntervalMs.samples * 0.01`
- [ ] No screenshot/video/DevTools trace or concurrent heavy activity during primary timing; generated stills are outside the sample.
- [ ] Frame distribution/max, long tasks, CPU submission, input proxy, calls/triangles, DPR/pixels, resource counts/texture estimates and observer/sample limitations retained with raw JSON.
- [ ] Both ≥5-minute cold-machine and warm-machine repeats exist for each claimed scene/camera/tier/power condition. No warm-cache or thermal-degradation claim beyond actual evidence.

## Smooth-demo scope beyond the lobby

- [ ] Intended interface theme and both architectures explicitly inspected. Office default is never reported as measured Studio.
- [ ] Separate ≥5-minute Courtyard traversal, busy crowd sightlines, interview/observation views, and replay interaction segments completed and documented; failures and unsupported states remain visible.
- [ ] Keyboard/focus/collision/camera/feet/clip/legibility/panel-transition checks pass. Demand/paused modes correctly separated from continuous-render FPS.
- [ ] Bundled replay provenance/version identified; live interview, exact audiovisual replay, microphone, generated speech or v2 fidelity are not inferred from a silent v1 recording.
- [ ] Ordinary diagnostics-off behavior reviewed at the intended demo settings; no unsupported numerical claim about instrumentation overhead.
- [ ] Quantitative claims for Studio or sustained non-lobby segments have matching ≥300-second measurement evidence. Under this unchanged runner, these remain NOT MEASURED even if the separate visual pass looks good.

## Final decision

- A failed cold-entry or timing budget is FAIL for that run, even if a later diagnostic obtains frames.
- A contaminated/incomplete/non-native run is INVALID FOR TARGET ACCEPTANCE; retain it as diagnostic evidence.
- A valid passing primary run is a **bounded lobby frame-pacing pass on that device/configuration**, not whole-demo readiness.
- A polished demo release remains open for missing required scenarios, missing native evidence, visual/interaction defects or a live feature that the offline packet cannot exercise.
- Preserve all raw attempts; summaries list failures and exclusions. Record the narrow claim actually supported and the remaining blockers.

## Future measurement work (not implemented; no feature expansion)

If authorized after review, extend the existing runner rather than adding app features: an explicit theme option/assertion; genuine sustained courtyard/crowded/interview/replay segments; actual viewport/native-condition recording; bounded per-window aggregates with no added render loop; explicit timing-budget exit status; and exact synthetic offline inputs for any measured interview/replay. Keep no-API/no-microphone boundaries unless that scope is separately approved. Revalidate instrumentation overhead, non-timing modes, preservation of failures, and the unchanged acceptance thresholds.
