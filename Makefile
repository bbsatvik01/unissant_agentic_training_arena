# Investigative AI Training Arena: local quality gate (S5 11.1).
#   make bootstrap  clean-clone setup: Python envs, pinned security binaries, git hook
#   make check      the full gate; any failure fails the target (never softened: global hard gate, never
#                   rig, soften or bypass CI/tests)
#
# Lifted from TechnoMile `Makefile` (S5 T21; ATTRIBUTIONS.md). Thresholds below are mirrored in
# tools/gates/ratchet.toml and may only get stricter; tools/check_ratchet.py fails on drift between the two
# or on any loosening versus BASE_REF. db-test (supabase/ migrations and pgTAP) arrived with WP-03. Gate groups
# not here yet, each arriving with the tree it gates: web-check and web-audit (web/, WP-18), dev and dev-check
# (scripts/run_local.py, WP-13). Adding one never removes or weakens a gate already here.

SHELL := /bin/bash
# macOS ships GNU make 3.81, which ignores .SHELLFLAGS: every recipe line with a pipe or loop starts
# with its own `set -euo pipefail;` (tools/tests/test_makefile.py enforces this).
.SHELLFLAGS := -euo pipefail -c
STRICT := set -euo pipefail;
.DEFAULT_GOAL := help
# Gates run strictly in order: deps-sync must finish before any gate reads the environments, even
# under `make -j` (tools/tests/test_makefile.py asserts this line exists).
.NOTPARALLEL:
MAKEFLAGS += --no-print-directory

# `override` makes these immune to command-line and environment overrides (`make check COVERAGE_MIN=0`
# has no effect); each is assigned exactly once (the ratchet check fails on a second assignment).
override COVERAGE_MIN := 90
override DIFF_COVER_MIN := 90
override PYTEST_WARNINGS := error
override BANDIT_FLAGS := -ll -ii
override BANDIT_SECRET_TESTS := B105,B106,B107
# Every Python gate reads its configuration from this one file, named explicitly: a mypy.ini, ruff.toml,
# pytest.ini, setup.cfg, tox.ini or .coveragerc would otherwise outrank it through each tool's own discovery
# (tools/check_no_rigging.py also refuses those files).
override PY_CONFIG := pyproject.toml

BASE_REF ?= main
PY_SOURCES := packages services tools scripts
GATES_DIR := .gates
UV_RUN := uv run --locked
SEMGREP := uv run --project tools/envs/semgrep --locked semgrep
GITLEAKS := .tools/bin/gitleaks
TRUFFLEHOG := .tools/bin/trufflehog
OSV_SCANNER := .tools/bin/osv-scanner
# Empty = every pinned binary; a CI job that needs one scanner names it (`make tools-sync gitleaks SYNC_TOOLS=gitleaks`).
SYNC_TOOLS ?=

.PHONY: help bootstrap hooks check deps-sync tools-sync py-check sec-check \
	lint format-check typecheck no-rigging silent-except roles cost-parity supabase-config ratchet deps-policy \
	push-clean test scope-coverage diff-cover db-test \
	bandit semgrep codeql gitleaks trufflehog pip-audit osv-scanner licenses

help:
	@echo "make bootstrap   set up a clean clone (uv envs, pinned security binaries, git hook)"
	@echo "make check       full gate: python, database, security (BASE_REF=$(BASE_REF))"
	@echo "make db-test     migrations and pgTAP on plain PostgreSQL 17 and on Supabase Postgres 17 (Docker, psql)"

bootstrap:
	uv sync --locked
	uv sync --locked --project tools/envs/semgrep
	tools/ensure_tools.sh
	tools/githooks/install.sh

hooks:
	tools/githooks/install.sh

# tools-sync runs before py-check: the CodeQL, gitleaks and Makefile gate proofs in the test suite run the pinned
# binaries themselves.
check: deps-sync tools-sync py-check db-test sec-check
	@echo "make check: ALL GATES GREEN"

# Installed environments must match the lockfiles exactly before any gate reads them.
deps-sync:
	uv sync --locked
	uv sync --locked --project tools/envs/semgrep

# The pinned, sha256-verified security binaries (gitleaks, trufflehog, osv-scanner, CodeQL) in .tools/bin; needed
# by sec-check and by the gate proofs in py-check's test suite. Idempotent: a cached version is only re-linked.
tools-sync:
	tools/ensure_tools.sh $(SYNC_TOOLS)

# ------------------------------------------------------------------ python
py-check: lint format-check typecheck no-rigging silent-except roles cost-parity supabase-config ratchet deps-policy \
	push-clean test scope-coverage diff-cover

lint:
	$(UV_RUN) ruff check --config $(PY_CONFIG) .

format-check:
	$(UV_RUN) ruff format --config $(PY_CONFIG) --check .

typecheck:
	$(UV_RUN) mypy --config-file $(PY_CONFIG)

no-rigging:
	$(UV_RUN) python -m tools.check_no_rigging

silent-except:
	$(UV_RUN) python -m tools.check_silent_except

# S5 1.2 item 2: role import boundaries, google.genai only in the Vertex adapter, no google.adk.
roles:
	$(UV_RUN) python -m tools.check_roles

# S5 3.6, 4.9: cost_model.py runs and its --plan-json and parity constants parse. The seed parity against a
# migrated database (WI-S4-08) runs inside db-test (`--dsn`).
cost-parity:
	$(UV_RUN) python -m tools.check_cost_parity

# No arena schema exposed through the Supabase Data API (S4 2.1; WI-S4-01).
supabase-config:
	$(UV_RUN) python -m tools.check_supabase_config

ratchet:
	$(UV_RUN) python -m tools.check_ratchet --base "$(BASE_REF)"

deps-policy:
	$(UV_RUN) python -m tools.check_deps_policy

push-clean:
	$(UV_RUN) python -m tools.check_push_clean --base "$(BASE_REF)"

test:
	@# A stale report from an earlier run must never satisfy diff-cover or the scope check.
	rm -f coverage.xml .coverage $(GATES_DIR)/coverage.json
	@mkdir -p $(GATES_DIR)
	$(UV_RUN) pytest -c $(PY_CONFIG) --rootdir . --full-gate -W $(PYTEST_WARNINGS) --cov --cov-config=$(PY_CONFIG) --cov-fail-under=$(COVERAGE_MIN) --cov-report=term-missing:skip-covered \
		--cov-report=xml --cov-report=json:$(GATES_DIR)/coverage.json

# Every measured-scope Python file must appear in the coverage report (omit/namespace/source drift, or a
# package no test ever imports).
scope-coverage: test
	$(UV_RUN) python -m tools.check_scope coverage $(GATES_DIR)/coverage.json

diff-cover: test
	$(UV_RUN) diff-cover coverage.xml --compare-branch="$(BASE_REF)" --include-untracked --fail-under=$(DIFF_COVER_MIN)

# ------------------------------------------------------------------ database
# db-test (S5 11.1; S4 WI-S4-01, 02, 04, 08): supabase/migrations and every supabase/tests/*.sql pgTAP file on a
# disposable plain PostgreSQL 17 container with pgTAP (throwaway database plus the shim) and on a disposable
# Supabase Postgres 17 container (its own database, no shim); the cost-parity gate on the migrated seeds; the
# capability fixture regenerated and compared. 127.0.0.1 only, a free high port Docker picks (never 5432),
# containers removed on exit. Any failing, skipped or TODO test fails it.
db-test:
	supabase/tests/harness/db_test.sh

# ------------------------------------------------------------------ security
sec-check: tools-sync bandit semgrep codeql gitleaks trufflehog pip-audit osv-scanner licenses

# Bandit gets the exact file list (tracked + new, not ignored) so virtualenvs and caches are never scanned.
# conftest.py at the repo root is Python the pytest run executes, so it is scanned too.
PY_ROOT_FILES := conftest.py
PY_FILES_CMD := git ls-files -z --cached --others --exclude-standard -- $(foreach d,$(PY_SOURCES),'$(d)/*.py') $(PY_ROOT_FILES)

bandit:
	$(STRICT) $(PY_FILES_CMD) | xargs -0 $(UV_RUN) bandit -q $(BANDIT_FLAGS)
	@# -ll skips the hardcoded-secret tests (they are LOW severity); run them explicitly.
	$(STRICT) $(PY_FILES_CMD) | xargs -0 $(UV_RUN) bandit -q -t $(BANDIT_SECRET_TESTS)

semgrep:
	$(SEMGREP) scan --metrics=off --disable-version-check --error --quiet --max-target-bytes=0 --config tools/semgrep/rules.yml .

codeql:
	$(UV_RUN) python -m tools.check_codeql --out $(GATES_DIR)

gitleaks:
	@test -x "$(GITLEAKS)" || { echo "gitleaks missing: run make bootstrap" >&2; exit 1; }
	"$(GITLEAKS)" git --no-banner --log-level warn --redact .
	"$(GITLEAKS)" git --no-banner --log-level warn --redact --pre-commit .
	"$(GITLEAKS)" git --no-banner --log-level warn --redact --pre-commit --staged .
	@# New files are not in git history yet: scan each untracked, not-ignored file too.
	$(STRICT) git ls-files -z --others --exclude-standard | while IFS= read -r -d '' f; do \
		"$(GITLEAKS)" dir --no-banner --log-level warn --redact "$$f"; \
	done

# Git history; a candidate that verifies live, or whose verification could not complete, fails.
trufflehog:
	@test -x "$(TRUFFLEHOG)" || { echo "trufflehog missing: run make bootstrap" >&2; exit 1; }
	"$(TRUFFLEHOG)" git file://. --results=verified,unknown --no-update --fail --no-color

pip-audit:
	@mkdir -p $(GATES_DIR)
	uv export --locked --all-groups --no-emit-workspace --format requirements-txt --quiet -o $(GATES_DIR)/requirements.txt
	uv export --locked --project tools/envs/semgrep --no-emit-project --format requirements-txt --quiet \
		-o $(GATES_DIR)/requirements-semgrep.txt
	$(UV_RUN) pip-audit --strict --disable-pip --require-hashes -r $(GATES_DIR)/requirements.txt
	$(UV_RUN) pip-audit --strict --disable-pip --require-hashes -r $(GATES_DIR)/requirements-semgrep.txt

# No advisory is ignored: an osv-scanner.toml [[IgnoredVulns]] or [[PackageOverrides]] entry is a forbidden
# suppression (tools/gates/suppression-markers.toml) unless a reviewed allowlist entry proves it.
osv-scanner:
	@test -x "$(OSV_SCANNER)" || { echo "osv-scanner missing: run make bootstrap" >&2; exit 1; }
	"$(OSV_SCANNER)" scan source --lockfile uv.lock --lockfile tools/envs/semgrep/uv.lock

# Deny AGPL/SSPL and undeclared licences in both Python environments (the web tree joins in WP-18).
licenses:
	$(UV_RUN) python -m tools.check_licenses python
	uv run --project tools/envs/semgrep --locked python tools/check_licenses.py python
