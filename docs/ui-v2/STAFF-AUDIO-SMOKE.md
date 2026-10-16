# Native staff-audio browser smoke harness

Status: SOURCE ONLY. The script has not been parsed, typechecked, linted or executed. No browser, microphone, sound capture or QA process was launched while another worker owns the CPU lane. A passing result is not claimed.

Owned file: `web/tools/precinct-staff-audio-smoke.ts`. Copy this new file into the combined QA candidate's `web/tools/`; it does not alter production sources, generated audio, the frozen voice/crowd packages, dependency manifests or the genuine repository. Existing Node 24.21.0 and `@playwright/test` dependencies suffice. The script expects the finalized 23-clip manifest adjacent at `web/src/lib/precinct/localStaffVoiceManifest.json` and actual finite WAVs in the preview. No backend/mock server is started or required.

## Future execution, only after the explicit CPU/browser grant

First run strict TypeScript and scoped zero-warning lint on the combined candidate, including this script. Correct any source issues in an owned follow-on package before claiming it is ready. Start the reviewed combined Vite preview through its existing authorized workflow. From its `web` directory:

```
ARENA_PREVIEW_URL=http://127.0.0.1:5173/ \
ARENA_STAFF_AUDIO_OUTPUT=/tmp/arena-staff-audio-reviewed-run \
node tools/precinct-staff-audio-smoke.ts --allow-local-staff-audio
```

`ARENA_CHROMIUM_PATH` optionally chooses an already-approved installed browser (default `/usr/bin/chromium`). The preview URL must be credential-free loopback HTTP without query/hash. The new browser context has no permissions, no imported storage, blocked service workers, low graphics quality and its own explicit reduced-motion setting. It uses software WebGL/SwiftShader and makes no hardware-performance claim. There is no autoplay-bypass flag. Audio starts only through native Playwright clicks on the shipping staff play button.

The actual sequence is Enter → Digit1/E → Talk to reception officer → explicit play; later Digit5/E → Talk to training sergeant → explicit play. Each exact visible subtitle must have a matching actor-specific manifest entry. The harness uses actual UI setting changes for reduced motion, actual close/stop/mute buttons, and closes the modal before using Escape to pause exploration. It does not force-click through modal inertness or mutate internal application state.

## What it observes

A closure-held Playwright JSHandle temporarily wraps native Web Audio creation/connect/disconnect/start/stop methods without replacing returned nodes, buffers, output, gain settings, callbacks or schedulers. The wrapper invokes the original method with its original receiver and arguments and returns its native result. Native ended events are observed with an additional listener. Descriptors/listeners are restored in reverse order in `finally`; an unexpected competing wrapper fails visibly. No persistent debug global, extra Canvas/renderer, page timer or RAF is introduced.

The recorded native source→gain→analyser→destination edges establish that time-domain RMS/peak comes from the application's actual post-gain analyser. The original decoded source buffer's actual mono PCM, sample rate and duration are also recorded. Browser resampling may change decoded sample rate; exact HTTP response SHA-256/byte count and duration are checked against the original 22,050 Hz file manifest.

The harness captures the exact already-loaded Vite `@react-three_fiber.js` dependency URL, dynamically imports that same cached module, and reads its existing `_roots` entry. A missing/duplicate registry fails closed. It reads the actual scene's staff morph values and body-bone/root transforms without calling `audioMouth.weightsFor` or changing smoothing state. This is a pinned development inspection seam, not a production debug API. A production-bundled site without that seam is intentionally not accepted by this harness.

External-runner sampling records timestamps and real values; it does not add an application frame loop. Numeric thresholds and every sampled phase are saved. Two or more nonzero real-output samples and changing real morph influences are required during normal playback. The paused-dialog body must stay exactly unchanged. Mute must leave a still-active native source with zero gain/post-gain signal, closed mouth and demand rendering; unmute must restore real signal/morphs. Stop and panel-close must close all observed contexts and mouths. Reduced motion must retain actual native output while mouths stay closed and the dialog Canvas remains demand-rendered. Both reception and sergeant are exercised.

All same-origin WAV responses are checked against the finite manifest. All external origins, all backend API routes, unexpected audio paths, microphone/display acquisition, speech synthesis and HTML media playback are blocked and recorded as failures if attempted. Native Web Audio is deliberately allowed. The staff test expects zero blocked/requested microphone or external-audio actions, not a faked permission result. No physical microphone test is included.

## Output and limits

The default output directory is a new `/tmp/arena-staff-audio-...` folder. It contains `staff-audio-report.json`, actual screenshots and a Playwright WebM. The process has a 240-second overall browser watchdog, 90-second initial readiness bound and short bounded observation windows. A missed scenario, source/morph mismatch, denied call, asset error or cleanup anomaly produces a non-success result and nonzero process exit code. Screenshots during a dialog may not reveal the face visually; they prove UI state, while the measured existing mesh values prove the morph observations. Do not hide UI or invent frames to improve evidence.

The WebM is SILENT. `videoHasCapturedAudio` is explicitly false. The source graph and analyser prove a rendered audio signal in this test browser; they do not prove audible hardware-speaker output, listener comprehension, pronunciation quality or natural conversational voice. No waveform is muxed into the video and described as browser-captured sound. A sound-bearing demonstration needs a separately approved real output-loopback capture workflow. This model/tool route cannot independently listen.

This bounded smoke covers requested normal output/mute/stop/close/two-actor/reduced-motion behavior. It is not coverage of every fault path, simultaneous installed-device synthesis, natural completion, genuine microphone acquisition, recorded interview replay, full aggregate tests or a performance benchmark. Existing unit regressions and the fuller frozen voice browser proposal remain relevant.
