# Slice 01 rendered evidence

Isolated fresh Chromium, WebGL2 via SwiftShader, Low tier. These are actual application renders, not mockups or Blender previews. Both viewports passed 21/21 scripted checks with no browser/network errors. A sample of requestAnimationFrame cadence is diagnostic only, not a hardware-GPU frame-rate benchmark.

| View | 1440 × 900 | 1920 × 1080 |
|---|---|---|
| Welcome | [PNG](01-welcome-1440x900.png) | [PNG](01-welcome-1920x1080.png) |
| First-person exploration | [PNG](02-entered-first-person-1440x900.png) | [PNG](02-entered-first-person-1920x1080.png) |
| Third-person investigator | [PNG](03-third-person-1440x900.png) | [PNG](03-third-person-1920x1080.png) |
| Station map | [PNG](04-map-1440x900.png) | [PNG](04-map-1920x1080.png) |
| Comfort and accessibility | [PNG](05-settings-1440x900.png) | [PNG](05-settings-1920x1080.png) |

[Full smoke report](smoke-report.json). Reproduce with the local Vite server running: `cd web && node tools/precinct-smoke.ts`. The tool starts only a fresh ephemeral test browser and accepts loopback preview URLs. Older local runs are archived outside tracked final evidence.

The source scene and lower rendering tier still need material/text polish. Native managed-browser fallback was checked separately because that browser exposes no WebGL context. These checks do not establish the recent-laptop 60fps target or controller hardware validation.
