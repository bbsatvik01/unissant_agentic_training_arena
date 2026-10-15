# Runner-image migration watch

Read-only audit on 2026-10-15. No workflow, backend, tool pin or gate configuration changed.

GitHub's [official runner-image announcement](https://github.com/actions/runner-images/issues/14748) schedules the x64 `ubuntu-latest` move to Ubuntu 26.04 from 2026-10-19 through 2026-11-19. This is a future runner-compatibility risk, not the explanation for current UI test timeouts or historical asset-policy failures.

## Repository exposure

- `.github/workflows/ci.yml` uses `ubuntu-latest` for py-check, db-test and web-check.
- `.github/workflows/security.yml` uses it for python-security, gitleaks and TruffleHog. The pinned OSV reusable workflow selects its own runner outside this repository's direct job configuration; its underlying image was not independently inspected here.
- `.github/workflows/pr-title.yml` already pins `ubuntu-24.04`.
- Web Node is selected from `web/package.json` (24.21.0), pnpm is pinned there (11.0.8), and the workflow explicitly invokes Corepack plus frozen install and the unchanged complete web gate. Python 3.12 and uv 0.11.2 are also selected explicitly. These reduce language-runtime drift but do not pin system libraries or the Docker daemon.
- `tools/ensure_tools.sh` chooses Linux x86-64 release binaries with fixed versions and checksums, then runs their version checks. A new Ubuntu base can still expose runtime-library compatibility issues. Database acceptance depends on the runner's Docker/host facilities.

## Bounded response

At the next authorized CI run, record the actual runner image and distinguish setup/host failures from application regressions. If a change is confirmed, a separate owner-scoped maintenance change can test the existing gates explicitly on Ubuntu 26.04 or temporarily pin affected jobs to 24.04. Neither option is part of the allowed UI-only edits, and neither was performed. Do not weaken assertions, bypass scanners or attribute an unobserved failure to the migration.
