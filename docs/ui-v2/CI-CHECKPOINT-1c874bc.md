# Published UI checkpoint: 1c874bc

Verified 2026-10-15 18:42 UTC. Source commit: `1c874bc6ad85282a8010b314ceb3b94cab2b96e2`, branch `ui-v2`, draft PR #9. All reported remote checks are terminal.

## Web and database

- [make web-check](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38777913534/job/116570250669) passes the repository's unchanged `pnpm install --frozen-lockfile && pnpm check` command: lint, types, 123 test files / 1,799 tests twice, coverage and build. Coverage: 98.58% statements, 95.71% branches, 99.44% functions, 99.71% lines. Build: 2.73 seconds on this runner, not a client-performance measurement.
- [make db-test](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38777913534/job/116570251012) passes.
- Both title-lint checks pass. TruffleHog, OSV, and the combined Bandit/Semgrep/pip-audit/licenses job pass.

This verifies the published first four slices. Separately staged Studio/courtyard/navigation/replay/audio changes require their own aggregate gate and actual rendering evidence.

## Historical asset blocker

[make py-check](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38777913534/job/116570250246) stops at `push-clean`. Two earlier versions of `web/public/world/precinct.glb` are 5,484,180 and 5,668,084 bytes, exceeding the unchanged 5,242,880-byte committed-file cap. The current file is 3,075,764 bytes; changing HEAD cannot remove historical blobs. Python tests/coverage are not reached in this job. Backend source is unchanged.

The owner decision about a clean replacement branch remains pending. Existing `ui-v2` history is preserved. No force push, history rewrite, main push, policy relaxation or merge has occurred.

## Gitleaks false positive

[Gitleaks](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38777914156/job/116570252471) reports one finding. The repository-pinned official Gitleaks 8.30.1 binary reproduced exactly one finding in a full local history scan with redaction enabled:

- Rule: `generic-api-key`
- File and line: `web/src/lib/precinct/npcVisitMemory.ts:8`
- Introducing commit: `82dbfe0bcf6dd78557a1357ab6f105ea50c7c776`
- Fingerprint: `82dbfe0bcf6dd78557a1357ab6f105ea50c7c776:web/src/lib/precinct/npcVisitMemory.ts:generic-api-key:8`

Manual data-flow review identifies the flagged constant as the fixed public localStorage namespace for opt-in preferred-name and colleague-visit memory. Its consumers are getItem, setItem and removeItem; it is not sent as an authentication credential and grants no service access. It is therefore a false positive, not evidence of an exposed credential. No secret value is reproduced in this report.

No scanner configuration, exclusion, inline suppression or root policy was modified. A later code-only change does not remove this historical finding. Resolution requires an explicitly approved exact false-positive exemption or an authorized clean-history publication strategy; neither is represented as completed.
