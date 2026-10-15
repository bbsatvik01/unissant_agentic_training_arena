# Independent Studio/courtyard browser evidence

`web/tools/precinct-overview-capture.ts` exercises the actual browser application with real settings and keyboard input. It intentionally separates visual acceptance from the voiced recorder, so a failed audio ownership assertion cannot obscure an independently rendered world.

The harness is loopback-only. It rejects all API and cross-origin traffic; browser permissions are empty. It does not request microphone, backend, model or media playback. A fresh browser selects Low quality, Studio theme and the courtyard architecture, enters normally, then walks backward on the authored arrival axis to South Arrival Arcade. The existing opt-in renderer probe is read-only; it supplies actual active asset, camera, draw calls, triangles and drawing-buffer size. It does not write the camera, player, simulation, or framebuffer.

Planned actual full-page stills:

0. Studio/courtyard interior before walking at 1440×900.
1. Actual reached first-person view at 1440×900.
2. Third person explicitly switched/asserted with the normal V key at 1440×900.
3. Same actual third-person view at 1920×1080.
4. The accessible courtyard station map at 1920×1080.

Every image records its PNG SHA-256 and dimensions with the actual renderer status. Errors and forbidden requests fail acceptance. Failed runs retain the screenshot, bounded UI text and failure report. The native launcher uses a disposable short temporary directory, loopback-only owned preview, bounded process lifetime/logs, and cleans only its own process groups.

## Current checkpoint

Source authored against `8eedd756`. Revision 3 strict tools typing and owned-file zero-warning lint passed at 21:58 UTC. The unchanged finite-SVG parser and performance option tests passed 16/16 before that revision.

Attempt 1 retained a visually reviewed Studio reception image but failed the old parser before the walking route. Attempt 2 failed the unchanged 60-second arrival condition at Z −1.60824; neither is a passed walkthrough. Revision 3 captures a labelled pre-walk still, explicitly checks browser/canvas focus, and records bounded actual key/focus/frame/position observations under the same navigation bound. Attempt 3 has now completed and remains failed: continuous visible/focused KeyS moved from Z −4.2 through the reception opening to Z 11.22, but did not reach Z 16.3 within 60 seconds. It rendered 46 frames over 60.1656 seconds (0.7646 FPS); p95 frame interval was 3658.9 ms, draw calls 77, triangles 138,642, and CPU submission p95 19.7 ms. The actual renderer is development ANGLE SwiftShader, so this is diagnostic evidence, not a production benchmark. It establishes actual movement and severe frame starvation in this run; it does not establish the cause of the older attempt. Cleanup completed with no blocked requests or runtime errors beyond the endpoint assertion.

The final failure still is a reviewed actual exterior courtyard first-person view (1440×900; SHA-256 `2a7e5b69333f1bb02421f8104f86f6c173b5ed2bf8775667211073e27febfc53`). The initial interior is also an actual first-person view: the route defaults to first person. No walking body or third-person view was accepted from these attempts.

Source-only revision 4 preserves the same route assertion, records it as a failing error/nonzero exit, and continues independent view capture at the actual reached position. It explicitly switches and asserts third person instead of assuming the default. This separates screenshot availability from route acceptance; it does not turn a failed route into a pass. Revision 4 strict tools and zero-warning lint passed; its actual run retained five independently valid, reviewed PNGs while preserving the failed route/error/nonzero exit. It reached Z 12.32352, measured 0.9115 average FPS, and completed the explicitly asserted third-person switch and station map without runtime/forbidden-request/cleanup errors. [Images and exact limitations](screenshots/studio-courtyard/README.md). It neither writes the camera/player nor alters movement geometry or timing. Runtime source in the frozen mirror remains `8eedd756`; later application repairs have separate validation lifecycles.

These stills will establish visible UI/world states, not hardware frame pacing, voice/lips, whole-session replay or backend connectivity. The measured Office production frame-pacing and cold-start failures remain visible in `PRECINCT-PERFORMANCE-VALIDATION.md`; MacBook Air M5 acceptance is still pending.
