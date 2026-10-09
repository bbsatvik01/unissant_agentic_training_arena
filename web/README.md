# web

The arena's browser app (S6): Vite + React 19 + React Router (data mode) + Tailwind CSS 4, TypeScript strict, pnpm 11. One static build, served same-origin by the local `arena-api` (S6 1.3). Lifted code is listed in `ATTRIBUTIONS.md`.

## Commands

Run from this directory:

| Command | What it runs |
| --- | --- |
| `pnpm install --frozen-lockfile` | Dependencies exactly as locked |
| `pnpm check` | `lint`, `typecheck`, `test`, `coverage`, `build`, in that order; the gate |
| `pnpm lint` | ESLint, typescript-eslint strict type-checked plus React hooks rules, zero warnings |
| `pnpm typecheck` | `tsc -b` over the app and config projects |
| `pnpm test` | Vitest |
| `pnpm coverage` | Vitest with v8 coverage on `src/lib/**`: 90% lines, branches, functions and statements |
| `pnpm build` | `vite build` to `dist/` |
| `pnpm dev` | Dev server on 127.0.0.1, proxying `/api` (WebSocket included) to `arena-api` on 127.0.0.1:8080 |

## Runtime

`package.json` pins Node 24.21.0 (LTS) through `devEngines.runtime`; pnpm downloads it on install and runs every script with it, whatever `node` is on `PATH`. Node 25 is past end of life, and Vitest 5.0.1's engines exclude it.

## Dependencies

- Exact versions only. Every version, direct or transitive, must be at least 14 days old (`minimumReleaseAge: 20160`, strict), per S6 1.2.
- Exceptions (a release-age or trust exclusion, an override) name one exact version and are registered in `dependency-exceptions.json` with the reason, the date the evidence was checked and an expiry at most 92 days later. `tools/dependency-exceptions.test.ts` runs in `pnpm check` and fails when the register and `pnpm-workspace.yaml` disagree and from an expiry date on: re-verify and re-date the entry, or remove it. The `source-map-js@1.2.2` release-age exclusion expires on 2026-10-15, when that version is old enough to need none.
- If a resolving install (adding or upgrading a package) fails with `ERR_PNPM_MISSING_TIME`, the machine's pnpm metadata cache holds abbreviated documents without publish times; resolve once with a fresh cache, for example `pnpm install --config.cache-dir=<empty directory>`. Frozen installs do not resolve and are unaffected.

## Status

WP-18 part 1: scaffold, the ticketed SSE client and trial stream (`src/lib/sse`), the voice machine and voice bar state (`src/lib/voice`; playback progress stays in the browser, S5 7.3), the companion FSM and registry stub (`src/lib/companion`). No visual design before DESIGN.md and the 2026-10-18 slice gate: the only screen is an unstyled placeholder.

WP-18 part 2 owns `trialReducer`, the session controller and snapshot bootstrap, the API wrapper and the compiled wire-schema validation; they depend on the WP-02 generated contracts and are not in this branch.
