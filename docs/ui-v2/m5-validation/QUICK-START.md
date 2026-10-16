# First MacBook Air M5 validation path

**Preparation only. Do not treat this as a delivered or approved-to-distribute artifact.** The [GSAP decision](../PORTABLE-LICENSE-STATUS.md), final unchanged full gate, immutable build/notices and authorized physical-device access remain open. The Studio-capable runner is validated in an isolated candidate; use only the exact final source/build named in the handoff, not an older runner that lacks `--theme`.

## Smallest useful first test

1. Receive and verify the exact artifact, notices and checksums. Confirm the physical MacBook Air M5, native ARM browser, actual GPU renderer, display scaling/DPR and power condition without recording serial numbers or unrelated personal data. Use installed approved prerequisites; no automatic system changes.
2. Start only the supplied loopback preview. Keep the browser foreground, unrelated heavy applications idle, and the machine in a documented rested condition. Preserve any cold-load failure; a later successful view is not a passing cold start.
3. Run **one five-minute Studio / Courtyard / Balanced / third-person real-keyboard sample**. Use the actual viewport/DPR selected and recorded for the demo; the `1440x900` / `2` values below are explicit requested emulation, not automatic discovery of the physical display. Do not record video, screenshots or traces during measurement.

```sh
node tools/precinct-performance.ts --headed --url=http://127.0.0.1:4173/ \
  --scene=courtyard --theme=studio --tier=medium --camera=third \
  --protocol=movement --viewport=1440x900 --dpr=2 \
  --seconds=300 --warmup=30 \
  --machine-label='Verified MacBook Air M5; actual conditions recorded separately' \
  --out=/tmp/arena-m5-studio-courtyard-balanced-cold
```

This command requires the matching development toolchain and installed browser. The optional portable visual preview alone does not include that toolchain. Set the browser executable using the documented existing `ARENA_CHROMIUM_PATH` option when necessary; do not invent a path or install a browser silently. No software-renderer or slow-start diagnostic flag belongs in target acceptance.

4. Save all raw results, including failures. Check `evaluation.complete` and `evaluation.timingPassed` explicitly, actual Studio observations, visible/continuous frame counts, correct scene/tier/pixels and real W/S/arrow movement. Exit 0 alone is not success. Required frame budget: average ≥58 FPS, p50 ≤17.5 ms, p95 ≤20 ms, p99 ≤1000/30 ms, and ≤1% intervals above 1000/30 ms (33.333… ms). Missing input/GPU observations are unavailable, not zero-latency results.
5. Immediately repeat for five minutes with a unique `...-warm` output directory, preserving power/display settings. This checks a warmed machine in a fresh browser context; it does not demonstrate warm browser-cache behavior. Record the gap, thermal/power changes and both distributions.
6. Do a separate ordinary diagnostics-off walkthrough at the same intended settings: arrival, reception, corridor/courtyard, case board, desk, interview/observation panel and bundled replay. Verify movement, camera switching, collision/focus, visible character/feet, legibility, panel response and absence of stalls. A separate recording may document this review but must be labelled with its actual scripted/offline scope. Unverified voice/listening and live AI are excluded from claims.

A passing pair establishes only sustained **lobby** timing under those conditions. The existing keyboard script repeatedly walks around its spawn anchor; it is not a full courtyard/station route or precise fixed-coordinate trajectory. Whole-demo acceptance still needs the [full checklist](PASS-FAIL-CHECKLIST.md), sustained coverage of the demonstrated segments, AC/battery and intended quality/camera variants. If the first target-device run fails, retain it and diagnose its measured frame/CPU/pixel/long-task evidence before changing settings. No smoothness guarantee precedes that evidence.
