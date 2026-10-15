# Slice-five actor/scene merge

Source-only reviewed merge, 2026-10-15. No Node, lint, compiler, tests, build, renderer or browser execution has occurred for this package. Parent owns the serial QA slot and full gate.

The original actor package remains frozen at `precinct-actor-replay-integration`; this candidate contains its 23 source/test files, with one reviewed integration delta in PrecinctCanvas. `slice-five-actor-SHA256.txt` is the exact merged source manifest. `slice-five-actor-baselines.json` records the replacement baselines and untouched current files. `procedural-actor-original-SHA256.txt` records the original frozen package.

Reviewed PrecinctCanvas merge preserves all three current slice-four evidence-paper additions:

- `PresentedEvidencePaper` import
- Optional `onInspectEvidence` callback
- Currently presented public `interview.evidence` paper mount

The paper follows the actor package's display-only replay input ownership: it remains rendered from supplied current-public evidence, but pointer inspection is disabled during replay, just like the monitor interaction. No new evidence content, telemetry format or case inference was added.

Untouched byte-for-byte from the current mirror:

- `interviewScene.ts`, including the optional public evidence field
- `sceneTypes.ts`, including final observation anchor `[10.4, 0, -18.6]` and `Math.atan2(-0.6, -1.813)` yaw
- `interviewStage.ts`, including first-person camera framing at Y=1.12 and actor SUBJECT_EYES at Y=1.36
- `PresentedEvidencePaper.tsx`

The 22 non-Canvas actor files remain byte-identical to the original frozen package. No route, session, transport, capture status or import files were changed by this scene merge. The replay integration owner controls those paths.

The optional crowd-navigation v2 patrol addendum is not included. It must preserve every v1 clip and be reviewed/tested separately after the current actor package QA.

## Combined QA source corrections

2026-10-15: subject/coach Object.freeze position literals are explicitly typed Vec3, and the seated-leg test passes its five measured arguments explicitly to avoid union-of-tuples spread inference. Behavior/assertions are unchanged. Original actor staging remains frozen; these two changes live only in slice-five and its refreshed manifest. QA is owned by the replay integration worker.

Combined strict lint corrections: Controls effect uses its existing replayActive boolean dependency, retaining control state across same-ownership map refreshes. The synthetic replay test narrows the instanceof Bone result to the library default Bone type before storing it. No suppression or assertion was removed.

2026-10-15 runtime source correction: the walking-cycle regression now checks the exact cycle and time to 14 decimal digits rather than requiring bit-identical floating-point division. The actual result was 0.09999999999999999 for expected 0.1. Production animation math and all other assertions are unchanged. Runtime recheck is pending.
