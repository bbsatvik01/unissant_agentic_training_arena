# Attributions: web/

Code lifted into `web/` from the owner's reference repositories (read-only, D-002; lift rules in S5 section 2 and S6 section 13). Each entry names the source path, the commit, the sha256 of the source file at that commit, and what changed. Hashes were taken on 2026-10-08; every source file was committed and unmodified in its repository at the time.

Repository roots:

- TechnoMile: `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat`
- gokbase: `/Users/balla/Desktop/satvik/gokbase-org`. The gokbase files below are byte-identical in `recruiter-frontend/` (last changed in commit `8379d22`) and `frontend/` (commit `0371855`, the commit S5 section 2 cites); the copies were taken from `recruiter-frontend/`, as S6 section 13 names.

## Lifted files

### `src/lib/sse/ticketed-stream.ts` (S5 T20, S6 13)

| Field | Value |
| --- | --- |
| Source | TechnoMile `web/src/lib/sse/ticketed-stream.ts`, lines 1-206 (itself lifted from gokbase `frontend/src/lib/sse/ticketed-stream.ts` with a resume fix) |
| Commit | `183deb0` (the file's last change; repository HEAD was `a18ad9f` when read) |
| sha256 | `7673fcab90ad62931f3ad1c11743575771ef37bd3fe4e36f8a8f275bc2038d69` |
| Verdict | Lift, with one behaviour change required by S6 FE-SSE-1 |

What changed:

- `onMessage` may return `{ cursor }` (new `MessageVerdict` type): progress, with the resume cursor set to the value the caller names. The donor read the cursor from `MessageEvent.lastEventId`, which browsers keep from the last `id:` line seen; a frame sent without an id (the arena's synthesized frames) therefore arrives carrying the previous frame's id, even when the caller rejected that frame, and the cursor would skip it. The donor's `true` verdict is kept unchanged for streams whose every frame carries an id.
- Only the newest connection attempt may take effect: every attempt starts a generation, and a ticket mint that settles after a newer attempt started (or after `close()` or `finish()`) opens nothing and schedules no retry. The donor let a `reconnect()` during a pending mint open two EventSources, the first orphaned with live handlers. A retry timer also belongs to its generation and is registered before `onRetry` runs, so a `reconnect()` made from that callback cancels it (the donor registered it after the callback, and the stale timer closed the new connection).
- Lint-driven rewrites under typescript-eslint strict type-checked, behaviour unchanged: `void` removed from the verdict union; the redundant `as unknown as` casts on `new EventSource()` and `setTimeout()` removed; braces around the default `clearTimeout` callback; the "stopped or finished" checks read through functions, because a plain re-check after `await resolveUrl()` reads as already narrowed to the type checker while `close()`, `finish()` and `reconnect()` can change state during that await.
- Header comment re-pointed to the arena spec (S5 6.3).

### `src/lib/sse/ticketed-stream.test.ts` (S6 13, FE-SSE-1)

| Field | Value |
| --- | --- |
| Source | TechnoMile `web/src/lib/sse/ticketed-stream.test.ts`, all 13 tests |
| Commit | `183deb0` |
| sha256 | `ff4a545d3d77e6ad259e97d05710d51acdf61879a5ebb9a8e0a0adb9e4f1614a` |
| Verdict | Lift, plus additions |

What changed:

- The 13 donor tests are kept with their assertions unchanged. Lint-driven syntax only: the harness's `async` `resolveUrl` callbacks without `await` return `Promise.resolve` or `Promise.reject` instead (same settled values); a number in a template literal is wrapped in `String()`; two void-returning arrow callbacks gained braces.
- Added: explicit-cursor verdicts; the trial stream's FE-SSE-1 cases (first retry at 250 ms and the full `[250, 1000, 2000, 4000, 8000]` schedule; `after=` carrying the last accepted seq; a rejected frame, a synthesized frame with a sticky id, and a replayed duplicate never moving the cursor; a snapshot-only stream reaching give-up); FE-SSE-6 drops (malformed, foreign, ill-typed, and the 16 KB UTF-8 boundary); shutdown paths (cancelling a pending retry, a timer that fires after `close()`, a mint that fails after `close()`); overlapping attempts (a `reconnect()` during a pending mint, in both completion orders; a superseded mint that fails; a `reconnect()` from inside `onRetry`; a superseded retry timer the scheduler failed to cancel); the default timers and the default `EventSource` factory; the trial-stream handle.

### `src/lib/voice/voiceMachine.ts` (S5 G9, S6 6.2 and 13)

| Field | Value |
| --- | --- |
| Source | gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/voiceMachine.ts`, lines 1-234 |
| Commit | `8379d22` (identical at `frontend/` `0371855`) |
| sha256 | `49fa6832843b65e6b245685ba3b29204fa7bf4c4a1c8be77070065647a645b40` |
| Verdict | Adapt |

Kept: the pure reducer shape; the terminal `ended` state that absorbs every later event (and returns the same object); the frame whitelist with unknown frames ignored; the event union with no cost variant; caption fragments merged by role; the `timer_tick` floor and the `warning` banner.

What changed (S6 6.2; S5 7.3-7.5 at spec v2.5; D7, D-016; UI direction v2.1 section 3):

- States `idle, consent, connecting, listening, recording, thinking, speaking, draining, ended`. gokbase `tool-lookup` became `thinking`. The consent gate precedes the microphone (`connect` only from `consent`). `recording` exists only under push-to-talk. `draining` follows a 4410 close while audio is audible: capture stops, the received audio plays, and the audio layer's drained report ends the session.
- `status` is derived after every event from the connection, server activity, the talk control and actual playback. The investigator's turn ending comes from capture edges (`investigator_audio`, `investigator_silence`, push-to-talk press and release), never from captions. A playback report for audio flushed by `interrupted` is ignored as stale.
- Frames are the S5 7.3 set, validated field by field: `utterance_start`, `utterance_end`, `interrupted`, `transcription`, `exchange {exchange_no, lines[{role, text, partial}]}` (role-tagged lines in arrival order, each at most 900 code points, no pairing, SG3-41), `exchange_count`, `timer_tick`, `warning`. The donor's `ended` frame and the earlier `turn_committed`, `resume` and `connection_lost_resume` are ignored as unknown: the close code alone ends the session (SG4-32).
- Voice is display-only and unscored: the stored `exchange` frame is the transcript (`transcript`, replaced by number); live captions are kept in arrival order, merged per speaker, never paired, and replaced by the next `exchange`. The earlier question and answer pairing by count was removed with the protocol that needed it.
- No resumption: every close is terminal. Codes outside S5 7.5's table (1006, 1011, the withdrawn 4429 and 4503) end with key `transport`, and `reconnectState` opens a new session carrying only the stored transcript and the trial-level exchange count (the 12 cap is per trial).
- Added pure helpers: `voiceBarState`, `talkLevel` and `inputLevel` (0 under reduced motion or the pause control; the amplitude is 0 the moment playback stops), `audioUtterance`, and `controlFrame` over `VoiceControl` (`stop` and `interrupt` only: playback progress stays in the browser, D7).

### `src/lib/voice/voiceMachine.test.ts` (S6 FE-VOICE-1..3, 6..8)

| Field | Value |
| --- | --- |
| Source | gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/__tests__/voiceMachine.test.ts` |
| Commit | `8379d22` (identical at `frontend/` `0371855`) |
| sha256 | `b5aa417de10b11fcd7e48f7d08ae27e671938e13d06c5e895e023974d686e4a0` |
| Verdict | Adapt |

What changed: re-targeted to the arena's codes, frames and states. Kept in form: the close-code table, frame dispatch and ignore cases (including the cost-shaped frame), transitions, fragment merging, the ended-absorbs and never-mutates checks. Added (spec v2.5): a reducer table over every (state, event) pair (FE-VOICE-1), the close-code table (FE-VOICE-2), the 4410 draining sequence (FE-VOICE-7), unpaired captions and the stored exchange (FE-VOICE-3, 8), the voice-bar table (FE-VOICE-6), reconnect-as-new-session, playback and amplitude cases.

### `src/lib/companion/fsm.ts` (S6 6.3 and 13; C-38d)

| Field | Value |
| --- | --- |
| Source | gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/kin/fsm.ts`, lines 25-122 |
| Commit | `8379d22` (identical at `frontend/` `0371855`) |
| sha256 | `e9babc750b65e510a57ebf62420ca8fededd79578a4e354e0c70df421146fb88` |
| Verdict | Adapt |

Kept: the pure `petStateFor(input)`, the precedence of one-shot windows over the status table, `SLEEP_AFTER_MS = 45000` and `ONE_SHOT_MS = 1600`, and the collapse of animation to a still pose under reduced motion or mobile.

What changed:

- Poses are the arena's (`idle, listening, thinking, noticing, encouraging, celebrating, sleeping`); dropped `approach`, `talk-sync`, `point`, `greet`, `error`, `farewell` and the dragging input. The result is `{ state, motion }`; under reduced motion, mobile or the pause control the same pose is shown `still` (the donor swapped bursts for other poses).
- Input is the S6 6.3 list. Assessment mode and an ended session give `sleeping`; `listening` only while a question can be asked (S6 6.1).
- Added `encourages(question)` (card.v1 question block only), `cardSignals` (at least one flag, plus `encourages`), and a pure one-shot tracker (`startOneShots`, `trackOneShots`, `activeOneShot`, `oneShotEndsAt`): newest one-shot wins, `noticing` over `encouraging` over `celebrating`, one celebration per session, no signal in assessment, no replay of history. The donor ran these windows as timers inside `KinLayer.tsx`.

### `src/lib/companion/fsm.test.ts` (S6 FE-PET-1..3, 6)

| Field | Value |
| --- | --- |
| Source | gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/kin/__tests__/fsm.test.ts` |
| Commit | `8379d22` (identical at `frontend/` `0371855`) |
| sha256 | `4198110393b0598551457286853a4a0337ae505ddeb26853dd07095272ae3871` |
| Verdict | Adapt |

What changed: re-targeted to the arena table. Kept in form: the `base()` input builder, status-to-pose rows, precedence and suppression checks. Added: an exhaustive sweep over every status, mode, signal and motion combination; `encourages()` and `cardSignals` tables; FE-PET-2 type tests (`expectTypeOf` on the exact input and parameter types, so any added field fails `tsc`); one-shot tracker cases; FE-PET-3 session sequences.

### `src/lib/companion/registry.ts` (S6 6.3 and 13)

| Field | Value |
| --- | --- |
| Source | gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/kin/registry.ts`, lines 17-26 (pet props) and 108-137 (lazy loaders) |
| Commit | `8379d22` (identical at `frontend/` `0371855`) |
| sha256 | `7441e54a087958f87d897bc00408a5547d183975027fec04b1559758b8b24607` |
| Verdict | Adapt (stub) |

What changed: the cast is one unstyled development placeholder (`src/components/companion/pets/placeholder.tsx`, not shipped) until DESIGN.md names the companion (OD-4, OD-5); props are `{ state, motion, size }`; the `as unknown as` cast on the loader map is gone; `isCompanionCharacter` refuses any unknown or prototype key. Not lifted yet: the gokbase cast and art (recruiting brand, S6 13 "avoid"), display names, captions, slug styles and `poseStyle` (visual decisions that wait for DESIGN.md).

## Patterns adapted (no code copied)

| Target | Source | sha256 | Use |
| --- | --- | --- | --- |
| `vitest.config.ts` | TechnoMile `web/vitest.config.ts` (commit `08aa301`) | `d9d32e4f092f9529898f05eeb2f0b36a237d9e225cc15908ab4993bf9125f728` | Coverage on `src/lib/**` with 90% lines, branches, functions and statements (S6 12) |
| `pnpm-workspace.yaml` | TechnoMile `web/pnpm-workspace.yaml` (commit `d615209`) | `1d7591a72c3b56fa910efe22bf899e81a31f2db54bd9531f74a78380d22658a0` | Release cooldown (14 days here, S6 1.2), strict mode, trust policy, version-specific exceptions with reasons, including the same verified `semver@6.3.1` trust exclusion |
| `src/lib/sse/trial-stream.ts` (`MAX_EVENT_BYTES`) | TechnoMile `web/src/lib/contracts/run-events.ts`, line 11 (commit `c10c19a`) | `4e0d79b3bdfb466e299b157d5b0e292d5796bfd52b2584c543f7db60852a99c9` | The 16 KB event cap (S6 5.2), measured here in UTF-8 bytes rather than UTF-16 code units |

## New code (no source)

`src/lib/sse/trial-stream.ts` (trial stream on top of the lifted client), `tools/dependency-exceptions.test.ts` with `dependency-exceptions.json` (the enforced exception register), `tools/vite-proxy.test.ts` (the dev proxy against a real upstream: Host rewritten for HTTP and the WebSocket upgrade, Origin preserved, S5 10.3), `src/lib/contracts/card.ts` (the card.v1 question block, mirrored from S2 4.1 until WP-02 generates contract types), `src/lib/copy/ex4.ts`, and the scaffold (`src/main.tsx`, `src/router.tsx`, `src/routes/placeholder.tsx`, configuration files).
