# Optional local input dictation: scoped implementation plan

Status: measured native synthetic proof is complete. App candidate will be staged separately at precinct-whisper-dictation-next; no genuine integration, real microphone capture, browser test or further heavy execution is approved until its next explicit gate. Existing native SpeechRecognition and Vosk candidates remain frozen.

## Existing owners, inspected after the merge

Baseline genuine HEAD: `9cd148b0590b7563d994308b4dcfa3d91e12c0f0`; working-file hashes, rather than HEAD alone, govern composition.

- SessionControlPanel.tsx already chooses VoiceBar or the text Composer. Composer receives session.draft, session.updateDraft and a separate session.ask Send callback. Optional dictation belongs beside the text Composer and receives only draft/setter/scope/disabled state, never ask, session data or case facts.
- usePrecinctSession.ts owns the draft. updateDraft also records question-draft input when explicitly armed capture is active. Recognition stays in a separate ephemeral review buffer; Add to draft discloses that accepted text enters the normal replay journal and calls the existing setter once. Do not disable ordinary capture or create a competing draft controller.
- ReceptionBriefingPanel.tsx owns NpcConversation's prompt/setPrompt and submitPrompt. The same review control can append to setPrompt; only the existing explicit form submit validates and calls visit.reply. No assignment, history, score or hidden case field enters recognition or NPC input automatically. Staff responses remain authored local dialogue, not live AI.
- precinct-local-mock.ts already binds loopback, checks Host/Origin/CSRF, rejects credentials and offers optional --local-tts. Its default voice_available:false and provider voice-ticket refusal stay intact. New endpoints are dev-mock-only, not generated contracts or production backend API changes.
- Vite proxies /api to one loopback origin. Production dist is served by arena-api outside this UI scope. Page CSP stays strict; a native process needs no browser unsafe-eval exception.

## Small owned candidate

New files: web/tools/precinct-local-transcription.ts; web/src/lib/precinct/localDictation.ts; web/src/lib/precinct/localDictation.worklet.ts; web/src/components/precinct/LocalDictation.tsx; focused sibling tests. Narrow wiring: precinct-local-mock.ts, SessionControlPanel.tsx and ReceptionBriefingPanel.tsx. No dependency, lockfile, usePrecinctSession, backend or generated-contract change. Parent composes separate mock hunks against the frozen TTS baseline.

The mock is enabled only by an explicit --local-whisper flag. Fixed verified model and binary paths/digests identify this isolated installation; HTTP requests cannot choose a command, model, path, URL, language, prompt or decoding option. Setup remains an explicit developer operation outside Git. Missing/mismatched setup keeps the optional capability unavailable. Source/model/binary provenance is in WHISPER-LOCAL-PROOF.md; the executable is host-specific, so a portable setup workflow needs a fresh reviewed local build record rather than silently trusting an arbitrary executable.

One explicit capability-check click verifies a bounded, same-origin, dev-only response. No mount-time microphone, model download or inference. Client requires HTTP loopback host and development mode, credentials omitted, redirects refused, no arbitrary endpoint override. Capability is ephemeral and includes only the mock's process-local anti-CSRF token; it is not persisted. A cloud endpoint is not local to a user's separate computer; the browser and this loopback mock must run on the same computer.

## User flow and ownership

1. Check local dictation. Show absent/unavailable honestly when setup is missing.
2. Start after the visible disclosure. One owned getUserMedia stream; native browser permission remains explicit. Disable conflicts while live voice is active. Existing TTS must be stopped or kept off during capture; do not silently change a saved sound preference.
3. Request a 16 kHz AudioContext and verify its actual sampleRate. Reject unsupported rates clearly; no claimed or implicit resampling. The AudioWorklet captures real mono PCM, validates sequence/frame counts and bounds all worklet messages. No amplitude-only result is represented as recognized speech.
4. Stop or the 30-second bound ends capture, confirms all owned tracks/context/worklet are closed, then submits canonical PCM16 WAV bytes in memory. No simultaneous streaming inference; one native process, no waiting audio queue. Overflow, lost chunks or malformed PCM fail visibly rather than producing a supposedly complete partial transcript.
5. Show recognizing, then editable review text. Over 600 UTF-16 code units is a visible refusal, never silent truncation. Blank/silence/failure leaves the original draft unchanged.
6. Add to draft is a separate click. Append to the latest draft only if the full combined text fits the existing 600-unit limit. Explicitly disclose normal capture journaling when applicable. Send remains the existing separate form action; the review component never receives or invokes it.
7. Cancel, unmount, hidden page, scope change, conflict activation or request abort invalidates ownership and discards audio/review. Late permission grants stop their tracks; late capability/inference responses cannot update a new session. Abort kills and confirms closure of the child; unconfirmed cleanup poisons the runner instead of releasing another job.

## Native/request bounds

Strict canonical RIFF/WAVE PCM16 mono 16 kHz, exactly one fmt/data layout, correct sizes/byte rate/alignment, no trailing metadata, at most 480,000 samples / 960,044 bytes. Refuse extra channels, rates, chunk layouts, empty audio and excess body bytes. One active inference, no buffered request queue; bounded rate and lifetime. The native command uses fixed argv, minimal environment, stdin WAV/stdout text, no shell or transcript/audio files. Keep the tested two-thread, 1 GiB, 90 CPU-second and 120 wall-second bounds, bounded stdout/stderr and explicit termination/reaping. Body/response deadlines and no-store headers apply. No raw speech or recognized text in logs, telemetry, storage, URLs or error messages.

## Required focused tests before acceptance

Pure waveform validation and WAV sizes; one-process busy/refusal/rate caps; timeout/cancel/spawn/error/stdout-overflow/cleanup-poison paths; malformed and overlength transcripts; setup hash mismatch; mock absent/default503 and unchanged local TTS; cross-origin/Host/CSRF/credentials/method/body rejection. Browser fakes must test actual sample-rate mismatch, delayed permission after cancel, worklet sequence gaps and overflow, full drain/stop, track ended/worklet error, page hidden, session switch, request abort and stale completion. UI tests must prove no mount-time start, no auto-Add/Send, correct editable review, append to latest draft, single setter call, capture disclosure and ownership cleanup. Native synthetic proof does not replace these tests or a later explicitly authorized microphone smoke test.
