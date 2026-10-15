# Slice-four verification in progress

Updated 2026-10-15. This is not yet the verified playable checkpoint. The preceding complete checkpoint is slice three, local commit a8c309d.

## Focused evidence

- Cast: strict types/lint, 18 tests and 100% pure stage coverage passed.
- Agent-work views: 31 tests and 100% pure model coverage passed; all 18 reference hashes remained unchanged.
- Scene integration on pinned Node 24.21.0: complete-app types, zero-warning lint, 74/74 scene/cast/monitor tests and 100% coverage of two new pure modules passed.
- Final panel/route source: whole-app strict types and zero-warning lint over 23 touched TS/TSX files passed. The central station-read dependency's literal-widening test fix was included in types.
- Panel/route runtime rerun: 103/104 tests passed. All new tests passed; the unchanged original desk-confirmation test exceeded its unchanged five-second timeout (12.868 seconds). The preceding run was 102/104: one new source-reader assertion was narrowed to its correct region, and one start-control test timed out during a 48.985-second interval.
- Original-route diagnostics retained failures: three unchanged cases timed out at 8.085, 6.383 and 5.595 seconds; a final single desk diagnostic timed out at 6.457 seconds. No assertion mismatch was reported. Observed cloud transport/filesystem stalls are context, not grounds for calling a failed run successful.

No timeout, assertion, lint rule, isolation rule or coverage floor changed. Focused suites are not a substitute for the unchanged complete pnpm check. Runtime tests for the central station-read/assessment facade are included in the forthcoming combined check, not claimed by the panel run.

- Local scripted service: 21/21 tests, strict app/tools types and zero-warning lint passed at 13:05 UTC. Owned process import/shutdown tests passed unchanged; see LOCAL_MOCK_QA.md.
- A direct all-station geometry audit found the observation shortcut outside interaction range. Its landing point now stays clear of furniture and reaches the actual hotspot; a ten-station regression covers walkability and correct nearest interaction.

## Still required

The combined source still needs a successful complete lint/types/tests/coverage/build gate. Actual local scripted-mock interaction and genuine recorded-run playback subsequently passed the browser acceptance below at 1440×900 and 1920×1080. No audio/microphone, hardware-GPU frame rate, dynamic crowd or complete live exact replay is claimed by this slice.

Integrated corrections before the next browser attempt: app typecheck passed; four focused suites (paper, station geometry, station reads, interview route) passed 31/31. The initial station-read test selected a nonexistent event in a known recording; it now selects the genuine completed trial.status frame. Two async test blocks were corrected to await their held response microtask. At 14:01 UTC, touched-source zero-warning lint and four focused visual-model suites passed 30/30, including the static paper mipmap option. A first polish lint run caught an unnecessary assignment in the smoke and was corrected without suppressing the rule. Full combined acceptance remains pending.

## Actual browser acceptance — passed, full app gate pending

The corrected 14:02–14:19 UTC run passed all 14 grouped checks, seven at each requested resolution. Ten final images and four physical-scene audit images were visually reviewed. Actual local HTTP/SSE verified explicit acknowledgement, fresh practice/session IDs, preparation carry, call/sit/leave, seven typed questions, evidence thresholds and explicit presentation/citation drafts, a genuine submitted finding and its own unscored authored debrief. Separate genuine recorded-run playback verified one coach card, four synchronized projections, expansion/focus return and a Canvas monitor click. Pending and active fresh assessment withheld coaching after recorded review.

There were no page/runtime errors, unexpected failed loads or external/audio/microphone attempts during the checks. Both owned mocks exited successfully. The 1920×1080 deliberate active-SSE shutdown produced a reconnect 502 after shutdown began; it is retained separately, with no claim of zero teardown diagnostics. [Images and exact report](screenshots/slice-04/README.md).

## Complete-gate retry history

The first unchanged full `pnpm check` started after the browser process exited at 14:19 UTC. Lint and strict app typecheck passed. Ordinary tests finished with 1,793/1,799 passing across 123 suites; six cases in five suites exceeded the existing five-second timeout. There were no reported assertion mismatches. Coverage and build were not reached. The failed cases include unchanged ConsoleRoute, ReceptionBriefingPanel, PrecinctRoute and pure worldState tests, plus one new interview-route test.

All 85 tests in those same five suites then passed unchanged in a focused diagnostic (81.70 seconds). The prior ConsoleRoute timeout completed in 116 ms, the pure pose-invariance timeout in 231 ms, and the interview preparation case in 2,084 ms. No application source, assertion, timeout, worker isolation, lint rule or coverage threshold changed between these runs. This is evidence of non-reproducible timing failures, not a complete-gate pass. The second entire gate (14:36–14:50 UTC) again passed lint/types and finished 1,798/1,799 ordinary tests, with one different five-second timeout in the observation panel's four-screen expansion case (8.180 seconds). The original six failures passed. Coverage/build were again not reached; neither failed run is a green gate.

A third unchanged complete gate started at 14:51 UTC in the existing native cloud terminal, serially after the second process ended. It uses the same pinned Node 24.21.0 and the already cached official pnpm 11.0.8 CLI. The native shell lacks the executor's Corepack launcher; an outside-repository command wrapper locates that cached CLI without installing anything or changing package scripts. All source, timeouts, isolation and coverage thresholds remain unchanged. The native run also passed lint/types and finished 1,798/1,799 ordinary tests: the existing desk confirmation/reopen test exceeded the five-second limit at 6.794 seconds, while the preceding failures passed. Its ordinary test phase took 511.83 seconds and the complete failed command took 14m56.637s. Coverage/build were not reached. The focused unchanged route/observation diagnostic at 15:14 UTC passed 36/36 tests in 43.28 seconds; the desk case took 3.228 seconds and the observation case 1.783 seconds. The retained observation-worker CPU profile is dominated by module loading and jsdom setup, with 3.067 seconds in samples separated by more than 20 ms. It does not establish a causal application loop or prove that all failures are infrastructure-related. Only the last worker emitted a profile; a route-specific trace is still needed. No fourth blind complete retry is claimed.

One-way glass appearance, physical-paper pointer acceptance, audible voice, hardware FPS and physical-controller testing remain open.
