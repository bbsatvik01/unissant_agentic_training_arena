# Operator runbook

## 1. Freeze the artifact and conditions

Use the supplied final production `dist/` unchanged. Record the source commit, any dirty-source diff, build command/log/exit, full dist SHA-256 inventory, runner/probe hashes, and receipt checksums. An older existing `dist/` is not evidence of this revision. If any app byte changes, start a new candidate identity.

Before timing, record in the manifest:

- Actual model name/model identifier and chip from the Mac's own system information, memory, macOS version/build. Do not collect serial numbers, hardware UUIDs, or account identifiers.
- Browser name/version, executable selected, native Apple Silicon versus translated process, and hardware acceleration status. Use its built-in version/graphics diagnostics in a **separate untimed pass**. Close diagnostics before timing. Compare the actual WebGL renderer/vendor in every primary JSON with the native GPU evidence; `softwareRenderer: false` alone is only a string heuristic. SwiftShader/llvmpipe/softpipe/software, an unexplained generic renderer, or unverified hardware means no M5 acceptance.
- Internal/external display, physical resolution, configured refresh rate, scaling/“looks like” resolution, browser zoom, actual content viewport, native device DPR and Retina setting/behavior. Record the requested emulated viewport/DPR separately from these native observations. The runner's `renderer.deviceDpr` is affected by `--dpr`; it cannot independently verify native Retina DPR. Record actual drawing-buffer pixels and effective render DPR from the report.
- AC or battery, battery percentage at start/end, selected power mode/Low Power Mode, brightness, ambient temperature if available, machine rest/load history, observed thermal state and measurement method. Unknown is acceptable as a recorded limitation; touching a warm case is not a measured thermal-throttling result.
- Background applications/workloads, monitor arrangement and interruptions. Do not build, install, capture video, take screenshots, screen-share, or run DevTools performance tracing during primary timing. Keep the browser focused, visible, and unobscured. Never weaken security or thermal protections to improve a result.

## 2. Start the existing production preview

From the matching `web/` directory, with prerequisites already staged:

```sh
pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort
```

Keep that terminal open. If the port is occupied, stop and resolve ownership; do not kill an unrelated process. Do not substitute `pnpm dev`. Do not start API/model/TTS/microphone services. The root precinct starts offline; avoid controls that explicitly connect a backend.

## 3. Primary timing: five-minute cold-machine / warm-machine pairs

In another terminal in the same `web/`, run the command below. This is the source-documented controlled 1440×900 / emulated-DPR-2 case, **not a claim that those are this laptop's native settings**. For the native-display acceptance run, first replace both values with verified, supported native content-viewport/DPR values and record them. Bounds: viewport 800–3840 by 600–2160; DPR 0.5–4. Use the installed matching Playwright Chromium, or set `ARENA_CHROMIUM_PATH` to an executable actually found and verified on this Mac; no browser path is assumed here.

```sh
node tools/precinct-performance.ts --headed --url=http://127.0.0.1:4173/ \
  --scene=office --theme=studio --tier=medium --camera=third --protocol=movement --viewport=1440x900 --dpr=2 \
  --seconds=300 --warmup=30 --machine-label='Model and conditions recorded in manifest' \
  --out=./m5-results/office-medium-third-ac-cold-01
printf 'runner_exit=%s\n' "$?"
```

Save the terminal output and actual exit code with that run. The output directory must be new for each attempt; the tool does not refuse reuse and may overwrite its JSON. Do not pipe away the true exit code. Retain results before moving them from the test machine.

For a practical baseline, complete Office and Courtyard, Balanced, third-person, on AC and battery, with a cold-machine run and immediate warm-machine repeat for each condition: **eight ≥300-second measured runs, at least 40 minutes plus loading/cooling**. Change `--scene` and the unique output path accordingly. Never switch power state during a sample. “Cold-machine” means a documented rested/cool state; each runner still loads and warms assets for 30 seconds before timing. “Warm-machine repeat” means another ≥300-second run without cooling after the first. Record the elapsed gap and thermal/power change. Do not call either run disk-cache-cold or browser-cache-warm without separate evidence.

Prioritize the exact intended demo configuration first. Record first-person, low/high, and adaptive runs separately when they are in the release claim. For adaptive, use `--tier=adaptive`: it begins at high and permits step-down; report the tier history and pixel budget. Pinned tiers disable automatic lowering but never imply the GPU is fast enough. Do not pool tiers, browsers, displays, or power states into one pass.

Each normal run requires the original entry-readiness gate. Its five-second clock starts after `DOMContentLoaded`; it is not total process-to-interactive or first-navigation latency. A failure remains a failure. A separate new-directory run with `--slow-start-diagnostic` may characterize warmed performance after a failed cold entry; it preserves the cold failure and returns a nonzero outcome. `--readiness-diagnostics` does not provide a steady-state sample. Never use `--software` for target-hardware acceptance.

## 4. Read the result, not just the exit code

Check `performance-report.json`, its `report`, and `evaluation` against the checklist. Confirm 300,000 ms or more, real turns/displacement, expected scene, matching `environmentIdentity` theme at all three observations, production, verified native GPU, one intended pinned tier, zero blocked requests/errors, and uncontaminated continuous foreground samples. The average, p50, p95, p99, and slow-interval fraction must all pass. Preserve the complete JSON, not just a screenshot or summary. Its `loadedArtifactFingerprint` covers only successfully loaded file extensions selected by the runner; it excludes index HTML, WAV/SVG resources and unvisited chunks, so it cannot replace the full dist inventory.

The tool automatically saves `after-measurement.png` only after stopping measurement. Failure captures are diagnostics, not timing evidence. Keep original failure reports and all generated HTML/PNG files, even when a later attempt succeeds. Record manual cancellation/interruption rather than silently replacing the run.

The current report stores aggregate distributions, not a raw per-frame time series or five one-minute subwindows. It cannot establish absence of late-run thermal degradation from a smooth aggregate alone. Compare cold/warm results and report this limit; segment-level quantitative claims remain unmeasured until a separately reviewed measurement change supplies that evidence.

## 5. Separate sustained visual and interaction acceptance

Use the **same production bytes** in a separate local browser pass. First repeat without the performance query to assess ordinary adaptive behavior and instrumentation-off feel. Keep sound and microphone off. Use synthetic/bundled content only. This pass may have separately labelled video/stills; it is not the primary timing pass, and frame rates from its video are not render measurements.

- Select architecture and theme independently in Comfort and accessibility settings. Test the intended demo theme, including Studio if used. Reload resets the theme, so reselect and record it.
- Spend at least five minutes continuously traversing Courtyard using real WASD and arrow/drag look, including central open views, transitions, perimeter/doorways and repeated turns; use V for the intended camera modes. Do not substitute fast travel for traversal.
- Spend at least five minutes on the busiest available staff/crowd sightlines, moving and turning near actors and through doorways. Record the actual tier and visible crowd; do not invent extra actors to make the test pass or describe a sparse lobby as a crowd stress test.
- Spend at least five minutes in interview/observation views, including seated and standing perspectives where available, controls/panels, evidence views and four/expanded monitors. Use the bundled recorded run for timeline-driven local visuals. A fresh live/scripted text exchange requires a separate local API fixture or backend, absent from this no-API kit; mark live-interview acceptance blocked if that is a demo requirement.
- Spend at least five minutes exercising bundled replay: play, pause, seek backward/forward, repeat a seek, and return from free inspection where supported. Record whether the source is v1/legacy or v2 sampled. V1 cannot prove v2 sampled camera ownership, and neither format proves exact audiovisual replay. Do not replace a missing compatible replay with fabricated data.
- Check transitions, opening/closing panels, focus recovery, keyboard release, collision, avatar feet/body visibility, camera clipping, readable signage/captions, responsiveness, and uninterrupted frame appearance. Paused/demand-rendered scenes are assessed for correct interaction and responsiveness, not forced into a continuous-60-FPS budget.

Record pass/fail/not-measured for each segment and the observed duration, route, scene, theme, browser and power state. A visual walkthrough is necessary but does not fill the missing quantitative timing coverage for those non-lobby segments. The integrated explicit-theme runner can measure Studio lobby timing; sustained courtyard/crowd/interview/replay timing still needs separately reviewed segment coverage with the same ≥300-second/native-GPU standards. No such segment extension is implemented in this kit.

## 6. Stop and retain

Stop only the preview you started. Keep raw results from successful, failed, slow, interrupted and diagnostic runs, plus the exact artifact/runner identity. Keep derived summaries separately. Use the manifest's decision and limitations fields; never label an unexecuted checklist or a software run “M5-ready.”
