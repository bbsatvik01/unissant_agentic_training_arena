# Studio stationary production diagnostic

**Historical experimental candidate:** the non-rendering floor change used in this sample is deferred. The successor retains the original transparent floor. Draw counts and timings below do not describe or validate that successor.

Issue [#19](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/19), 15 October 2026, 23:37–23:40 UTC.

## Result

**Timing remains failed.** The native cloud browser rendered 48 frames in 60.6345 seconds (0.7916 FPS), with frame p50 1,055.2 ms, p95 2,471.9 ms and p99/max 5,124.5 ms. The original five-second cold-entry gate also failed. Bounded later readiness allowed a separately labelled complete steady-state diagnostic; the runner retained exit 1. This is neither a smooth walkthrough nor MacBook Air M5 acceptance.

Every measured frame contains **82 calls / 143,280 triangles**, at 1080×675 (729,000) drawing pixels. This confirms omission of the invisible two-triangle floor draw in the combined candidate. Earlier fixed-view Office-HUD lighting samples measured 83 / 143,282; different theme/source and a failed timing result prevent claiming an FPS improvement from that reduction.

CPU callback/submission p50/p95 are 6.6/18.6 ms, with maximum 211.5 ms. Four main-thread long tasks were observed (p95/max 483 ms). These counters do not measure GPU completion, whole-browser CPU time, or input-to-photon. The stationary protocol records zero input-latency samples. No reduction in long tasks is established by this one sample.

## Protocol and integrity

- Frozen production candidate based on `a7626569ce7764b3d81cd884ff3c2768c6c5c069` plus the archived exact 17-file overlay. Genuine published source at measurement time was docs-only `a88f5c245d92f2e22a597bb4be38a7d8bb887730`; these runtime changes were still isolated.
- Actual Studio theme selected through normal settings and verified before entry, before timing and after timing. Courtyard **interior**, third person, Low tier, reduced motion, retained standard environment, 1440×900 CSS/device DPR 1/effective DPR 0.75.
- Camera position `[0, 2.15, 0.4]`, quaternion `[-0.06008895503210163, 0, 0, 0.9981930261643537]`, zero observed drift. Sixty-second warmup then at least sixty seconds of actual measurement. No capture or trace during timing.
- Chromium 154 / ANGLE SwiftShader; no hardware GPU. The renderer reports 94 geometries, 76 textures and 14 cached programs; shadows are off. Those counts are not measured VRAM or shader execution cost.
- Loaded supported asset-subset fingerprint `f6b0575d5847f76d05b5a8fd4fba2e7a11d80411e1ba43e1d9abbc073dab412f`; complete dist inventory is retained separately.
- Zero runtime errors, blocked API/external/socket attempts, hidden/demand samples or visibility interruptions. All owned process groups closed; native temporary profile removed; cleanup errors empty.
- Focused strict app/tools checks, zero-warning lint of 17 files, 423 tests across 45 suites and production build passed on this exact candidate. This is not the full unchanged `pnpm check`; integration and real-pointer routing remained pending at measurement time.

The actual after-measurement image was reviewed: Studio controls/ground rule are readable and the loaded third-person body is visible. Low-resolution world-label aliasing remains. A back-facing indoor still does not establish face, glass, exterior, interview, movement or audio acceptance.

The raw JSON preserves failed gates and bounded process metrics. Inventory files identify the whole source/build; the patch is losslessly archived with expanded SHA-256. All 27 per-scene interpretation inputs remain unchanged. GPU discovery found no accessible render node or display-class PCI device in the authorized cloud; no authorized saved GPU alternative was established. Native M5 measurement is still required.
