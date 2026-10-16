# Slice 02: reception and briefing

Captured 2026-10-15 from the actual local WebGL runtime in isolated Chromium with ANGLE SwiftShader. All ten images were visually inspected. This is software-rendered functional/visual evidence, not a hardware-laptop 60fps measurement.

The corrected pass completes 38/38 checks with zero page errors, console errors, failed requests or HTTP errors. No request leaves the local preview origin or invokes an API. The installed-local-voice check correctly reports no voice on this cloud machine; full subtitles remain visible. See [smoke-report.json](smoke-report.json) and [full web gate](../../slice-02-check.json).

| View | 1440×900 | 1920×1080 |
| --- | --- | --- |
| Walk-up reception officer and keyboard interaction | [Open](01-reception-officer-1440x900.png) | [Open](01-reception-officer-1920x1080.png) |
| Check-in, authored directions and subtitles | [Open](02-reception-dialogue-1440x900.png) | [Open](02-reception-dialogue-1920x1080.png) |
| Clear sergeant approach and briefing interaction | [Open](03-training-sergeant-1440x900.png) | [Open](03-training-sergeant-1920x1080.png) |
| Public assignment, exact ground rule and case-free technique dialogue | [Open](04-evidence-first-briefing-1440x900.png) | [Open](04-evidence-first-briefing-1920x1080.png) |
| Explicit local name/visit storage, acknowledgement and unavailable-voice fallback | [Open](05-local-staff-memory-1440x900.png) | [Open](05-local-staff-memory-1920x1080.png) |

The runtime uses the 3,075,764-byte lossless compressed world. Original geometry/materials/navigation remain identical; the previously occluded sergeant now has a clear approach, and dialog headings remain available while scrolling. Low-tier edges/lettering and early procedural character poses remain polish targets. Physical controller, audible voice playback and dynamic multi-NPC avoidance are not certified by this pass.
