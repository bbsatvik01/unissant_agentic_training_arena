# Add optional free local playback to the scripted interview

## What and why

Add explicit `--local-tts` to the developer-only local mock. The current room falls back permanently
after its first investigator TTS failure. A bounded serial eSpeak NG adapter can speak the actual
submitted question and all twelve original fixed subject beats through the existing raw-WAV API,
without a paid provider, credentials, backend changes or invented speech DTO.

This is unscored TEXT rehearsal. The subject is fixed authored dialogue, not a live/adaptive AI.
Dictation remains a separate editable-draft → Send feature (issue 17); finite staff WAVs and their
microphone cleanup remain issue 16. No hidden facts or behavior-based inference are introduced.

## Acceptance

- Default TTS remains 503; only explicit opt-in invokes the already-verified local eSpeak program.
- Existing API/client/room contract receives non-silent raw WAV for investigator and all 12 beats.
- Exact public fixture speakers use neutral native en-us settings independent of truth/role.
- One child at a time; bounded body/text/queue/rate/lifetime/output/deadline; argv only, no shell,
  arbitrary executable override, network, credentials, temporary file or persistent audio cache.
- Disconnect, deadline and SIGINT/SIGTERM cancel work, kill owned children and clean resources;
  unconfirmed termination fails closed. No subprocess text is exposed in errors.
- Live voice availability stays false; all fixture/unscored labels and ground rule are preserved.
- Provenance/licenses and repeatable native/browser acceptance evidence accompany integration.

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.

## Tests

Focused adapter/mock tests cover injection, wire framing, all authored lines, unknown keys/voices,
serial/capacity/rate/lifetime limits, deadlines, abort and shutdown cleanup, plus unchanged default
503/lifecycle coverage. Run strict tools typecheck and zero-warning lint, authorized native TTS
smoke, fresh-room playback/lip-sync/cancel browser QA, then the unchanged integrated full gate.

Staging status: issue 18 created; 36/36 focused tests, strict tools types, zero-warning lint and
13 native/API WAV clips passed. Browser capture and the final integrated gate remain pending.
