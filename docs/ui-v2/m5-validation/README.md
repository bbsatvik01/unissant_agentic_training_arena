# Arena: MacBook Air M5 production-validation kit

Prepared from `ui-v2` at `a7626569ce7764b3d81cd884ff3c2768c6c5c069`, 2026-10-15 UTC. Source inspection only. No build, test, browser run, installation, packaging, upload, or Mac access was performed for this kit. Application features remain frozen.

## Start here

1. Read [SETUP-AND-HANDOFF.md](SETUP-AND-HANDOFF.md); obtain the exact production artifact and installed native prerequisites.
2. Follow [OPERATOR-RUNBOOK.md](OPERATOR-RUNBOOK.md). Run only on an authorized, verified physical MacBook Air M5.
3. Duplicate [RESULT-MANIFEST.template.json](RESULT-MANIFEST.template.json), recording every attempt, including failures.
4. Sign off [PASS-FAIL-CHECKLIST.md](PASS-FAIL-CHECKLIST.md) against actual evidence. Empty fields and missing scenarios are **not measured**, never passes.

## Important limits

- `web/tools/precinct-performance.ts` is reused unchanged. No new runner, app UI, dependency, executable, or benchmark framework is supplied.
- An exit code of 0 / status `completed` does **not** mean the timing budget passed. Read `evaluation.complete` and `evaluation.timingPassed` explicitly.
- `--scene=courtyard` selects architecture. The interface theme is still **Office (original)**. There is no `--theme` option; reloading restores Office.
- The timed route consists of two initial arrow turns and repeated short W/S walks around the spawn anchor. It does not prove sustained courtyard traversal, crowded views, interview/observation behavior, replay, or Studio-theme frame pacing.
- Every launch starts a new browser/context. Repeating it measures a warmed machine with a fresh context; it does not prove a warm-browser-cache experience. The five-second entry gate runs before architecture selection, initially on Office.
- Historical cloud/software evidence is not M5 evidence. GPU execution time, physical input-to-photon latency, actual VRAM allocation, and actual panel scanout are not measured by this probe.

The defensible result is initially: “The specified production build met/did not meet the measured lobby frame-pacing budget on this verified renderer under these recorded conditions.” A broader smooth-demo claim requires the additional walkthrough and measured coverage described in the runbook. This kit makes no M5-ready claim.
