## Summary

<!-- 1-3 bullets: what changed and why. -->

-

## Type

<!-- PR title must use one of these conventional prefixes: feat, fix, refactor, perf, test, ci, docs, chore, build, style, revert. -->

## Gate

- [ ] `make check` passes locally (py-check: ruff, ruff format, mypy strict, tools gates, pytest with the coverage gate, scope-coverage, diff-cover; sec-check: bandit two passes, Semgrep, CodeQL, gitleaks, TruffleHog, pip-audit, osv-scanner, licences)
- [ ] No gate, threshold, scope, allowlist or test was weakened, skipped or suppressed to get green
- [ ] New behaviour has a failing-first test; a new gate has a gateproof test

## Docs and wiring

- [ ] README, specs, `CLAUDE.md` and `.github/instructions/` match the code
- [ ] Config and env names match what is provisioned

## Safety

- [ ] No secrets, credentials, `.env.local*` files, hidden case families (`cases/hidden/`) or local scratch files committed
- [ ] No server, worker, rate-limit, timeout or health-check config changed (those need owner approval first)
- [ ] No min-instances >= 1 or always-allocated CPU
- [ ] Role boundaries intact: api and tournament never import subject or referee; subject never imports referee; arena_core imports no role
- [ ] Synthetic cases only; no real-person data

## Deploy notes

None
