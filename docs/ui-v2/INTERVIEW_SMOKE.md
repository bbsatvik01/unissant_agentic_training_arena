# Interview and observation browser acceptance

Run the explicit developer smoke from `web/` using the installed pinned Node runtime and Chromium. It creates an owned, loopback-only scripted service and a fresh ephemeral browser context at each of the two requested resolutions. It never attaches to or stops an existing backend or browser profile.

Start Vite separately with its existing supported `ARENA_PROXY_TARGET` option. The target must match `ARENA_MOCK_PORT` in the smoke. Example for a free unprivileged port:

```sh
ARENA_PROXY_TARGET=http://127.0.0.1:8084 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
ARENA_MOCK_PORT=8084 ARENA_PREVIEW_URL=http://127.0.0.1:5173/ node tools/precinct-interview-smoke.ts --start-local-mock
```

The default mock port remains 8080. An occupied port fails closed; no existing listener is killed, reused or contacted by the test. During cloud acceptance the default port was already occupied, so the owned Arena preview was restarted with the supported alternate proxy option. No application Vite configuration, network security setting or unrelated listener changed.

The smoke blocks external origins, audio and microphone attempts, requires the scripted/unscored profile before any mutation, and uses actual local HTTP/SSE plus existing generated validators. It checks explicit EX4 acknowledgement, new practice IDs, preparation-note carry, call/sit/leave, typed questions, record thresholds, explicit public evidence presentation and cited drafts, actual finding commitment and its own authored unscored closure. The genuine coached recording is loaded separately for historical coach cards and all four synchronized monitor views. Pending and active assessment must withhold practice coaching. No HTTP response is fabricated by Playwright.

Five final images are captured per viewport: seated interview, released evidence and cited draft, authored unscored debrief, genuine recorded coach, and four recorded-work views. Separate scene-audit images show the physical tabletop cover and the physical monitor. An actual Canvas pointer click on the monitor must open its expanded view. Every final/audit image requires independent visual inspection; the smoke itself only proves renderer presence and behavioral assertions.

The first cloud run stopped before opening a page because port 8080 was occupied. It produced no screenshots and is not a passing result. The corrected run and complete app gate remain pending; see INTERVIEW-OBSERVATION-QA.md. Software WebGL is not hardware-GPU performance, audio quality or physical-controller verification.

The first reachable preview attempt passed initial connection/EX4 at 1440×900, then a fast-travel assertion did not see the destination within its normal five-second assertion window. A second viewport showed the same symptom; no page/API errors occurred. Queued travel is consumed by the render controller, so missing render synchronization is being tested as a possible cause, not assumed to be proven. The harness now waits for two actual animation-frame boundaries around the travel input, with an explicit 60-second stalled-render failure, before the unchanged normal assertion. It does not sleep or change application/unit-test limits. Failure screenshots and public DOM diagnostics are retained on subsequent attempts.

The synchronized retry reached the actual preparation-note handoff. Its next test selector incorrectly required the accessible name “Notebook” after the tab displayed its note-count badge. The harness now recognizes that existing labeled count; carried note text, no device persistence and all behavior assertions remain required. The failed 1440×900 screenshot/DOM proved the dossier and note were present. The remaining attempt was explicitly interrupted after this actionable failure; it is not a pass.

The next run passed five 1440×900 behavioral groups, including the Canvas monitor click, but the assessment setup attempted the historical F01 case against a mock offering a different case. The application correctly disabled Start. An early unhandled response timer interrupted cleanup; the sole orphaned mock was identified by exact command/port and stopped. No unrelated listener was touched. The harness now selects the actual offered case, verifies Start is enabled, starts the delayed-response timer only on release, and attaches immediate rejection handling while preserving the original awaited error. That failed attempt has no assessment, second-resolution or shutdown pass.

Visual review prompted a lower seated-camera framing target (actor gaze unchanged), larger cover labels with opt-in static mipmaps, compact readable station layout and explicit viewport checks for the source table. These changes require fresh acceptance before their images are deliverables.
