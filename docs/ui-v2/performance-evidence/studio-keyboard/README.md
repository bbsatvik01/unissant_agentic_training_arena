# Studio production keyboard diagnostic

**Historical experimental candidate:** the non-rendering floor change used in this sample is deferred. The successor retains the original transparent floor. Draw counts and timings below do not describe or validate that successor.

16 October 2026, 00:02–00:05 UTC. Same frozen combined source/dist as the [stationary diagnostic](../studio-stationary/README.md); standard environment retained. This is a real-keyboard measurement, not a video or fixed-coordinate route.

**Cold entry and frame pacing fail.** The runner completed 28 actual W/S walking legs and two arrow-key camera turns, recording real public minimap endpoints and rotation changes. It rendered 58 frames in 63.7305 seconds: **0.9101 FPS**; frame p50 **950.8 ms**, p95 **2,371.8 ms**, p99/max **3,796.6 ms**. The initial five-second readiness failure and exit 1 remain in the raw report.

- Studio selected and verified before entry, before timing and after timing; Courtyard interior, Low, third person, ordinary movement with reduced motion off, 1440×900 CSS/device DPR 1/effective DPR 0.75.
- Sixty-second warmup then at least sixty seconds of actual timed walking. Fresh owned profile/preview; no timed screenshot/video/trace or API/external/socket traffic.
- 30 input-to-render-submission samples, consistent with 28 walk keydowns plus two turns: p50 859.2 ms, p95 1,920 ms, p99/max 3,665 ms. This proxy is not physical input-to-photon.
- Browser Event Timing: 29 rounded/thresholded samples, p50 3,696 ms, p95 8,784 ms, max 10,752 ms. This different event-to-presentation estimate is not interchangeable with render-submission latency.
- CPU callbacks/submission p50 6.4 ms, p95 17.9 ms, max 73 ms; eight >=50 ms long tasks, maximum 225 ms. GPU elapsed time remains unknown.
- Observed draw counters: 80 calls / 143,266 triangles at 729,000 drawing pixels. These moving viewpoints are not controlled equivalents of the stationary 82-call view, so the difference is not a measured optimization gain.
- Zero runtime/network errors, hidden/demand frames or visibility interruptions. Chromium 154 / ANGLE SwiftShader; GPU time, actual VRAM and physical input-to-photon unavailable. Owned cleanup passed and the native temporary profile was removed.

The protocol repeatedly walks beyond 0.75 m from its current anchor and reverses, with bounded physical arrow turns. Frame-dependent turn overshoot/endpoint timing prevents claiming identical coordinates across runs. The existing 250 ms maximum live catch-up prevents unlimited simulation backlog; at <1 FPS, elapsed time is intentionally dropped and wall-clock movement remains slow. Neither successful input handling nor low draw counts establish a fluid MacBook Air M5 demo.

The actual final still was visually reviewed outside timing: the loaded third-person body and Studio controls are visible; world-label aliasing remains. This single back-facing view does not prove smooth locomotion, feet contact, face animation or audio. All complete raw measurements are retained; no local runner logs are committed. Next acceptance is exact integrated full gates and sustained native M5 testing, not another unmotivated software FPS sweep.
