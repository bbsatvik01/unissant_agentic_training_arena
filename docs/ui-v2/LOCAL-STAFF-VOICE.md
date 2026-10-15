# Bounded local scripted staff voice

Status: all 23 genuine WAVs generated and mathematically verified. All 69 unique focused tests, strict TypeScript and scoped zero-warning lint passed. Real-browser analyser/morph observation and human listening quality remain unverified. Track: https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/16 .

## Scope and user experience

- 23 exact original authored lines: reception and sergeant introductions, first/returning unnamed greetings, topic replies and neutral redirects.
- Explicit “Play scripted staff voice” only. No autoplay, microphone, recognizer, model, cloud TTS, per-request API charge, conversation storage or backend change.
- Wording remains “fixed local dialogue” and “synthetic voice”. These formant voices are deliberately robotic and are not natural AI conversation.
- Full existing subtitle stays visible verbatim. An unknown, personalized or changed line is unavailable, never paired with approximate speech. Dynamic public briefings retain the separate pre-existing installed-device read-aloud option; that is not proof of a bundled audio clip.
- One local speaker at a time, including the existing installed-device controls through their shared ownership event. Click Stop, replace the reply, open another staff member, close the panel or leave the route to stop. Layout cleanup cancels pending fetch/decode and closes the AudioContext.
- Mute immediately detaches mouth data, and gain precedes the analyser. Actual analysed output drives mouth morphs in the existing staff frame callback. No text timing or truth/deception inputs. This is spectral audio-reactive lip motion, not phoneme alignment.
- A boolean audio-playback subscription enables the existing Canvas frame loop only for actually started, unmuted staff clips when motion is permitted. Stop/mute/pause/reduced motion invalidates a final existing-Canvas frame before demand rendering resumes. No second animation loop is introduced.
- Body animation remains frozen behind panels. A separate `speechPaused` presentation prop permits explicit speech lips behind a dialog while actual pause, reduced motion and body-only recorded replay keep them closed. No new renderer, motion version or clock.
- Asset GETs are same-origin, credential-free and disallow redirects. Bytes are bounded by the manifest and SHA-256 verified before decoding. No audio provider is called.

## Integration ownership

Copy only these owned files, once generated and validated:
- `web/src/lib/api/localStaffAudio.ts` and test
- `web/src/lib/precinct/localStaffVoice.ts`, test and generated `localStaffVoiceManifest.json`
- `web/src/lib/precinct/localStaffPlaybackActivity.ts` and test
- `web/src/components/precinct/LocalStaffSpeech.tsx`, test, `staffAudioMouth.ts` and test
- `web/src/components/precinct/StaffSpeechFrameInvalidation.tsx` and `PrecinctCanvas.staffSpeech.test.tsx`
- `web/src/routes/world/voiceAudio.ts` and test
- `web/tools/generate-local-staff-voice.py` and `local-staff-assets.test.ts`
- `web/public/audio/staff-v1/*.wav`
- `assets-src/local-staff-voice/*`
- this document and associated provenance/QA report

Apply the narrow patches in `patches/` against the final integration tree, preserving other owners:
1. ReceptionBriefingPanel imports/uses LocalStaffSpeech only for the authored NPC reply. Full inline subtitle stays unchanged. Removes “no network” from its label because static asset delivery can use same-origin networking.
2. PrecinctStaff adds audio mouth application after its existing frozen V1 body application. No frozen V1 source edits.
3. PrecinctCanvas passes actual pause separately from its dialog/exploration body pause and subscribes to actual non-muted staff playback for its existing frame-loop mode.
4. ReceptionBriefingPanel tests update the old device-voice button/message and no-network assertion to the truthful finite-clip behavior; exact subtitles, invalid-name rejection, public/case isolation and no-auto-navigation checks remain.
5. Apply the narrow ATTRIBUTIONS patch, preserving later unrelated attribution additions.

The full staged versions of these integration files are patch references only. Do not overwrite newer route/scene ownership changes with them. Caption package requires no changes: its native interview/live captions are separate, and the staff dialog already displays the complete exact subtitle. Staff lips/audio are not added to recorded body replay, whose limitations must remain explicit.

## Microphone acquisition fix

`openVoiceAudio` now owns the MediaStream immediately after acquisition. Every constructor, worklet-module, resume, source/node or connection failure stops every track, disconnects partial graphs, detaches/closes worklet ports, and closes all created contexts before rethrowing the original setup error. Capture can stop independently while playback continues. Stop/close are idempotent, stale callbacks are gated, and play/flush after close do nothing. Existing consent and backend transports are unchanged. No microphone is opened by the new staff feature.

## Tool provenance and regeneration

Only official Debian trixie native-formant eSpeak NG 1.52.0+dfsg-5 is selected. The rootless tool lives outside this source package at `/workspace/shared/creative-tools/espeak-ng/root`. No package manager install, system setting, dependency lock, application linkage or bundled generator binary/data changes were made.

The exact package records are in `assets-src/local-staff-voice/DEBIAN-PACKAGES.json`. SHA-256 hashes were checked against the official amd64 Packages index whose SHA-256 is authenticated by Debian's signed InRelease, verified with the installed Debian archive keyring. Support libraries libpcaudio0 and libsonic0 were extracted alongside the executable; libc/ALSA/Pulse are host libraries. All runtime libraries resolved through `ldd`. eSpeak reports version 1.52.0. The first voice listing emitted a default-path warning; setting the official documented `ESPEAK_DATA_PATH` to the same explicit rootless data parent fixed it. The subsequent full batch and voice listing succeeded cleanly.

For regeneration, obtain an exclusive CPU slot and run the original preview and full batch:

```
python web/tools/generate-local-staff-voice.py --tool-root /workspace/shared/creative-tools/espeak-ng/root --only receptionist-welcome
python web/tools/generate-local-staff-voice.py --tool-root /workspace/shared/creative-tools/espeak-ng/root
```

The source inventory is original dialogue in `assets-src/local-staff-voice/dialogue.json`. The script uses fixed argv, strict native `en-us`/`en-gb` choices, bounded original text, subprocess timeouts, one sequential synthesis job, a <5 MiB per-WAV cap, <60 s duration and nonzero PCM checks. It records exact subtitle, settings, sample rate/duration, SHA-256, bytes and PCM measurements. No MBROLA, Flite, neural or recorded-person voice is selected. Parameters vary two fictional synthetic voices; they are not imitations of named people.

Retain the Debian eSpeak copyright notice and GPL-3.0 text alongside provenance. eSpeak is a separate GPL-3.0-or-later authoring tool, not shipped or linked into the browser. GPL output coverage depends on the output contents; this is not blanket legal clearance or approval to redistribute its binaries/data. Any future generator redistribution needs its own compliance review.

## Acceptance and remaining limitations

Generation passed: 23 mono PCM16 22,050 Hz WAVs, 10,272,010 total bytes, 232.90245 seconds combined; largest clip 712,616 bytes. All hashes, nonzero PCM, duration and exact inventory checks pass. Focused checks and final status are listed in LOCAL-STAFF-VOICE-QA.md. No build, coverage, browser or microphone run was authorized in this slot. This model/tool route cannot listen to audio, so no independent pronunciation or perceived-quality approval is claimed. Completed authoring checks include generator version/native voices, runtime dependencies and exact WAV hashes/nonzero PCM. Required remaining QA: audible sample, true decoded browser analyser variation, mouth morph variation and silence, one-speaker/Stop/mute/replay, pending fetch/decode cancellation, missing/corrupt assets, panel close/room leave, actual pause/reduced motion, and microphone setup-failure cleanup. A fake test microphone does not prove access to the user's physical microphone.

Offline listening/transcription remains unavailable. A future bounded option is Vosk small English (official model list: Apache-2.0, roughly 40 MB model), or whisper.cpp tiny/base with separately verified model licensing and measured CPU latency. Neither is installed or integrated here. First prove editable transcription of fresh utterances, silence/noise handling and separate explicit submission; recognition alone is not an NPC dialogue model or evaluator.

Primary recognizer references (research only): https://alphacephei.com/vosk/models and https://github.com/ggml-org/whisper.cpp . Recognition and dialogue-model work are outside this package.

Browser acceptance is specified in `LOCAL-STAFF-VOICE-BROWSER-PROPOSAL.md`. It is an unexecuted source-reviewed proposal, including the exact UI sequence, temporary real-node/morph observation, and the distinction between a silent browser video and actual output-loopback audio.
