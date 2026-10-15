# UI v2 implementation notes

## 2026-10-15 20:36 UTC — aggregate lint completes; two source diagnostics corrected

Full-project [web lint at e52122c](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38802346166/job/116654641255) completed without heap exhaustion and reported exactly two typed-rule errors: the capture-audio boundary compared an already-typed boolean to false, and one scene-context assertion used a shorthand void expression. The boundary now explicitly accepts an unknown callback result and retains its exact fail-closed runtime comparison; malformed results are covered alongside false/true/throwing callbacks. Braces make the scene assertion comply without changing its expectation. No lint rule or test is removed. Fresh aggregate validation is pending; the local CPU lane is reserved for the isolated performance A/B.

The same commit's [Python job](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38802346166/job/116654642155) passes Ruff, formatting, mypy, isolation, cost parity, ratchet and dependency policy, then stops before pytest at the two previously documented historical oversized GLBs. The separate [main Python diagnosis](main-py-baseline-diagnosis.md) establishes a different missing-Docker fixture failure on main; neither is relabelled as a web regression or a successful aggregate check.

## 2026-10-15 20:29 UTC — full lint process memory failure and bounded correction

Remote merged checkpoint `293ea9c` started the full unchanged pnpm check chain. [Web CI](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38801190197/job/116650344962) stopped during whole-project ESLint at about 2 GiB of V8 heap, with exit 134 and an explicit JavaScript heap-out-of-memory error. Types/tests/coverage/build were not reached in that job. The earlier 38-file lint and 444 focused tests remain valid bounded checks, not aggregate acceptance.

The web lint script now launches the same installed ESLint CLI on the same `.` file scope and `--max-warnings 0`, with a finite 4096 MiB old-space allowance. No rules, ignores, typed-project settings, test/coverage thresholds, assertions or check-chain stages change. This allocation applies only to the developer/CI lint process, not the shipped browser app. The command is being revalidated in a fresh full CI run; no pass is claimed yet.

## 2026-10-15 20:19 UTC — genuine main merge focused gate passes

The resolved main `693c8c1` merge now passes strict app/tools types, zero-warning lint on 38 changed web paths, and all 444/444 tests across 25 focused suites. All 66 pinned inputs were rechecked after execution. [Exact merge verification](merge-validation-2026-10-15.md) preserves the initial 441/444 attempt: two diagnostic wording mismatches were corrected without changing validators/tests, and a variable first-route timeout was profiled and subsequently passed under its original five-second limit. No timeout, assertion, lint policy or coverage floor changed. The full aggregate web gate and actual combined browser/audio acceptance remain pending.

The merge retains genuine history and incoming backend/root/generated changes exactly as main supplies them; no UI-authored change exists outside the permitted scope. Actual two-world navmeshes and checked generic recording/annotation compatibility are included. The source checkpoint will be pushed additively to ui-v2; no PR merge, main push, force push or rewrite is requested.

The completed [Whisper synthetic proof](WHISPER-LOCAL-PROOF.md) and attribution are included: normalized 3/5 exact phrases, 3/44 word edits (6.82% WER), 15.215 seconds for 25.154 seconds of audio and 144.8 MiB peak child RSS. The material phrase substitution is preserved visibly; optional review-before-Add dictation remains a separate unvalidated implementation.

Production performance baseline/candidate checks and paired real-input Office/Courtyard diagnostics are now the active heavy-job lane. Actual voiced-browser capture and new courtyard stills follow. The MacBook Air M5 60 FPS target is still unverified. Exact main-plus-previous-UI scanner reproduction confirms the earlier one-finding result; the later source checkpoint adds the separately reviewed Blender geometry fingerprint false positive. Owner decisions on clean publication and exact scanner-policy handling remain pending.

## 2026-10-15 20:02 UTC — main reconciliation and checked navigation source

The ordinary merge of genuine main `693c8c1` is open on ui-v2 above preserved remote source checkpoint `9cd148b`. Both recording conflicts are resolved; no unresolved paths or whitespace errors remain. Backend, root policy and generated contracts match incoming main unchanged. The merge has not yet been committed because its fresh aggregate validation remains pending.

The 26-path actual two-world navigation/capture package and 14-path upstream recording reconciliation are now integrated. Isolated navigation checks passed 299/299 runtime tests and 95/95 scoped coverage tests, strict app/tools and zero-warning lint. These are package results, not a claim that the merged application has passed. See [navigation evidence](navigation-proof/README.md) and [actual upstream seams](UPSTREAM-SEAMS-2026-10-15.md). Generic upstream world data stays inert unless a checked UI adapter understands it; annotations and legacy v1 remain preserved.

The security investigation now distinguishes exact main ancestry (zero findings) from the default all-fetched-refs scan (two reviewed false positives: the public localStorage name and a Blender geometry fingerprint). The earlier CI check's two annotations are not two scanner findings. [Exact diagnosis and publication consequence](SECURITY-REF-SCOPE-2026-10-15.md). No scanner policy was changed.

The bounded official Whisper tiny.en proof is using the sole heavy-job lane. Strict/focused merge checks follow, then production performance A/B and actual voiced-browser recording. No MacBook Air M5 hardware result, aggregate gate or combined browser/audio acceptance is claimed at this checkpoint.

## 2026-10-15 19:08 UTC — integrated source checkpoint before upstream contract reconciliation

Studio/Office themes, training stations, neutral reviewer/cast, immersive captions, local sampled-world capture/replay, the selectable original courtyard annex, and original scripted staff audio are now integrated into `ui-v2` source. This is a recoverable **pending-validation** checkpoint, not another accepted playable slice. The previous published web gate at `1c874bc` does not validate this larger source set. The corrected combined candidate passed strict app/tools checks and changed-source lint; six previously failing focused suites passed 55/55. The full combined test/coverage/build and actual combined browser/audio acceptance remain pending. Native local rehearsal TTS passed 36 focused tests and produced 13 real bounded PCM WAV responses; it remains fixed authored dialogue, with no natural AI-conversation claim.

The courtyard source and losslessly compressed runtime are included with the surveyed HABS reference and rights attribution. Office remains a selectable original world. Scene identities pin the actual geometry and interpretation dependencies; replay rejects mismatched contexts. Capture lifecycle/clock fixes, convex-cell navigation and measured quality/benchmark improvements are still in isolated validation and are not included in this checkpoint. The first navigation/capture focused pass was 290/298: three preserved-station reachability defects and five lifecycle/test-readiness failures are being investigated without moving the station or relaxing checks.

Exact upstream `main` has advanced to `693c8c193229ac70754ffaad8335d757ee684a1a`, adding the anticipated world telemetry, NPC, instructor, Coach Lab and voice seams. The owner's original brief explicitly says to merge main into ui-v2 when these appear. After this source checkpoint, perform an ordinary history-preserving merge and reconcile web contracts; no backend implementation edits, generated-file hand edits, paid calls, rewrite or main push. The new v2 recording envelope needs special review for generic world-data preservation, annotations, integer clocks, and local world-only capture compatibility.

[Issue 19](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/19) now tracks the MacBook Air M5 production-performance target, instrumentation, bounded Retina pixels, low-frame-rate movement correctness and actual hardware verification. No performance result is claimed yet. Historical oversized blobs and the verified localStorage-name scanner false positive remain separate PR-wide blockers; the replacement-branch decision is still pending.

## 2026-10-15 18:42 UTC — published checkpoint and verified CI

Ordinary additive pushes to `ui-v2` have resumed. Remote `1c874bc6ad85282a8010b314ceb3b94cab2b96e2` includes the previously local reception (`82dbfe0`), dossier/notebook (`a8c309d`) and interview/observation (`2fde24f`) checkpoints, the real silent preview report, and the isolated offline-recognition findings. Earlier dated notes saying those commits were local-only describe their status at that time. PR #9 remains draft and is not ready to merge.

The complete unchanged web gate now passes in [CI for `1c874bc`](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38777913534/job/116570250669): lint, strict types, 123 suites / 1,799 tests in both ordinary and coverage runs, and production build. Coverage is 98.58% statements, 95.71% branches, 99.44% functions and 99.71% lines. This closes the published interview/observation web gate; the earlier local timing failures remain recorded and are not relabelled as successful. The stronger walkthrough harness passes strict tools types and zero-warning lint, but renewed runtime/video acceptance is pending.

All 237 changed paths at this checkpoint remain inside the approved UI/docs/assets scope; generated contracts are unchanged. No current committed file exceeds 5 MiB (largest: 3,075,764-byte GLB). Historical oversized GLB blobs remain in Git history and still prevent a clean `push-clean` result. The owner decision about a clean replacement branch is separate and still pending; no history rewrite, force push, main push or merge has occurred.

All checks for that source commit are terminal: web, database, title, TruffleHog, OSV and the Python security/license job pass. Python stops at the historical asset cap before its tests. Gitleaks reports one reviewed false positive: `generic-api-key` at `web/src/lib/precinct/npcVisitMemory.ts:8`, introduced by `82dbfe0`. The value is a public localStorage namespace used only by getItem/setItem/removeItem for opt-in visit memory, not an authentication secret. The pinned scanner reproduced exactly one finding locally. No scanner/configuration exemption or history rewrite was made. See [CI and security diagnosis](CI-CHECKPOINT-1c874bc.md).

Studio/stations/reviewer/voice/capture, courtyard variants and scene-context updates are still separately staged and undergoing combined validation. Their source/package checks do not mean the published application includes them. See [the measured synthetic recognition proof](OFFLINE-RECOGNITION-PROOF.md), [current acceptance gaps](ACCEPTANCE-GAPS.md) and issues #12–#18 for the remaining work.

The owner's current performance target is a smooth 60 FPS production demo on a MacBook Air M5, including bounded Retina drawing-buffer cost and sustained navigation. Actual M5 hardware remains untested. Production profiling must report frame-time percentiles, actual draw calls/triangles, long tasks and measurable input latency; screenshots and compressed download size do not establish that target.

## 2026-10-15 — slice 01, precinct shell and movement

Issue: https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/7

Draft PR: https://github.com/bbsatvik01/unissant_agentic_training_arena/pull/9

Branch `ui-v2` starts from the genuine `main` history at `1ef9a9f`. Work is performed on the dot cloud computer. No cloud models, paid services, credentials in source, or backend edits are used.

### Architecture

- `/` is the precinct, rendered with the repository's React Three Fiber/Three.js runtime.
- `/session` retains the existing working session route with its reducers, generated contracts, API transport, recording playback, and training panels intact.
- `PrecinctCanvas` owns rendering and a frame-local movement controller; it has no API or case access.
- Pure `src/lib/precinct` functions handle swept collision, route finding, controller dead zones, and camera-mode policy.
- The editable original Blender scene lives in `assets-src`; the material-batched runtime GLB and collision/navigation manifest live in `web/public/world`.
- Existing MIT Rocketbox investigator geometry uses an original, speed-driven walking pose. It never takes truth, deception, case facts, or score as input.

### Playable controls

WASD moves; arrows look; Shift sprints; E interacts; V switches first/third person, adding free orbit only while paused; M opens the map; Esc pauses. Right-click enables pointer-lock mouse look. Left-click the floor routes around obstacles. Number keys 1–0 fast travel. A connected controller uses sticks and A. Reduced motion, larger text, high contrast, and low/balanced/high rendering tiers are exposed in settings.

### Boundaries and next slice

This slice makes the architecture and movement playable. Station panels honestly identify their orientation-slice state and preserve a link to the existing session rather than pretending backend integration is complete. Reception/briefing, dossier/notebook, interview/observation, debrief/replay, and board/archive/lab connections remain the next slices.

The ground rule is retained verbatim. Nervousness, demeanor, accent, and stress are never evidence. Ambient behavior does not encode hidden case facts.

### Validation

- Asset validator: 121 colliders, 12 unobstructed hotspots, 30 connected navigation nodes, 8 clear door portals; original GLB approximately 5.48 MB / 116,034 triangles / 38 material groups.
- Pure movement: 28 tests, 100% lines/functions, 98.54% statements, 96.33% branches in the focused run.
- Whole-app typecheck and focused movement/renderer lint passed during development.
- New render-clock regression: 20 cadence tests, 100% coverage. R3F resets its absolute clock on demand/continuous transitions; delta-based sampling keeps navigation/minimap updates immediate after menus.
- Complete `pnpm check` passed on pinned Node 24.21.0: lint, typecheck, 77 files / 1,417 tests in both ordinary and coverage runs, and production build. Coverage: 98.18% statements, 94.61% branches, 99.13% functions, 99.60% lines. The [gate summary](slice-01-check.json) records this checkpoint.
- Test concurrency is capped at one worker to fit the shared cloud/laptop budget. Only the unchanged, dependency-free generated validator ESM is loaded natively during tests, avoiding a 2 MB Vite wrapper under precise coverage. The isolated CSP test still blocks `Function`/`eval` before its first import. Its former 5-second timeout now passes; no test, timeout, assertion, isolation rule, lint rule, or coverage threshold is removed or relaxed. Regeneration in watch mode requires a fresh test process.
- Clean isolated WebGL smoke: 21 checks per viewport, 42/42 passed, no console errors, page errors, failed requests or HTTP errors. All ten screenshots have the exact requested dimensions.
- [Five views at each resolution](screenshots/slice-01/README.md) and the [machine-readable report](screenshots/slice-01/smoke-report.json) are committed. The welcome, first-person, third-person, map and accessibility views were visually inspected.
- Remaining visual polish: low-tier in-world lettering is visibly aliased; readable text overlays/atlases are next. This is an early playable environment, not a claim of finished photorealism.

### Review workflow

GitHub permits one open pull request for a given head/base pair. The explicit `ui-v2` integration branch therefore uses one evolving draft against `main` while that draft is open, with a separate issue and tested checkpoint for each slice. No merge is authorized. After the user merges a reviewed slice, the next slice can receive a new draft PR. This avoids silently changing the requested branch strategy.

### Rendering verification

The managed cloud browser exposes no WebGL context. Its entry, directory, keyboard E interaction, native-dialog focus, and accessibility settings were checked through the explicit original-render fallback. An isolated fresh Chromium launched from the same cloud desktop verifies actual WebGL separately with the software renderer. Initial software runs exposed slow frame delivery; the runtime now detects software rendering, selects Low, uses lower DPR and fewer local lights, stops unnecessary drawing during menus/pause, and avoids duplicate stationary pose updates. Hardware-GPU frame-rate measurements remain distinct from this software-rendered functional check.

### Next checkpoint

[Issue 8](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/8) covers reception, fictional staff, explicit local visit memory and an evidence-first public briefing. NPC, monitor and world-replay code is prepared separately and is not presented as shipped in this slice. Docker/Postgres are unavailable here, so development uses bundled recordings and explicit local mocks; no real-model or hosted backend is started.

## 2026-10-15 — asset-gate and wayfinding checkpoint

PR title is now `feat(web): add UI v2 playable precinct and movement`; the new title-lint run passed. The remote `make py-check` failure at `5279845` was caused by 528 Ruff violations in the four added authoring scripts, not evidence of a secret leak or a frontend regression. The seven current authoring/audit scripts now pass pinned Ruff 0.16.8 check and format-check across the whole checkout (465 files), with no root configuration changes. Typed helpers and explicit validation guards preserve geometry and keep validation active under optimized Python. [Verification details](asset-script-gate-check.json) record normalized AST comparisons, actual GLB/manifest checks and limitations.

The editable Blender source and runtime export now contain larger width-fitted bold wayfinding. All non-performance manifest fields, 255 non-typography construction calls, 38 material groups and zero textures are retained. The scene is 5.67 MB / 116,267 triangles. See the [signage review](signage-readability-review.md). Integrated low-tier visual acceptance is pending the reception screenshot pass; hardware-GPU acceptance remains unmeasured.

The prior full web gate and screenshots remain the verified slice-01 checkpoint. At `e7da5df`, remote web, database, title and security checks pass. Python passes Ruff, format, mypy, no-rigging, silent-except, roles, cost parity, Supabase config, ratchet and dependency policy, then fails **push-clean**: both historical precinct GLBs exceed the repository's 5,242,880-byte committed-file cap. The brief's 25 MB LFS threshold is less strict than this existing repository policy; the asset validator mistakenly used that larger budget. Shrinking HEAD or adding LFS now cannot erase oversized historical blobs, because the unchanged gate scans every added/modified version in `main..HEAD`. No history rewrite, force push or gate relaxation is permitted. A compliant compressed snapshot is committed in local checkpoint `82dbfe0` while the owner decides whether to authorize a clean replacement branch/PR. Python tests and coverage were not reached; the database job subsequently passed. All remote checks at `e7da5df` are terminal, with only this historical-size failure.

The local checkout lacks the full Python environment and pinned gate binaries; no full local `make py-check` pass is claimed. The separate main-baseline missing-Docker test failure is outside this UI change and is not used to excuse our current asset-policy failure. Reception work for issue 8 is being validated separately.

## 2026-10-15 — slice 02, reception and briefing (verified local checkpoint)

Tracking: [issue 8](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/8).

- Two fictional speaking colleagues use the existing MIT Rocketbox assets and original neutral motion; high/balanced tiers add office/patrol staff. Staff animation receives presentation controls only.
- Explicit check-in and public-briefing acknowledgement advance the route's orientation state. Reception gives directions to the case board, desk, briefing, interview, replay, recognition wall and archive.
- A bounded, exact local NPC seam accepts authored topics and gives a safe redirect for unsupported prompts. The public assignment never enters this seam. This is fixed scripted dialogue, not an open-ended model.
- Optional local staff familiarity stores only an explicitly entered preferred name and bounded colleague visit counts. Load/save require opt-in and explicit actions; forgetting targets only this feature's key. No transcripts, case facts, identity inference or automatic storage writes.
- Every reply is a subtitle. Optional read-aloud chooses only installed device-local voices after a click; absent voices are reported honestly. Public briefing and conversation share single-speaker cancellation.
- The first actual-WebGL pass completed 36/36 functional checks and ten screenshots with zero page/console/network errors. Visual inspection caught a partially occluded sergeant and a scrolled-off panel heading; the standing/travel anchors and sticky dialog heading were corrected. These initial images are not the final visual acceptance.
- The complete unchanged `pnpm check` passes on pinned Node 24.21.0 and pnpm 11.0.8: lint, typecheck, 84 files / 1,500 tests in both ordinary and coverage runs, and production build. Coverage is 98.27% statements, 94.91% branches, 99.18% functions and 99.63% lines. [Gate summary](slice-02-check.json). No assertion, timeout, isolation rule, lint rule or coverage floor changed.
- The corrected actual-WebGL run passes 38/38 checks with zero page/console/network errors; [five views at both requested resolutions](screenshots/slice-02/README.md) were all visually inspected. No request invokes an API or leaves the local preview. Local speech correctly reports no installed voice and retains the full subtitle. Hardware FPS, physical gamepad, audible local voice playback and dynamic multi-NPC avoidance remain unverified; the patrol follows a collision-clear fixed corridor path.
- Lossless `EXT_meshopt_compression` reduces the runtime to 3,075,764 bytes. All 112 decoded buffer views and all 38 Three.js-loaded meshes are byte-identical to the signage export. The editable Blender source, materials, colliders and navigation are unchanged. The existing bundled decoder is wired locally; the existing meshoptimizer 1.1.1 version is now an exact web authoring devDependency, with no nested package manifest or policy exception. See [compression evidence](precinct-compression-review.md).
- Asset decoding/validation, strict Ruff/format, dependency policy, no-rigging and current snapshot file-size checks pass. The separate historical-size Git blocker remains; a smaller current snapshot cannot remove prior oversized blobs.

Upcoming tracked checkpoints: [dossier/notebook #10](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/10), [interview/observation #11](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/11), [debrief/world replay #12](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/12), and [training stations #13](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/13). These are not claimed as shipped by the reception checkpoint.


## 2026-10-15 — slice 03, desk and notebook (verified local checkpoint)

Tracking: [issue 10](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/10).

The route now mounts one canonical session runtime and an independently scoped working notebook. Public case selection is explicit. The desk has six accessible pages, original public text/tables, source-led timestamps, a metadata-only subject profile, and cited working notes. Case-file review advances orientation only through an explicit confirmation. Notes survive closing the desk, remain memory-only by default, and can be saved/restored/forgotten through scoped explicit controls. Case/source/user/run changes reset the workspace. A tested preparation-to-new-live-run offer preserves note metadata without automatic copying; its start-button wrapper will be wired with the interview station in the next slice.

The complete unchanged `pnpm check` passed on pinned Node 24.21.0: lint, typecheck, 99 files / 1,626 tests in both ordinary and coverage runs, and production build. Coverage is 98.48% statements, 95.28% branches, 99.39% functions and 99.69% lines. See the [gate summary](slice-03-check.json). Actual WebGL acceptance passes 38/38 checks with ten clean images at both requested resolutions, all visually inspected. Keyboard tabs, source tables/citations, scoped opt-in save/forget, reopen retention, large-text/high-contrast 150% reading, explicit progress and the ground rule are verified. A four-pixel inherited-header overflow and a missing font glyph were fixed before the corrected pass. No API or external requests occurred. See [screenshots and browser evidence](screenshots/slice-03/README.md).

The first full-gate coverage attempt encountered four unchanged five-second test timeouts and a worker-start failure while independent simple cloud filesystem commands also stalled. After recovery, all 64 tests in the four affected suites passed in a focused diagnostic, followed by the entire fresh green gate above. The diagnostic's expected whole-library coverage-floor failure was not treated as a full-gate pass. No application source, assertion, timeout, isolation rule, lint rule or coverage threshold changed between the failed and successful complete runs.

No-rigging, dependency policy, current-working-snapshot push-clean checks (1,322 files) and `git diff --check` also pass. The runtime GLB and editable Blender hashes remain identical to the verified compressed slice-two assets. These current-file checks do not pass or bypass the separate historical-blob gate.

This checkpoint remains local while the historical oversized-blob publication decision is pending. The last remote head is `e7da5df`; the preceding local reception checkpoint is `82dbfe0`. Exact `main` remained `1ef9a9f03ad895b70e32bb05392726fd0c889bdb` when checked at 12:01 UTC. No replacement branch, rewrite, force push or merge was performed. See [session runtime](SESSION-RUNTIME.md).


## 2026-10-15 — slice 04, interview and observation (browser-verified local source, full gate pending)

Tracking: [issue 11](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/11). The integrated source now has explicit intercom/seating, the existing text/voice controls, original public evidence reader and finding form, neutral seated Rocketbox cast, four shared-clock agent-work views and one physical monitor atlas. A narrow public-source cover connects explicit evidence presentation to the authored tabletop. One existing session, camera, Canvas and modal remain. Pending assessment intent withholds stale practice content before the new snapshot arrives.

Scene/cast/monitor focused checks pass; complete app typecheck and the integrated focused route/station/paper tests subsequently pass. Actual browser acceptance now passes 14 grouped checks at both requested resolutions, with all ten final images and four physical-scene audits reviewed. The first complete unchanged gate passed lint/types but hit six five-second test timeouts (1,793/1,799 passing); all 85 cases in the five affected suites then passed unchanged in a focused diagnostic. A second entire gate finished 1,798/1,799 with one different timing failure. The third unchanged gate, using the same pinned Node and cached pnpm in the native cloud terminal, also finished 1,798/1,799 with the existing desk confirmation/reopen test timing out at 6.794 seconds. All preceding failures passed. Coverage/build were not reached; slice four is not yet a green checkpoint. Focused CPU profiling of the unchanged route and observation suites began at 15:14 UTC instead of a fourth blind full retry. The scripted local run is explicitly unscored; genuine historical coaching remains separate. No audio result or exact live replay is claimed. See [architecture](INTERVIEW-SCENE.md) and [exact verification status](INTERVIEW-OBSERVATION-QA.md).

## 2026-10-15 — additional owner-requested presentation work

[Issue 14](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/14) tracks a selectable Studio theme, preserving the current Office theme, and an actual-browser walkthrough video. The original app-specific design guide will adapt the requested [Framer reference](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/framer/DESIGN.md) using only existing open fonts. Source work and video tooling are in progress, not yet visually accepted. The video will distinguish fixed local staff/mock replies from unverified audible voice or live AI.

[Issue 15](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/15) tracks verification and possible adaptation of a publicly published historical Washington, DC architectural plan. The candidate is the Library of Congress HABS Old Patent Office Building courtyard. Reference/rights/scale inspection precedes any remodeling; it is not represented as an exact current museum or security plan. Existing functional stations and safety contracts remain required.

## 2026-10-15 — local slice-four source checkpoint and next work

The complete interview/observation source and reviewed browser evidence are preserved as a local checkpoint even though the unchanged full web gate remains red. The 15:14 focused route/observation trace passed 36/36; module/setup costs and long sampling gaps do not establish a sole cause. A source-level cost audit and a bounded route-specific profile remain preferable to repeated blind whole-suite retries. No gate is relaxed.

The first actual-browser walkthrough attempt reached reception and the local acknowledgement, then failed waiting for case selection. Its raw video/report remain outside git as diagnostic evidence. Its short third-person interval did not establish a visibly loaded moving body, so it is not an accepted character walkthrough. A second bounded arrival/reception capture explicitly waits for all actual walking-avatar responses and then requires visual frame review. The walkthrough tool's full strict tools typecheck and zero-warning lint passed at 16:00 UTC.

The selected architectural reference is now the inspected HABS DC-130 courtyard survey. A separate original annex variant is staged, retaining the entire functional precinct module, exact stations and original world assets; no export or browser acceptance is claimed yet. The selectable Studio theme is also staged separately.

[Issue 16](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/16) tracks original scripted staff WAVs authored with officially verified rootless eSpeak NG, true output-analyser mouth motion and microphone setup-failure cleanup. The 23-line source/test package is staged; generation, listening and browser verification are pending. Formant scripted speech is not natural AI conversation, and offline speech recognition remains unimplemented.

All work since `e7da5df` remains local while the historical-blob publication decision is pending. No replacement branch, rewrite, force push or merge has occurred.

The second bounded Office/reception recording passed its guarded UI sequence and clean shutdown. A reviewed 66.76-second silent MP4 was delivered separately; it shows the loaded body, limited software-rendered motion and fixed reception text. It is not a finished locomotion or speech demonstration. Raw/encoded hashes and editing details are in [WALKTHROUGH.md](WALKTHROUGH.md). The PR remains a draft at remote `e7da5df`; its metadata and [issue 11 checkpoint](https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/11#issuecomment-6196606192) distinguish local source from remote code.
