# Slice 03: case dossier and working notebook

Captured 2026-10-15 from the actual local WebGL runtime in isolated Chromium with ANGLE SwiftShader. All ten final images were visually inspected. This is software-rendered functional/visual evidence, not a hardware-laptop frame-rate measurement.

The corrected run passes 38/38 checks across 1440×900 and 1920×1080, with no page errors, console errors, failed requests or HTTP errors. No request leaves the local preview origin or invokes an API. The [machine-readable report](smoke-report.json) records every assertion and actual requested asset. The separate complete unchanged web gate is also green: lint, typecheck, 99 files / 1,626 tests twice, coverage and production build. Its first coverage attempt encountered timeouts and a worker-start failure during a cloud execution stall; the full rerun passed after recovery without source or gate changes. See the [gate summary](../../slice-03-check.json) and [current notes](../../NOTES.md).

| View | 1440×900 | 1920×1080 |
| --- | --- | --- |
| Explicit public case selection | [Open](01-public-case-selection-1440x900.png) | [Open](01-public-case-selection-1920x1080.png) |
| Public dossier overview | [Open](02-dossier-overview-1440x900.png) | [Open](02-dossier-overview-1920x1080.png) |
| Original source text and table | [Open](03-original-public-document-1440x900.png) | [Open](03-original-public-document-1920x1080.png) |
| Source-led timeline, with explicit limitations | [Open](04-source-led-timeline-1440x900.png) | [Open](04-source-led-timeline-1920x1080.png) |
| Cited working notebook, memory-only by default | [Open](05-cited-working-notebook-1440x900.png) | [Open](05-cited-working-notebook-1920x1080.png) |

Acceptance includes keyboard tab navigation; original document/table preservation; only public profile/evidence fields; exact-source timeline links; note creation/citations; close/reopen retention without movement or automatic storage; explicit device save/forget; larger text, high contrast and 150% reading without horizontal dialog overflow; explicit file-review progress; and Escape returning to the visible exact ground rule.

The initial run found a four-pixel horizontal overflow caused by the general station header's negative margins inside the wider dossier. The dossier header now matches its own padding at both breakpoints. A font-dependent arrow was replaced with a local SVG. The corrected complete pass retains all assertions. Software-render startup and travel waits use the already-established observable asset/frame readiness budget; application unit-test timeouts and all quality gates are unchanged.

This slice does not yet make the interview station playable. It prepares one canonical session runtime and an explicit preparation-note handoff for that next slice. The source-led timeline is a reading aid, not an inferred chronology or a finding. Public packets without source photos use a metadata profile rather than fabricated photographic evidence.
