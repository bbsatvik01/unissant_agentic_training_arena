# Optional local rehearsal speech verification

Verified 2026-10-15, pinned Node 24.21.0. Issue: https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/18

## Passed

- Focused mock and adapter runtime suites: **36/36 tests**, including all 16 new adapter tests and all 20 existing mock tests.
- Strict tools TypeScript: the unchanged `tsconfig.node.json`, with build-info isolated outside dependencies.
- Zero-warning lint: mock, mock tests, adapter, adapter tests, typed native smoke and scene recorder. No suppression or rule/gate change.
- Native eSpeak NG 1.52.0 via the actual guarded loopback `/api/tts` contract: **13 real WAV responses**, one investigator question and all twelve original authored subject beats. RIFF/data lengths, mono PCM16/22,050 Hz, nonzero RMS/peak and bounded duration validated.
- Investigator duration: 3.457 seconds. Subject duration range: 12.352–15.901 seconds. Exact per-clip byte count, signal values, text hash and WAV hash are in `LOCAL_REHEARSAL_SPEECH_NATIVE_QA.json`.
- Default TTS 503 retained; `voice_available:false` and zero voice quota retained. Real native cancellation and queue shutdown killed/closed their owned child successfully. The native smoke exited zero.

## Preserved initial findings

The first focused run passed 35/36. Its unchanged native-import/CLI lifecycle test exceeded the existing two-second deadline once. The complete unchanged suite then passed 36/36 on retry. This is recorded as a timing-sensitive initial failure, not hidden or explained as a proven source defect. The bound, assertions, isolation and worker count were not changed.

Initial lint found a deprecated IncomingMessage flag, one unused mock parameter, literal numeric inference, and QA instrumentation method/cleanup typing. These were fixed in source; a second lint pass caught two redundant assertions, also removed. Final strict types and lint passed. No suppression, skipped test, timeout increase, weakened assertion, generated-contract edit or backend change.

Retained logs in this source mirror: `results/tts-tests-initial.log`, `results/tts-tests-retry.log`, `results/tts-types-initial.log`, `results/tts-lint-initial.log`, `results/tts-lint-final.log`, `results/tts-types-final-2.log`, `results/tts-lint-final-2.log`, `results/tts-native-initial.json`. Logs are QA artifacts outside the shipping manifest; the summary and native JSON above are the shipping evidence.

## Still pending

The separately staged scene-only recorder passes strict types/lint but has **not run in a browser**. Browser audio playback, decoded clip timing, visual/audio lip-sync, scene recording, human listening and final media quality are unverified. The integrated full application gate must also run on the final merged source. Focused/native passes do not establish live AI, adaptive responses, scoring, microphone recognition, production voice availability or hardware performance.

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.
