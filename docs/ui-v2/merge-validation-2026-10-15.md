# Upstream-v2 integrated merge validation — 2026-10-15

Final focused result: **444/444 tests passed in 25 files**; runtime success: **true**. App/tools strict checks and all 38 changed-file zero-warning lint checks are recorded in the companion JSON. The gate ran against the genuine merged web tree with direct pinned Node tools, isolated caches/logs/build info and unchanged test limits. No coverage, build, full aggregate or native browser acceptance is claimed here.

## Preserved first result

The first run passed strict app/tools types and lint, then finished **441/444** tests. One existing replay route case exceeded its unchanged 5-second limit. Two unchanged upstream recording tests rejected the intended invalid inputs but failed diagnostic-string expectations. The approved correction changed only two messages in `recordingTelemetry.ts`, restoring “must be a list” and “exactly” while retaining the bounds. All tests remained unchanged.

The first two route cases were then timed with non-shipping instrumentation. Costs varied across rendering, queries and dispatch; the corrected trace passed both at 1,793 ms and 747 ms, with readiness waits 47/36 ms. This did not establish a persistent stall or justify changed timeouts/assertions. Both profiling attempts and the original failure evidence are retained.

## Exact scope

- 66 pinned source/config/asset inputs; full hashes and 25-suite/38-file lint inventories are in `merge-validation-2026-10-15.json`.
- Original input manifest: `024e64ac7257bbdb50159dae8aa93ba76859b8af335929c8fe625d57d21ce98b`.
- Final successor manifest: `d62454bc98d1ab754bce1711cee23de777f5fce391f9a626fbb793ac49f509c8`.
- Validation diagnostic successor: `a0b4e118e0cd2d40634574f04b97e5269ac2bfbbfdedc8b30dcd91e0d073a010`.
- Raw logs remain outside the repository; the JSON records their SHA-256 hashes.

The route still derives legacy graph playback from validated v1 and disables live planning through explicit v2 replay ownership. The approved actor callback identity, demand-modal clock and audio/scene capture guards remain in the pinned integration. Generic world data is preserved but inert; local profiles remain strictly typed.

Remaining acceptance: full aggregate including nav-specific route/Controls/geometry tests, coverage/build and native rendering. Sampled world/audio/layout limits remain disclosed. Main also tracks the instructor annotation day/Unicode limit and local-only NPC 600-versus-400-character follow-ups; these were not edited in this gate.
