# Arena: MacBook Air M5 production-validation kit

Initial source audit at `a7626569` is preserved unchanged in `SOURCE-AUDIT.json`. Updated 2026-10-16 for the reviewed Studio-capable retained-floor source integrated above `a88f5c2`; [source update](SOURCE-UPDATE-20261016.json). Its first full unchanged local web gate failed one existing legacy readiness check; coverage/build were not reached. The failure is preserved and further validation remains pending. No Mac access, native M5 result, portable archive or approved distribution is established. Application features remain frozen.

## Start here

1. Start with the bounded [QUICK-START.md](QUICK-START.md), then read [SETUP-AND-HANDOFF.md](SETUP-AND-HANDOFF.md); obtain the exact production artifact and installed native prerequisites.
2. Follow [OPERATOR-RUNBOOK.md](OPERATOR-RUNBOOK.md). Run only on an authorized, verified physical MacBook Air M5.
3. Duplicate [RESULT-MANIFEST.template.json](RESULT-MANIFEST.template.json), recording every attempt, including failures.
4. Sign off [PASS-FAIL-CHECKLIST.md](PASS-FAIL-CHECKLIST.md) against actual evidence. Empty fields and missing scenarios are **not measured**, never passes.

## Important limits

- The existing `web/tools/precinct-performance.ts` now supports explicit `--theme=office|studio`, selecting normal settings and verifying actual root theme before entry, before measurement and after measurement. Its matching theme and position helpers are required. No new app feature, framework or executable is supplied.
- An exit code of 0 / status `completed` does **not** mean the timing budget passed. Read `evaluation.complete` and `evaluation.timingPassed` explicitly.
- `--scene=courtyard` selects architecture independently of `--theme=studio`. The default theme remains Office; pass and verify the intended demo theme explicitly. Reloading an ordinary session resets its theme.
- The timed route consists of two initial arrow turns and repeated short W/S walks around the spawn anchor. It does not prove sustained courtyard traversal, crowded views, interview/observation behavior, replay, or full-theme interaction coverage. Studio lobby timing is supported only when explicitly selected and verified.
- Every launch starts a new browser/context. Repeating it measures a warmed machine with a fresh context; it does not prove a warm-browser-cache experience. The five-second entry gate runs before architecture selection, initially on Office.
- Historical cloud/software evidence is not M5 evidence. GPU execution time, physical input-to-photon latency, actual VRAM allocation, and actual panel scanout are not measured by this probe.

The defensible result is initially: “The specified production build met/did not meet the measured lobby frame-pacing budget on this verified renderer under these recorded conditions.” A broader smooth-demo claim requires the additional walkthrough and measured coverage described in the runbook. This kit makes no M5-ready claim.
