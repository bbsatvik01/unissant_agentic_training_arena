# Optional local interview playback

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.

This developer-only option speaks the trainee's exact submitted question and the twelve existing
original authored subject beats. It is **unscored TEXT rehearsal**. No model, adaptive subject,
referee, coaching assessment, microphone recognition, cloud provider, paid call or credential is
introduced. The fixed subject sequence is independent of what the trainee asks. Existing synthetic
fixture labels, transcript text, evidence gates, finding and authored unscored debrief are unchanged.
Dictation, when separately enabled, must remain **dictate → editable draft → Send**.

## Explicit launch

From `web/`, with the existing pinned Node 24.21.0 and already-installed dependencies:

```sh
node tools/precinct-local-mock.ts --local-tts
```

No installation or download happens. The opt-in uses only the separately verified, unmodified
eSpeak NG 1.52.0 executable at:

`/workspace/shared/creative-tools/espeak-ng/root/usr/bin/espeak-ng`

This path deliberately has no CLI, PATH or environment override. A different machine requires a
separately verified installation and a reviewed source change; a missing installation returns 503.
The explicit data path and minimal library environment address this rootless installation's layout.
The browser and Vite setup, exact Origin/Host/CSRF guards and loopback-only binding remain as in
`LOCAL_SCRIPTED_MOCK.md`. The server never connects to any remote endpoint or reads credentials.
The audio is local, synthetic native formant speech; it is not a cloned or designed-person voice.

Without `--local-tts`, the existing `/api/tts` 503 behavior remains. No synthesis starts on import,
server construction, a normal Vite launch, or opting in before an actual TTS request.
The CLI prints a clear unscored TEXT-rehearsal notice when enabled.

## Exact integration contract

- Existing request: `POST /api/tts` with exactly `{ "voice": "investigator", "text": "…" }`.
- Existing success response: raw `audio/wav` bytes, not a JSON envelope or base64 DTO.
- `X-Arena-Speech: silent` is **absent** for real synthesis. `Cache-Control: no-store` avoids saving
  draft/interview text as persistent audio. `X-Arena-Local-Fixture: authored-unscored-local-espeak`
  identifies the optional local fixture response.
- The existing `ArenaApi.speak`/`postAudio`, `webAudioPort` and room voice engine need no edits.
  The audio bytes drive the existing Web Audio playback and lip analysis.
- The public allowlist is exactly `investigator` and `subject:Jordan Pell`, the speakers used by this
  fixture. Both use native `en-us`, 165 words/minute, pitch 50, amplitude 100. No hidden fact,
  truth/deception label, question classification, accent, demeanor or stress affects settings.
- `voice_available` remains false, voice quota stays zero, and voice ticket/WebSocket routes still
  refuse. Playback does not advertise a live backend voice session or an AI interview.
- The existing room engine switches permanently to browser fallback after its first refused,
  failed or unplayable clip. Enable the option before entering a fresh room with audio unlocked by
  a user gesture. Restarting the mock alone cannot reset an already-failed browser engine.
  Optional local playback does not change the browser fallback policy or make claims about it.

Contract sources read without modification: `web/src/lib/api/{arena,client}.ts`,
`web/src/routes/world/voiceEngines.ts`, `web/src/lib/voice/gemini.ts`, and the backend
`services/api/src/arena_api/routes/tts.py`. Public speaker IDs come from `web/src/lib/world/cast.ts`.

## Bounded process ownership

One FIFO queue owns at most one child process at a time. The limits are defined together in
`SPEECH_LIMITS`: 900 Unicode code points per text, 8 KiB TTS JSON body, four total active/waiting
jobs, 48 admissions per rolling minute, 256 admissions per process lifetime, 10 seconds from
admission including waiting, 4 MiB WAV and 4 KiB stderr. Limits refuse with 413/422/429/503/504;
accepted jobs are never silently evicted. Whitespace-only and NUL-containing text is refused.

The fixed executable receives literal argv with `shell:false`; arbitrary text goes only to UTF-8
stdin. No output file, temporary directory, persistent cache, arbitrary executable override,
inherited environment, SSML mode, MBROLA voice or network client is used. Output must be canonical
22,050 Hz mono PCM16 with nonzero signal. eSpeak stdout's placeholder RIFF/data sizes are finalized
to the actual bounded bytes received before returning the existing WAV contract.

An HTTP disconnect cancels its own queued or active job. The total deadline and shutdown also
cancel work. Active cancellation sends SIGKILL; the serial slot stays occupied until process close
is confirmed. Streams/listeners/timers are cleaned up. If close is not confirmed within one second,
all pipes are destroyed, the handle is unreferenced, and the queue fails closed, refusing further
process launches. The server's owned SIGINT/SIGTERM path closes the queue and existing resources.
No text or subprocess stderr is logged or included in API errors.

## Provenance

eSpeak NG: https://github.com/espeak-ng/espeak-ng ; Debian package 1.52.0+dfsg-5, authenticated
against the official Debian signed archive and package hashes. The earlier staff-voice verification
is retained byte-for-byte in `assets-src/local-rehearsal-speech/PACKAGE-VERIFICATION.json` and refers
to that earlier verification, not to execution of this new adapter. Full copyright and GPL text
are alongside it. This option invokes an external unchanged program; it does not bundle the
executable/data into the application. It does not reuse or redistribute a recorded person's voice.
Adapter source, tests and documentation are original project work; all existing dialogue remains
authored synthetic fixture content. No npm package, lockfile, backend or generated contract changes.

## Verification and acceptance

Focused verification passed: 36/36 tests, strict tools types, zero-warning touched-tool lint and
13 actual native eSpeak/API WAV clips, including abort/shutdown. Initial findings and exact native
evidence are retained in `LOCAL_REHEARSAL_SPEECH_QA.md` and its linked JSON. Browser acceptance
and the unchanged full integrated check remain pending; this is not yet a merge-ready claim.

Focused commands, from `web/` with the already-installed pinned dependencies:

```sh
node node_modules/vitest/vitest.mjs run tools/precinct-local-mock.test.ts tools/precinct-local-speech.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.node.json --incremental false
node node_modules/eslint/bin/eslint.js tools/precinct-local-mock.ts tools/precinct-local-mock.test.ts tools/precinct-local-speech.ts tools/precinct-local-speech.test.ts --max-warnings 0
```

Tests exercise injection-resistant argv/stdin/environment, exact allowlist, WAV framing/silence,
stdout/stderr limits, serial ownership, queue saturation, active/queued abort, total deadline,
rate/lifetime caps, shutdown, unconfirmed-child cleanup, CLI opt-in/default refusal, exact real
API-client WAV parsing for investigator and all twelve original beats, HTTP abort and transport
guards. The default fixture lifecycle/native import tests remain. Their import audit explicitly
recognizes the isolated adapter; it does not waive outbound-call checks on model/transport.

The repeatable native smoke is `node tools/precinct-local-speech-smoke.ts`; it launches only owned
loopback mocks, validates all thirteen real clips and default refusal, and checks native abort/shutdown.
Browser acceptance
must verify a fresh room after a user gesture: investigator audio, each authored subject beat,
nonzero audio-driven mouth motion, muted state, stop/leave/close behavior and no false AI/scoring
labels. Local dictation and microphone consent/lifecycle remain separately scoped.
