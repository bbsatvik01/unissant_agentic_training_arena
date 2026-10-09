# Attributions

Every file lifted from a reference repo (read-only; never modified). Format: source path, sha256 of the source file at the commit read, what changed. Lifted files pass every gate like new code; none is excluded.

## TechnoMile (internal, owner's project)

Source: `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat`, commit `52cc3543806f648e9cebdf1997e13f35bad25383`, read 2026-10-08 (clean tree for the files below; S5 cites `b5f1de3`, the content of these files was read at the commit given here).

| Row | Source path | sha256 of source | Target | What changed |
| --- | --- | --- | --- | --- |
| T21 | `Makefile` | `7ca9ac68dc5280f80332d2ccfa2b9af483de5b81fd942f8eb39649fbf37e532a` | `Makefile` | Adapted. Dropped verifier, adk-scope, web, Chromium and scope targets; added `roles` and `cost-parity`; WP-01 scope only (`py-check` + `bandit`). Thresholds unchanged (coverage 90, bandit `-ll -ii`, pytest `-W error`); `override` so the command line cannot lower them. |
| T21 | `pyproject.toml` (workspace, ruff, mypy strict, pytest, coverage, `exclude-newer = "7 days"`) | `9451267e21817f4de95e7d96959725e73340578e86e2743b2a0929a3ce56d508` | `pyproject.toml` | Pattern. New members (arena packages), `arena_` first-party names, dependency groups limited to the WP-01 dev tools. |
| T22 | `tools/check_ratchet.py` | `553766b9f42ea44cbdb13dc025f7c5fc1b8429c7f10d1e0c0fa136875a0ef080` | `tools/check_ratchet.py` | Lifted; roots renamed to this repo's layout. |
| T22 | `tools/gates/ratchet.toml` | `af71d1c37691f8516e873fc65cc2f8978a1d8d55be53d2a0f9ed798e8d4d7cfd` | `tools/gates/ratchet.toml` | Entries re-pointed to this repo's files; only the thresholds this repo has today (coverage, mypy, ruff, bandit, pytest, cooldown); directions and values unchanged. |
| T23 | `tools/check_no_rigging.py` | `30e0e8e300985cc3712f58bf87d3e0fdd325ecd73f587fb61879b728bf502909` | `tools/check_no_rigging.py` | Lifted; scanned roots renamed. |
| T23 | `tools/proc.py` | `3a26fe4557d5b6e901ed3f4a03e559b6b52da24534c3dfb992ce3f9f9ae2a819` | `tools/proc.py` | Lifted; allowlisted tool set kept to the tools this repo uses. |
| T23 | `tools/pytest_guard.py`, `conftest.py` | `5a7edc7ed9aa2bff01d25c187af8ffa0ad54e1f55425f66cbbf4ac457cff94fa`, `016e9b8f40fc0ac79cc645545eb19f6e5b6c11d5f7f72c69ce3a5ec911ebe46a` | `tools/pytest_guard.py`, `conftest.py` | Lifted unchanged in behavior (runtime skip/xfail guard). |
| T23 | `tools/gates/suppression-markers.toml` | `851c715a3596d0a858a65a3f2180529796ea523ea398d158fbc016bb580d2cf5` | `tools/gates/suppression-markers.toml` | Lifted; one comment reworded. |
| T23 | `tools/gates/suppressions-allowlist.toml` | `674558b2e8e400111044558332c680cacd2b1a4e81e608e85aff68d5e3ef0f6d` | `tools/gates/suppressions-allowlist.toml` | Entries replaced with this repo's two verified false positives (single subprocess call sites in `tools/proc.py` and `tools/tests/subprocess_support.py`). |
| T23 | `tools/tests/test_check_no_rigging.py` | `4d1e25956d9f665e8863ad37c8187699117a06325f639b62818b3386caa4d389` | same path | Lifted. |
| T22 | `tools/tests/test_check_ratchet.py` | `09d162d57db1f79cadfa21eab622025816528d5f964511706c7d328f1aaaf7d5` | same path | Lifted; re-pointed to this repo's ratchet entries. |
| T23 | `tools/tests/test_proc.py` | `313a77a5021d343590e31e539fbbc948663550a3f9466dfe9bdb335877e586ec` | same path | Lifted. |
| T23 | `tools/tests/test_pytest_guard.py` | `835451fd419954813079ddae20e05c181acd09e6475d7ddff540c404d693af8d` | same path | Lifted. |
| T23 | `tools/tests/conftest.py` | `ba53aa2983ead63e687abd37c519f919e92a8c948ba23d1db06562f19ec5235d` | same path | Lifted; fake-gcloud helper kept for later audit tests, wrapper handles spaces in the repo path. |
| T23 | `tools/tests/fixtures/suppressions.tsv` | `b9a3d2ef735c2bc095b35175644d2addd80e0278c309dad72c9a0df5fcacc863` | same path | Lifted. |
| T24 | `tools/check_adk_scope.py` | `4418664310e13a6b748fa5a940d95430b549c76af403ec08f749021e1be3f4a7` | `tools/check_roles.py` | Adapted. Same AST walker (import and dynamic-import detection, per-file findings); rules replaced by S5 1.2 item 2 (a to d; rule e deferred to WP-13). |
| T24 | `tools/tests/test_check_adk_scope.py` | `e6c0f08526172b59a7a9dadf775121783186046d690b3f791a59866c06672a10` | `tools/tests/test_check_roles.py` | Adapted to the role rules. |
| T1 | `packages/core/src/bh_core/providers/policy.py` (`refuse_gemini_api_keys`) | `de83424f053bf898833a6a77dd80986d8af462d94da5c4f5123856157b47fd21` | `packages/core/src/arena_core/config.py` | Adapted. API-key refusal kept; OpenRouter/Jev rules dropped; role/DSN, `kbg-production`, local-shape and loopback checks are new. |
| T27 | `services/api/Dockerfile` (digest-pinned uv and python base images, non-root uid 10001) | `1a4fcac8a20cd80906aac0ff9666c0b733fd3719ccf35bc945d9667cb027ab5d` | `Dockerfile` | Adapted skeleton (hosted variant, not built in WP-01). No Chromium; one image for all roles; same base digests; CMD runs the role's boot checks. |

Not lifted in WP-01 (later work packages): `check_silent_except.py`, `check_push_clean.py`, `check_deps_policy.py`, `check_licenses.py`, `check_scope.py`, `check_codeql.py`, `audit_gcp_cost.*`, deploy scripts.

New in this repo (no donor): `tools/check_cost_parity.py` (stub: `cost_model.py --plan-json` parses), the boot-check role/DSN logic, the four service packages and their boot-check tests.

## Pangea `adapi-av2` (PangeaChat, employer code)

Source: `/Users/balla/PangeaChat/adapi-av2`, commit `c44f86ba913e446a9a0447212bb7164a68094214`, read 2026-10-08. Owner decision OD-13 default: patterns only. No source line was copied; the workflows were rewritten for this repo (the pinned action SHAs are public references to third-party actions).

| Row | Source path | sha256 of source | Target | Pattern taken |
| --- | --- | --- | --- | --- |
| P4 | `.github/workflows/test.yaml` | `feb8c902f6f24f01793e925ff028df8a908b9bef7d236af4420d6321a1a90851` | `.github/workflows/ci.yml` | CI runs the gate; here it calls `make check`. Postgres service and diff-cover arrive with WP-04. |
| P5 | `.github/workflows/bandit.yml` | `6f1e684396469f1eb6dd1af1bde1561cbb9413332ec21ea4fd9dfcc1578dc1f5` | `.github/workflows/security.yml` | Two-pass bandit (`-ll -ii`, then `-t B105,B106,B107`). |
| P6 | `.github/workflows/codeql.yml` | `24d5bdfc6ca742b1f5d307e49c406ef23341ea5644fe4b77157f14623cb8cd46` | `.github/workflows/codeql.yml` | SARIF self-gate with `upload: never`; here a missing SARIF fails closed and no auto-issue step. |
| P7 | `.github/workflows/secret-scan.yml` | `9fcc1a1dd435dccd07021dd288bcc2f597c45cdeff496594a00e4cb3cf4b8b5e` | `.github/workflows/security.yml` | TruffleHog verified-only on the PR commit range. |
| P8 | `.github/workflows/pr-title.yaml` | `627b3bc1c6e2a012b5a264fa3d1a6b74e21bb15d01492a36255f0526efa9ad7e` | `.github/workflows/pr-title.yml` | Conventional-commit PR title lint. |
| std | `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml` | `31dc0d24afce98476f274c5d9941e8e115189f6dc4942a2ec092295f4336be64`, `a150a5d82c718ddfb8cc29958443e2e940b996890563988270a9d1d712101bac` | same paths | Org-standard scaffolding shape; contents rewritten for this repo (uv ecosystem, gate checklist, role and infra safety checklist). |
