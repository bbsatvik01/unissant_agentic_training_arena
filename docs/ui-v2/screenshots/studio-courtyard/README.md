# Studio courtyard: actual browser views, 2026-10-15

These five unedited PNGs were visually inspected. They show the actual application at source `8eedd756` with Studio theme, courtyard architecture, Low quality and DPR 0.75, reached through settings and real keyboard controls. Images are 1440×900 or 1920×1080 as named. The third-person views explicitly switch/assert the normal V camera control and show the loaded character. The station map is the real modal.

- [Reception interior, first person](00-studio-courtyard-interior-1440x900.png)
- [Open courtyard, first person](01-studio-courtyard-first-person-1440x900.png)
- [Open courtyard and character, 1440×900](02-studio-courtyard-third-person-1440x900.png)
- [Open courtyard and character, 1920×1080](03-studio-courtyard-third-person-1920x1080.png)
- [Accessible station map, 1920×1080](04-studio-courtyard-map-1920x1080.png)

## Acceptance boundary

The full harness **failed** its unchanged 60-second walking endpoint gate: the actual trainee advanced from Z −4.2 to Z 12.32352, short of Z ≥16.3. Independent images were then retained at the reached position. All screenshot dimensions, actual theme/asset, camera switch and map checks passed; no runtime/console errors, API/external requests or cleanup errors occurred. The final nonzero result preserves the original route failure.

The timed movement interval measured 0.9115 average FPS in development Chromium ANGLE SwiftShader. Repeated full diagnostic snapshots add work outside the measured frame-submission timer; neither this run nor still images prove production/M5 performance or its cause. Scene signage remains aliased at Low and the materials remain an early visual treatment. No audio, listening, original audiovisual replay or completed whole slice is proved by these stills. [Exact report and hashes](../../browser-evidence/overview-attempt-4.json).
