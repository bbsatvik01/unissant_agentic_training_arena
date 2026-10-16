# One session runtime inside the precinct

The precinct composes the existing live-session and recording-playback hooks. It does not replace the trial reducer, SSE controller, generated contracts or existing `/session` route.

## Ownership and boundaries

- `usePrecinctSession` is mounted once by the precinct route. It owns source selection, public case projection, guarded local connection, session/recording replacement and audio opt-in.
- The original hooks expose readonly event-arrival maps from their existing clocks/cursors; agent monitors use these same arrivals. No second event observer or trial fold is introduced.
- Selecting a case loads only a public opening packet. Loading a recording is a separate explicit action. Neither starts playback, speech or a backend request automatically.
- Public packets strip extra properties. NPC dialogue, cast and monitors never receive a recording, debrief, hidden role or case-answer object.
- Questions, evidence requests and finding submission retain the existing validated API commands. Recorded sessions are read-only. A historical score is never attached to newly started practice.
- Live backend calls require an explicit connection from a loopback page. The guard checks every request and closes immediately on disconnect; only relative same-origin API paths are permitted. Development remains limited to the free local fake-model stack.

## Recordings and audio

The preferred “Recorded coached interview · Gemini” action loads a byte-identical saved run from the brief's existing recording. The neutral runtime fixture is `src/fixtures/recordings/F01-coached.json`, SHA-256 `bbd56ed3005fe5911d1972b5b7a78a94e78fa30323ce0b07d7087b50837ee1cb`. Its own public case is `C-H3N8RW5B`. Its original score and referee provenance appear only at its published debrief and hide again on rewind. The secondary example is explicitly labeled as hand-built. Both are validated with the unchanged compiled wire validators.

Loading or replacing a recording resets its cursor to zero, pauses it, turns sound off and cancels stale asynchronous loads. All recording controls retain the original playback cursor and speed logic.

Offline read-aloud is optional synthesized speech, not recorded speech. It requires an installed English voice whose browser `localService` flag is true. Availability is checked at opt-in and immediately before every utterance. Missing or remote-only voices produce a visible error and silence, never a default-voice fallback. The shared `/session` speech engine is unchanged. The precinct keeps subject speech and coach earpiece off by default. Voice sessions retain their separate microphone/provider/transcript consent; leaving an audio room or globally pausing stops microphone capture without automatically reconnecting later.

V1 does not contain original audio, world movement or notebook events. None of these are invented from transcript text. The separate v2 world replay work must capture actual available presentation inputs and disclose absent channels.

## Verification

The integrated slice-three complete unchanged `pnpm check` passed lint, TypeScript, 99 files / 1,626 tests in both ordinary and coverage runs, all coverage floors and production build. This supersedes the earlier isolated package's timeout/retry result. The real-fixture validation, score-publication gates, late-load replacement, local-only voice and explicit-action tests are included in that combined run. Actual slice-three WebGL acceptance passes 38/38 checks with ten visually inspected screenshots. Detailed counts, the cloud-stall retry history and the unpublished local checkpoint boundary are recorded in `slice-03-check.json` and `NOTES.md`. Interview-station and original-audio acceptance remain separate later-slice work.
