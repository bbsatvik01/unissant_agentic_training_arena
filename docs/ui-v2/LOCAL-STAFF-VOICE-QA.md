# Local staff voice QA and handoff

Task: https://github.com/bbsatvik01/unissant_agentic_training_arena/issues/16

## Implemented and checked

- Rootless official Debian eSpeak NG 1.52.0+dfsg-5, exact matching data/runtime and support packages. Signed InRelease/index/package-hash verification is retained in authoring provenance. No bundled binary/model/data runtime, installation or dependency/lockfile change.
- The documented ESPEAK_DATA_PATH override resolves the initial default-path voice-list warning. The actual rootless data path and version are verified, all linked libraries resolve, and native English formant definitions were inspected. No Flite/MBROLA/recorded-person model is selected.
- 23 original exact authored WAVs: 10,272,010 total bytes, 232.90244897959184 combined seconds, mono PCM16 at 22,050 Hz. Durations 5.459–16.158 s; largest WAV 712,616 bytes; every deliverable file is below 5 MiB. RMS 0.108405–0.129124, peak 0.945496–0.999359. Full texts, settings, sizes, hashes, durations and signal measurements are in the generated manifest.
- Initial receptionist-welcome SHA-256 stays `145dfac48f664abdf4a3d672565ae8585cbd8164190b8502afb55cfe6244228a`. This is mathematical/nonzero-signal verification, not a human listening judgment.
- Real GLB JSON source inspection confirms every required vowel/sibilant/jaw morph exists on both Business_Female_01 and Business_Male_04. Source evidence: LOCAL-STAFF-VOICE-MORPH-SOURCE.json. Actual rendered movement remains a separate browser check.
- New player tests check exact static clip coverage, unsupported/personalized lines, no mount autoplay, source→gain→analyser→output, spectrum-only mouth weights, mute/unmute, stale fetch/decode cancellation, second-speaker replacement, blocked/rejected audio and context cleanup.
- Microphone ownership regressions cover failure of either context constructor, either worklet module/resume, source, analyser, worklet, gain or connection creation; idempotent track/context release, capture-only stop, post-close play/flush guards and cleanup errors. All media/audio devices in these unit tests are mocks, never a physical microphone.
- Existing Canvas transitions are tested: ordinary dialogs remain demand-rendered; actual unmuted staff playback requests existing continuous frames; stop/mute requests a final closed-mouth frame before returning to demand. Actual pause, reduced motion and body-only replay do not request staff mouth animation. Frozen body/replay V1 files are unchanged.

## Commands and observed results

QA ran sequentially with the parent's sole-CPU grant under Node 24.21.0, in `/workspace/shared/precinct-local-voice-qa/web`. The QA tree overlays the read-only exact bbsatvik01 repository, slice-five integration source, then this package. Dependencies are read-only links; build-info and tool caches are QA-local. The genuine checkout and shared integration trees were never edited by this worker.

1. Initial 6-file new-feature set: 34/34 passed in 14.05 s.
2. Expanded 12-file set: 67/69 passed in 52.01 s. Two old ReceptionBriefingPanel expectations referred to the replaced device-voice button/copy. They were updated to the actual finite-clip button, truthful no-model label and unavailable-output message while preserving exact-subtitle, privacy, invalid-name and navigation assertions.
3. Corrected ReceptionBriefingPanel: 10/10 passed in 10.27 s. Thus all 69 unique scoped tests pass across the expanded run and targeted rerun.
4. After making the extracted subscription callback an arrow function, store/Canvas transition tests passed again: 4/4 in 7.48 s.
5. Strict whole-QA-tree `tsc -b`: passed on the final source. This includes strict generated-contract consumer checks without modifying any generated contracts.
6. Scoped ESLint `--max-warnings 0` over 19 modified/new TS/TSX files: passed, exit 0 with zero warnings. Earlier closure-narrowing and extracted-method warnings were fixed without suppressions.

Logs: LOCAL-STAFF-VOICE-TESTS.txt retains the initial expanded failures for transparency; LOCAL-STAFF-VOICE-REGRESSION-RETRY.txt and LOCAL-STAFF-VOICE-FRAME-RETRY.txt record corrected passes. TYPES and LINT logs are empty on clean success; completion status is recorded in the final staging manifest and parent handoff.

## Not yet verified

- No browser, microphone, build, coverage or aggregate `pnpm check` was run in this slot.
- No independent listening/pronunciation/naturalness approval: this model/tool route cannot consume audio input. Voices are expressly synthetic/formant and should not be presented as natural AI conversation.
- Final merged world integration, actual decoded browser analyser variation, actual avatar mouth movement/silent closure, user-visible lips behind staff dialogs, repeated clicks, audio output device/autoplay handling and visual pause/reduced-motion transitions need browser QA.
- The user's actual microphone, offline speech recognition, live conversation, model intelligence, coaching, scoring and original audio replay are outside this package. Local staff playback captures no microphone and saves no conversation/audio.
- Personalized greetings and dynamic lines without an exact generated clip remain subtitle-only in this player. Dynamic public-briefing device read-aloud retains its separate existing behavior.

## Integration checklist

Copy only owned files from the final staging manifest. Apply the five narrow integration/test/attribution patches, preserving captions, replay and any later scene ownership. Full staged copies of patch-owned files are references, not permission to overwrite newer files. Preserve synthetic/fixed-dialogue labels and exact full subtitles. Re-run relevant checks after final merges, then use a separate authorized browser slot for actual output/analyser/morph observations.
