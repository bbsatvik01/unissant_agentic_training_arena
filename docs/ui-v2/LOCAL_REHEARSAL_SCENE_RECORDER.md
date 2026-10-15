# Actual local rehearsal scene with sound

This is a separate QA-only tool delta for issue 18. It records the **actual rendered precinct canvas
and actual page-owned Web Audio output together** in one browser MediaRecorder WebM. It never
stitches TTS files, generates replacement narration, fabricates scene frames, requests microphone or
display permission, or captures system/user audio. The existing full-page Playwright walkthrough
remains a separate silent artifact. This recording is **scene only**: DOM controls/subtitles are not
part of `canvas.captureStream` and must not be described as a full-page recording.

All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.

## Dependencies and launch

Requires the separately staged `--local-tts` mock adapter, existing original scene/assets, installed
pinned dependencies, `/usr/bin/chromium`, and an already-running Vite preview pointing its API proxy
at this tool's owned mock port. No package installation, dependency mutation, paid service or backend
change. Run only after the shared CPU/browser lane is explicitly granted.

```sh
# From the authorized merged QA mirror's web/. Its existing Vite must proxy to 127.0.0.1:8084.
NODE=/workspace/shared/unissant_agentic_training_arena/web/node_modules/node/bin/node
ARENA_PREVIEW_URL=http://127.0.0.1:5173/ ARENA_MOCK_PORT=8084 \
  ARENA_SCENE_OUTPUT=/workspace/shared/precinct-rehearsal-recorder-next/results/browser \
  "$NODE" tools/precinct-rehearsal-recorder.ts --record-local-rehearsal
```

`ARENA_SCENE_OUTPUT` may choose an output directory; default is an owned temporary directory.
Only credential-free loopback preview URLs are accepted. An occupied mock port fails rather than
reusing or terminating another process. The recorder starts no Vite process and closes only its
own browser/context/mock. It uses a disposable browser context, no saved profile, no permissions,
no service workers, and refuses outbound requests/voice WebSockets/microphone/display capture and
browser speech fallback. Native local Web Audio is intentionally allowed.

## Honest flow and evidence

The tool clicks real application controls: connect the local fixture, acknowledge the ground rule,
select the case, acknowledge the briefing, call the subject, start text practice, enable local
backend read-aloud, sit at the table, open Interview controls, enter a neutral question and Send.
The question is “Which record could independently corroborate that account?” The response is the
existing first fixed authored subject beat with its original scripted disclaimer.

The audio tee is installed before any room AudioContext is created. Original audio destinations,
arguments and return values remain intact. A new analyser and MediaStreamAudioDestinationNode
observe only the signal actually reaching this page's own destination. Exactly one context is
required; ambiguous mixing fails. Canvas video and that actual audio track enter a single native
MediaRecorder, preserving real playback timing, pauses and cancellations. Recording is capped at
50 seconds, 16 MiB, and 520 observational samples; bitrate is bounded. Setup time is separate from
the 50-second recording window. No additional animation/frame loop is created.

A closure-owned QA handle uses a literal import of the existing pinned R3F, resolved by an
import map to the exact already-loaded same-origin Vite URL including its query. Conflicting maps
are refused. It verifies that the root map owns the actual canvas, then only reads the renderer's
frame counter and actual Jordan Pell speech morphs. No runtime/debug globals, scene writes,
additional modules, fabricated poses or extra rendering loops are introduced.

A pass requires:

- Two actual native AudioBufferSource starts and completions, with no fallback synthesis
- HTTP 200 for the exact investigator question and exact first authored response
- Real nonzero destination signal, changing renderer frames, a live non-lost WebGL scene
- Nonzero actual subject speech morphs while the second source produces nonzero signal
- Native WebM audio/video bytes, no timeout, no outbound or microphone/display request
- A separate full-page still with the exact live subject caption, with the actual second audio source active before and after the screenshot
- A full-page transcript/UI still containing the submitted question and full authored reply
- Closed recorder/tracks/tee/context, restored probes, closed browser and owned mock

Outputs: `actual-rehearsal-scene-with-audio.webm`, `actual-live-subject-caption.png`,
`actual-interview-transcript.png`, `actual-scene.png`, and a JSON report with timestamps, audio signal
samples, actual render/morph samples, exact synthetic TTS requests, duration, byte count, SHA-256
and cleanup status. Screenshot hashes and observed caption text/audio source state are recorded.
The stills show the actual full-page DOM; they are not composited into the scene-only video. These checks prove captured browser output,
not physical-speaker playback, human listening approval or a hardware frame-rate benchmark.
Inspect and listen to the resulting video before final delivery; codec availability and visual
quality remain browser-dependent.

## Verification status

The recorder before the full-page evidence addition passed strict tools TypeScript and zero-warning
lint on 2026-10-15. The small caption/transcript screenshot addition awaits the next granted strict
check and browser lane. The dependent local TTS
adapter passed 36 focused tests and 13 actual native/API WAV clips plus abort/shutdown.
This recorder has not run in a browser; no media artifact or visual/playback pass is claimed yet.
No opaque/generated import, eval, extra renderer, hidden data, live AI or numeric assessment is used.
