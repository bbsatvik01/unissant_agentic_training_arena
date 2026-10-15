# Security job diagnosis: ui-v2 at 6758285

Verified read-only on 2026-10-15, approximately 21:01 UTC. Repository: `bbsatvik01/unissant_agentic_training_arena` only. No repository changes, GitHub mutations, dependency updates, scanners, tests, builds, or browser automation were performed. Public advisory metadata was read separately, without opening any other repository.

## Decision summary

1. **The two newly red Python/OSV jobs share one pre-existing vulnerable dependency:** `mcp==1.29.0`, transitively included by `semgrep==1.179.0` in `tools/envs/semgrep/uv.lock`. The identifiers are **CVE-2026-59951 / GHSA-84m7-p3x7-pcfv**. They are public advisory identifiers, not credentials.
2. **This is not a dependency or security-workflow change introduced by the UI commits.** The root and Semgrep lockfiles are byte-for-byte identical between main `693c8c1` and UI head `6758285`; the relevant manifests, Makefile, and Security workflow also have no differences. The same tool lock is present at `e52122c` and `1cb1bd5`.
3. **The evidence supports newly available vulnerability data rather than a transient CI/tool crash.** The same `mcp==1.29.0` installation passed both audits at about 20:30, then both independent auditors reported this advisory at about 20:37 and again at about 20:50. The advisory database entry was published October 15. The precise ingestion time and cache behavior were not established.
4. **Gitleaks remains a separate blocker.** Current logs establish two redacted detections but do not expose their fingerprints. Two previously reviewed non-secret matches cannot be asserted to be the exact current findings solely from matching counts or ancestry.
5. **The permitted UI-only work cannot repair the dependency lock.** A backend/tooling owner needs to handle that change under separate authorization. No gate suppression or dependency change was made.

## Correct run associations

| Ref | Security run | Created UTC | Python bundle | OSV | Gitleaks | TruffleHog |
|---|---|---|---|---|---|---|
| main `693c8c1` | [38789197752](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38789197752) | 18:52:19 | pass | pass | fail | pass |
| UI `e52122c` | [38802346826](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38802346826) | 20:29:22 | pass | pass | fail | pass |
| UI `1cb1bd5` | [38803343170](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38803343170) | 20:36:39 | fail | fail | fail | pass |
| UI `6758285` | [38805120500](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38805120500) | 20:50:02 | fail | fail | fail | pass |

The latest run is attempt 1, completed with failure at 20:50:52 UTC. The PR checkout logs show merge `9d2b6c0`, merging UI head `675828519bcc3c6b045df2630c12003974595c8b` into main `693c8c193229ac70754ffaad8335d757ee684a1a`. Do not attach the e52122c Security result to 1cb1bd5 or 6758285.

## Exact latest failures

### Python security bundle

[Job 116663862027](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38805120500/job/116663862027), step `make deps-sync bandit semgrep pip-audit licenses`:

- Dependency sync completed, installing `mcp==1.29.0` in the Semgrep environment.
- Both Bandit invocations completed. The `nosec` messages are warnings, not the terminal failure.
- Semgrep's configured scan completed and execution advanced to pip-audit.
- Root-environment pip-audit reported no known vulnerabilities at 20:50:48.
- Semgrep-environment pip-audit reported one vulnerability in one package at 20:50:49: `mcp 1.29.0 CVE-2026-59951`, fixes `1.30.0,2.2.0`.
- `Makefile:236: pip-audit` returned Error 1; make exited 2.
- **Neither license check ran in this latest job.** A composite job name is not evidence that every named target failed or passed.

The two annotations are the exit-2 failure plus an informational ubuntu-latest migration notice. They are not two dependency findings.

### OSV

[Job 116663862070](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38805120500/job/116663862070):

- Scanner examined 109 packages in root `uv.lock` and 67 in the Semgrep lock.
- The scan produced results, with scanner exit code 1 indicating findings; the wrapper's `Run scanner` and `Check that the scan completed` steps are marked successful.
- The `Run osv-scanner-reporter` step failed under `fail-on-vuln: true`.
- Its result table names one vulnerable package: `mcp`, installed `1.29.0`, fixed `1.30.0`, location `tools/envs/semgrep/uv.lock`, advisory `GHSA-84m7-p3x7-pcfv`, reported CVSS 7.5 / High.
- SARIF artifact upload succeeded; the run's sole artifact is `OSV Scanner SARIF file` (ID 12005518227). Code-scanning upload is configured off.

The job's single annotation is only the ubuntu-latest migration notice. The actual vulnerability is in the reporter output, so annotation count alone is misleading.

### Gitleaks and TruffleHog

[Latest Gitleaks job 116663862082](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38805120500/job/116663862082) failed in `make tools-sync gitleaks`, emitting `leaks found: 2`, followed by `Makefile:215: gitleaks` Error 1 and process exit 2. The later official Gitleaks action was skipped. No detailed Gitleaks artifact exists in this run.

[Main's Gitleaks job 116609035415](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38789197752/job/116609035415) already failed and its saved official job log reports one detection. This establishes a baseline secret-scanning problem, not equivalence between main and current findings.

Prior reviewed matches concern a public localStorage namespace in commit `82dbfe0` and a geometry-preservation SHA-256 in commit `9cd148b`. Exact current-run correspondence remains **unverified**; do not suppress the gate or declare both current findings false positives from count alone. A detailed redacted finding report for the relevant scanned revision would be needed, and no new scan was performed here.

[Latest TruffleHog job 116663861618](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38805120500/job/116663861618) passed. Its pass does not negate Gitleaks' distinct result.

## Main-baseline byte evidence

Comparison uses committed blobs, not potentially changing working-tree files.

| Path | Bytes at both commits | Git blob at both commits | SHA-256 of bytes at both commits |
|---|---:|---|---|
| `uv.lock` | 189461 | `67201bc81df018a73cd75a00d7fe42ad5902706a` | `87436b99c07312bb555aef86820ccbb4047a6b8f1db9d60db84ebcd7419ed02d` |
| `tools/envs/semgrep/uv.lock` | 102324 | `956d61c6514e856c42389c0842c1f3a29bb5cefb` | `aa773953d3886427d841689b375f50974783abaf55fbfcff729850a11f760bcf` |

Both direct byte comparisons, main `693c8c1` versus UI `6758285`, returned true. The Semgrep lock's Git blob also matches exactly at `e52122c` and `1cb1bd5`. There are no differences between main and UI head for `.github/workflows/security.yml`, `Makefile`, `pyproject.toml`, `uv.lock`, `tools/envs/semgrep/pyproject.toml`, or `tools/envs/semgrep/uv.lock`.

Main's [Python job 116609035797](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38789197752/job/116609035797) installed the same `mcp==1.29.0`, reported both audits clean at 18:53, then passed both license checks. The [e52122c Python job](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38802346826/job/116654363690) likewise passed its tool audit at 20:30:08. The [1cb1bd5 Python job](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38803343170/job/116657759312) reported CVE-2026-59951 at 20:37:22. These historical green runs do not prove the same bytes would pass against current advisory data.

## Official advisory and exploitability limits

The [GitHub-reviewed advisory](https://github.com/advisories/GHSA-84m7-p3x7-pcfv) maps CVE-2026-59951 to GHSA-84m7-p3x7-pcfv. It lists affected ranges `>=1.8.0,<1.30.0` and `>=2.0.0,<2.2.0`; fixes are 1.30.0 and 2.2.0. It was published to the GitHub Advisory Database October 15, 2026.

The described exposure is uncontrolled session retention in stateful MCP Streamable HTTP servers reachable by untrusted clients. The advisory excludes stdio/SSE-only servers and qualifying stateless configurations. The current page labels severity **Moderate, CVSS v4 6.9**, while this CI report labels **High, 7.5**; preserve those separate source measurements.

The demonstrated installation is a Semgrep tooling dependency, and the inspected workflow invokes a CLI scan. This investigation did not establish whether the arena deploys or exposes an affected server. Neither CVSS nor dependency presence alone proves application exploitability. A root-lock audit passed, but this is not a complete application exposure assessment.

## Minimal backend/tooling-owner handoff

> Security runs 38803343170 and 38805120500 now fail pip-audit and OSV for the existing Semgrep-tool dependency `mcp==1.29.0` (CVE-2026-59951 / GHSA-84m7-p3x7-pcfv). Both lockfiles are byte-identical to main 693c8c1. Please review a compatible patched 1.x resolution (advisory fix: 1.30.0), regenerate only the intended tooling dependency lock under repository policy, and rerun the Python security bundle and OSV, including the license checks skipped after pip-audit failed. Assess actual stateful Streamable HTTP exposure separately. The UI work has not modified dependencies or security policy. Gitleaks is a separate unresolved gate whose current exact findings need a redacted detailed report.

This is a prepared handoff only; nothing was sent externally and no update was authorized or made.

## Saved evidence

Redacted downloaded logs, annotation payloads, job metadata, and artifact metadata are under `/workspace/shared/arena-security-diagnosis/`. Primary evidence files include `latest-python.redacted.txt`, `latest-osv.redacted.txt`, `latest-gitleaks.redacted.txt`, corresponding main/e52122c/1cb1bd5 logs, `latest-jobs.json`, and `recent-security-runs.json`. Existing main Gitleaks evidence was reused from `/workspace/shared/arena-main-gitleaks-693c8c1.log` instead of rerunning a scanner. No credential values were included in this report.
