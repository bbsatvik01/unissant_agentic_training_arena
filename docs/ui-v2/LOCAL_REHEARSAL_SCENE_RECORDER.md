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
select the unique article headed “Local scripted fixture: Records vault entry during a busy shift”
using its actual available “Select case” button, acknowledge the briefing, call the subject, start text practice, enable local
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
- Three distinct rendered quiet-baseline frames before Send, with all seven actual speech-morph values near zero
- At least five distinct rendered subject frames with actual signal above RMS 0.0001, including at least two consecutive observed frame-pair changes of 0.01 or more in an actual named speech morph
- Three advancing settled frames after native source 2 ends, with all speech morphs at or below 0.00001 and quiet output; bounded by one five-second settling deadline
- Native WebM audio/video bytes, no timeout, no outbound or microphone/display request
- A separate full-page still with the exact live subject caption, with the actual second audio source active before and after the screenshot
- A full-page transcript/UI still containing the submitted question and full authored reply
- Closed recorder/tracks/tee/context, restored probes, closed browser and owned mock

Outputs: `actual-rehearsal-scene-with-audio.webm`, `actual-live-subject-caption.png`,
`actual-interview-transcript.png`, `actual-scene.png`, and a JSON report with timestamps, audio signal
samples, actual render/morph samples, exact synthetic TTS requests, duration, byte count, SHA-256
and cleanup status. Screenshot hashes and observed caption text/audio source state are recorded.
The stills show the actual full-page DOM; they are not composited into the scene-only video.

After saving the voiced evidence and disposing its recorder/tracks/audio graph, the same disposable
page reloads into a new visit. An active interview intentionally locks architecture, so the tool never
bypasses that lock or changes the recorded session. It selects Courtyard architecture and Studio
interface theme through actual settings, then walks backward along the original clear central axis
using the normal S key to the authored south-arrival view (camera Z at least 16.3 metres, facing north).
A read-only handle verifies the actual courtyard meshes, native camera position/direction, live WebGL
and frame progress. No camera assignment, teleport, debug global or second recorder is used.

`actual-courtyard-studio-1440x900.png` and `actual-courtyard-studio-1920x1080.png` are separate full-page
stills at those exact browser viewport and PNG dimensions. They show the actual application HUD.
Their hashes and measured scene state are stored in the final report. Quiet/settled mouth observations
include actual page-monotonic `pageTimeMs`; active recorder samples use elapsed `at` milliseconds since
recording began. The report retains actual per-mesh values for all seven named speech morphs,
quiet/active/settled samples, threshold constants and changed-frame deltas. These observations are
not text-timed or generated mouth poses. No threshold is adjusted to make a browser run pass. `voiced-scene-evidence.json`
checkpoints the independently verified audio/session artifacts before the new visit; final browser/mock
cleanup is recorded in `scene-capture-report.json`. A later overview failure cannot erase the earlier
captured evidence and is still reported as a failed overall run. These checks prove captured browser output,
not physical-speaker playback, human listening approval or a hardware frame-rate benchmark.
Inspect and listen to the resulting video before final delivery; codec availability and visual
quality remain browser-dependent.

## Verification status

Revision 3b passed strict tools TypeScript and zero-warning recorder lint on 2026-10-15 at 21:17 UTC,
on the accepted runtime at `8eedd7564570c41def9892e4c1ddd4099b090872`. Its first actual native-browser attempt
entered the precinct, connected the local mock and opened the case board, then failed at an obsolete case
selection locator after 72.319 seconds. No TTS or media capture started. Forbidden requests and cleanup
errors were empty; the owned preview stopped and short temporary directory was removed.

That original attempt remains intact at
`/workspace/shared/precinct-rehearsal-browser-qa/results/native-20261015T211812Z-2fb3cd22/`.
Revision 3c corrects only the demonstrated fixture-article/button locator and adds bounded failure diagnostics:
a full-page screenshot (five-second bound) and actual UI text/viewport state (two-second observation bound,
20,000-character text cap). Diagnostic failures are reported separately and never replace the original error.
Existing action timeouts and all audio/lip acceptance thresholds are unchanged. Revision 3c passed strict
tools TypeScript and zero-warning recorder lint at 21:26 UTC. A new explicitly granted native attempt is
pending; no media or visual/playback pass is claimed.

The dependent local TTS adapter passed 36 focused tests and 13 actual native/API WAV clips plus
abort/shutdown. No opaque/generated import, eval, extra renderer, hidden data, live AI or numeric assessment
is used. The first browser failure is retained and is not covered up by the native-only WAV proof.


## Bounded ownership diagnostics (revision 3d)

The second native attempt (`native-20261015T212816Z-5fa76a56`) reached the seated interview and
correctly failed before Send because two contexts had been constructed. Zero TTS/source starts,
forbidden requests and cleanup errors were recorded; its screenshot and UI diagnostics are preserved.
The room-engine StrictMode construction leak is addressed separately in the committed-lifecycle patch.

The recorder still requires exactly one context. It now records actual native ownership observations
before capture, after playback, on failure and after disposal: up to eight contexts, a 2,000-character
creation stack per context, creation time, current state/sample rate/clock, up to sixteen observed native
state transitions, destination tee count and source/start/end counts. A truncation flag reports exceeded
diagnostic limits. Failure/disposal diagnostic reads have a two-second bound. These are observations,
not context selection, mixing or acceptance changes. All original audio/lip/media thresholds remain.
Revision 3d passed strict tools TypeScript and zero-warning recorder lint at 21:53 UTC in the isolated lifecycle QA mirror. Another explicitly granted native attempt remains pending.
