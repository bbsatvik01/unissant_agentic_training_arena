# Local scripted interview service verification

Focused verification: 2026-10-15 13:05 UTC, pinned Node 24.21.0.

- Two files, 21 tests passed, including the channel-neutral unscored-debrief regression.
- Strict app and tools TypeScript passed. Zero-warning lint passed for all six touched TS/TSX files.
- Actual HTTP/SSE lifecycle, generated contracts/invariants, canonical reducer compatibility, bounded inputs and memory, idempotency, own authored closure, assessment isolation, import without listening and owned CLI shutdown passed.
- Native SIGTERM with active SSE passed the unchanged two-second lifecycle bound and exited zero. No mock process remained.

The first runtime run was 18/20. An independent canonical-JSON hash regression caught a mistaken template closer; the original valid serialization was restored. A source audit initially confused RegExp.exec with subprocess execution; an AST audit with its own refusal regression now distinguishes them. Initial strict tools/lint errors were fixed in source. No timeout, assertion, gate, generated contract or backend file was weakened or changed.

Focused checks do not establish browser acceptance, real model/coaching/scoring quality, production authentication, voice or the full app gate. The complete integrated slice result belongs in INTERVIEW-OBSERVATION-QA.md.

Reproduce from web with the installed pinned runtime: run tools/precinct-local-mock.test.ts and src/components/precinct/SessionDebriefUnscored.test.tsx with Vitest; run the normal strict app/tools typecheck and ESLint. The full pnpm check remains mandatory.
