# Local/offline setup and production handoff

## Choose the smallest package

Prefer one immutable production `dist/` plus required notices and build/checksum manifest, and a companion checkout/toolchain for the existing benchmark. This avoids rebuilding on the test laptop, changing source, installing a new UI/framework, or distributing a packaged application/executable.

A complete Vite dist can in principle provide local precinct assets, public fixture views, and bundled recordings offline. That is a source-based packaging assessment, **not a verified standalone delivery**. No final dist was built, copied, archived, or validated for this kit. Do not certify the currently present workspace dist merely because it exists.

### Required production payload

- The entire `web/dist/` from the exact approved build, retaining paths: `index.html`, **all** hashed JS/CSS/dynamic chunks, and copied public assets. A bundle of just index.html + a GLB, or only the assets fetched by the lobby benchmark, is incomplete.
- Both architecture GLBs, manifests and navmeshes; all referenced avatar GLBs/textures/clips; companion asset; bundled audio and worklets; preview/favicon; any build-emitted decoder/font/other resources. Use the final full tree inventory, not this category list, as authority.
- The fixture recordings are imported dynamically by source and may become hashed build chunks; keep those chunks. Do not assume `web/src/fixtures/` exists in dist or distribute an unverified export instead.
- Full relative-path, byte-length, SHA-256 inventory, aggregate byte count, build/source identity, build command/log/exit, source dirty status, and dependency lock identity. Independently compare the received artifact against that inventory.
- Required notices (below). Keep them beside the package even when the app has no attribution UI.

Source-only inventory: `web/public/` contained **100 files, 48,133,143 bytes**, excluding built JS/CSS and package overhead. This is an unpacked source asset total, not final archive size, download size, memory usage, or a verified distributable. Complete hash details are in `SOURCE-AUDIT.json`.

### Runtime versus benchmark prerequisites

A static visual demo needs an already available, trusted HTTP server that binds only to loopback and serves the dist at `/`, plus the native browser. SPA deep links need index fallback and assets need their correct MIME types. Opening index.html with `file://` is not the documented run path. No standalone server binary, installer or service is supplied here.

The **source-verified launch path** is the existing Vite preview command in the runbook, from the matching `web/` directory. It needs the web toolchain, configuration and installed dependencies even if dist is prebuilt. A dist-only directory does not contain `pnpm exec vite`, Playwright, the source runner, or Node. It is therefore self-contained browser content, not a zero-prerequisite executable handoff.

Before disconnecting from the network, the authorized operator must already have:

1. Native macOS/Apple Silicon **Node 24.21.0** and **pnpm 11.0.8**, as pinned by `web/package.json`, with the direct `node` command used by the runner resolving to the intended runtime. Package scripts may use pnpm's managed runtime; do not assume the shell's `node` matches it.
2. The exact native web dependency installation matching `web/pnpm-lock.yaml` and `web/pnpm-workspace.yaml`, including `@playwright/test` **1.63.0** and Vite **8.3.1**. Do not copy Linux `node_modules` or Linux browser executables to the Mac. Lockfile integrity and native optional packages matter.
3. Either the matching Playwright macOS Chromium already provisioned, or an existing native Chrome/Chromium executable whose actual location/version/architecture has been verified and is selected through `ARENA_CHROMIUM_PATH`. Installing the JS package alone does not establish that a runnable browser is available. This kit does not guess a Chrome application path or supply an installation command for unverified local tooling.
4. The matching source runner `web/tools/precinct-performance.ts` and its runtime helpers `web/tools/precinct-capture-position.ts` and `web/tools/precinct-performance-theme.ts`, plus the installed Playwright dependency. Preserve the source tree layout and type-only sources for audit; do not hand-edit imports or create a bundled executable.
5. The immutable final dist, a local writable result location with adequate measured free space, and the build/checksum/notices packet. Decide and record an evidence location outside any automatically shared folder.
6. A verified loopback port and an authorized physical MacBook Air M5 available for native headed tests. No account login, API key, backend, model, microphone, cloud deployment, Blender, TTS generator, or speech-recognition model is needed for the no-API timing run.

Connected preparation, **only if dependencies/build are actually needed and authorized**, uses the source-documented commands from `web/`:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

These commands are provided for the operator; they were not run for this kit. The install may download the managed Node runtime/packages and is not an offline setup promise. The full source build also imports `supabase/tests/fixtures/capability_matrix.csv` from outside web. Preserve that existing read-only fixture and the existing generated/compiled web contracts; do not regenerate or modify backend/root/generated files to assemble this kit. A prebuilt verified dist avoids this build-time dependency on the target machine.

## Notices and privacy boundary

Preserve `web/public/avatars/LICENSE.md` (Rocketbox MIT), `web/public/pets/LICENSE.md` (CC0 provenance), `assets-src/FONT_LICENSE.txt` (DejaVu/Bitstream Vera), `assets-src/MESHOPT_LICENSE.txt`, relevant project/web attributions, and the full notices required by the dependencies actually shipped. Root/web attributions are provenance records, not automatically a complete third-party binary-license inventory. Final packaging must account for build-emitted license files and bundled JS dependencies as well.

Finite staff WAVs are original fictional dialogue generated using separately installed eSpeak NG; the generator/data are not part of the browser runtime. Keep the documented provenance/notice packet (`assets-src/local-staff-voice/` and relevant attribution section) with an internal handoff; do not silently bundle eSpeak, its voice data, Whisper models, or a browser binary. Adding any of them changes the byte/licensing/security review and the offline prerequisites. No redistribution clearance for such binaries/models is established here.

Keep the handoff private to authorized recipients. Review notices/provenance for private filesystem paths or owner-project details before any external distribution. Exclude `.git`, `.env*`, credentials, profiles/cookies, private recordings, notebook exports, backend state, screenshots with personal material, and unrelated logs. Preserve required license text without inventing a new license for owner code.

The runner permits its own HTTP origin, refuses `/api` and other origins, blocks all page WebSockets/service workers, and uses a fresh context with no permissions. Its `blockedRequests` list must remain empty: blocking an attempted forbidden request is a failure, not a clean offline pass. These page-level controls are not a claim that all browser-process or operating-system traffic is firewalled. A manually opened browser does not inherit these guards. Keep manual visual passes on local assets/bundled fictional recordings; avoid “connect local backend,” live voice, microphone and external links.

## Handoff blockers to clear

The [inherited GSAP license decision](../PORTABLE-LICENSE-STATUS.md) remains open before portable distribution. No package is authorized merely by this runbook.

- Exact final dist and complete build manifest/notice inventory have not been produced or verified by this kit.
- Native Mac runtime/dependencies/browser path, GPU, display and power/thermal conditions are unverified until the operator records them.
- Static assets alone cannot demonstrate an interactive live/backend or local-scripted interview, generated room speech, or microphone recognition. Bundled replay is a narrower, offline demonstration.
- The Studio-capable runner has only failed cloud samples so far; native M5 Studio evidence remains absent. Sustained non-lobby route/crowd/interview/replay, per-window degradation and instrumented-versus-uninstrumented overhead evidence also remain absent.
