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

WP-02 added `src/lib/contracts`: the wire types and schemas generated from `contracts/` (`generated/`, written by `python -m tools.export_contracts` at the repository root and checked for drift by its tests; never edited by hand), the ajv validators compiled from them (`validate.ts`) and the browser port of the shared quote predicate (`quote.ts`), both tested against the shared fixtures in `contracts/fixtures/`. WP-18 part 2 added the room's state layer, still with nothing presentational:

- `src/lib/api`: the one fetch wrapper (`client.ts`: same-origin `/api/` paths only, `X-Arena-CSRF` from `GET /api/me` on every POST, one `/api/me` re-read and one retry on a 403; FE-TECH-5) and the typed routes the room uses (`arena.ts`: request bodies checked against their wire schemas before sending, responses validated before use).
- `src/lib/trial/trialReducer.ts`: the pure trial lifecycle reducer (S6 6.1): snapshot then deltas, folded in `seq` order, duplicate- and order-safe (FE-SSE-2, property test), the completion pair (FE-SSE-8), the complete-card rule (S6 4.5) and the client's visibility re-check (S6 5.4).
- `src/lib/trial/sessionController.ts`: snapshot bootstrap, ticketed stream from `snapshot.last_seq`, every frame through the compiled validators before the reducer, KPI-4 acknowledgements (S6 5.6), the 1 s catch-up check, the 60 s hidden-tab close and resume, and the end of a session through `debrief.ready`, a published debrief or a 409 `stream_closed` (SG4-21).

Test helpers that build valid frame logs from the shared wire fixtures live in `src/test/`.
