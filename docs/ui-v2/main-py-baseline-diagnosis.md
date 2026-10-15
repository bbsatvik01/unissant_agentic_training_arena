# Main Python CI baseline diagnosis

Verified 2026-10-15 from the exact GitHub job, annotations, and immutable source blobs. Read-only diagnosis; no test, build, scanner, repository edit, Git modification, or policy change was performed.

## Confirmed failure

- Baseline main commit: `693c8c193229ac70754ffaad8335d757ee684a1a`.
- [Run 38789197360](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38789197360), [Python job 116609033580](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38789197360/job/116609033580).
- The failing step was `make deps-sync tools-sync py-check`. It reached pytest and failed `tools/tests/test_db_test.py::test_missing_docker_fails` at line 344:
  - Expected `(code, "docker is not installed" in out) == (1, True)`.
  - Actual `(0, False)`.
- Result: **1 failed, 5,105 passed** in 1,359.26 seconds; coverage **97.69%**, above its 90% threshold. `make` stopped at `Makefile:128: test`, exit 2.
- `make web-check` and `make db-test` both passed on the same commit. This is not a failed database integration job or an asset-cap failure.

## Source diagnosis

The missing-Docker test is not isolated from host-installed Docker:

1. [Fixture lines 144–163](https://github.com/bbsatvik01/unissant_agentic_training_arena/blob/693c8c193229ac70754ffaad8335d757ee684a1a/tools/tests/test_db_test.py#L144-L163) creates stubs but sets `PATH` to the stub directory followed by `/usr/bin:/bin` (line 152).
2. [Test lines 340–344](https://github.com/bbsatvik01/unissant_agentic_training_arena/blob/693c8c193229ac70754ffaad8335d757ee684a1a/tools/tests/test_db_test.py#L340-L344) removes only the stub `docker`, then invokes the real harness through `bash`.
3. [Harness lines 64–69](https://github.com/bbsatvik01/unissant_agentic_training_arena/blob/693c8c193229ac70754ffaad8335d757ee684a1a/supabase/tests/harness/db_test.sh#L64-L69) uses `command -v docker` and then `docker version`; it can resolve a host Docker binary after the stub disappears.

The observed return code 0 is consistent with this host-PATH fallback rather than the expected missing-tool path. The CI failure excerpt does not include captured harness stdout or the resolved Docker pathname, so the exact selected binary is inferred from these source facts, not directly logged. No reproduction was run.

## Proven unchanged between main and UI merge

Compared immutable main `693c8c193229ac70754ffaad8335d757ee684a1a` with UI merge `293ea9c3460c845673ac32a0afa79a7593105579`:

- `tools/tests/test_db_test.py`: identical, 20,444 bytes.
  - Git blob SHA-1: `6d2ab92ad1f44fefb4d0a0c0302f8417253d756f`
  - SHA-256: `3aa0d2dea4bb5b8b3126b285ba48b658e916a639a9aa6df17c6dbf286e1c09a8`
- `supabase/tests/harness/db_test.sh`: identical, 17,251 bytes.
  - Git blob SHA-1: `3221be6689f8382ff34d5d96ea9589e72dd97157`
  - SHA-256: `cfa57a4e2e7ecd7c908a22fdcd07ab0f4504caa2a844f867c561a938bdf2dd17`

The failure is present on main before the UI merge; these two test/harness files did not change in the UI merge.

## Distinct historical UI failure

[UI run 38788325130](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38788325130), [Python job 116606017402](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38788325130/job/116606017402), at `24b2548f47766865abe1c0ec2ce2ca8ef502e97d`, failed earlier in `push-clean` (`Makefile:122`) because historical `web/public/world/precinct.glb` blobs were **5,484,180** and **5,668,084** bytes, above **5,242,880** bytes. Pytest was not reached and no coverage artifact was produced. Web and database jobs passed. The current merge's GLB is 3,075,764 bytes, but reducing the current file alone does not remove historical oversized blobs.

## UI-scope handling

- Keep the baseline Python failure separate from UI asset-history and security failures in status reports. Do not call the aggregate gate green on focused UI passes.
- Preserve the existing quality/security gates. A baseline-owner fix should make the missing-Docker proof hermetic, retaining its failure assertion and coverage; no fix is applied or included here.
- Treat history cleanup and any reviewed security exception as explicit owner decisions, not as implied authorization from this diagnosis.
- Verify current aggregate results on the final merge before making a readiness claim; these historical results do not settle the current run.

## Evidence files

Stored beside this separate note, outside the genuine checkout:
- `main-jobs.json`, `main-annotations.redacted.json`, `main-logs.redacted.log`
- `ui-historical-jobs.json`, `ui-historical-annotations.redacted.json`, `ui-historical-logs.redacted.log`
- `unchanged-source-hashes.json`, `test_db_test.py.source-excerpts.txt`, `db_test.sh.source-excerpts.txt`
