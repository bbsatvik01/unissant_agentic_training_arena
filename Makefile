# Investigative AI Training Arena: local quality gate (S5 11.1).
#   make bootstrap  clean-clone setup: Python envs, pinned security binaries, git hook
#   make check      the full gate; any failure fails the target (never softened: global hard gate, never
#                   rig, soften or bypass CI/tests)
#
# Lifted from TechnoMile `Makefile` (S5 T21; ATTRIBUTIONS.md). Thresholds below are mirrored in
# tools/gates/ratchet.toml and may only get stricter; tools/check_ratchet.py fails on drift between the two
# or on any loosening versus BASE_REF. db-test (supabase/ migrations and pgTAP) arrived with WP-03, web-check
# (web/: pnpm check) with WP-02. Gate groups not here yet, each arriving with the tree it gates: web-audit
# (WP-18), dev and dev-check (scripts/run_local.py, WP-13). Adding one never removes or weakens a gate here.

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
	push-clean test scope-coverage diff-cover db-test web-check traces-push isolation-reports \
	bandit semgrep codeql gitleaks trufflehog pip-audit osv-scanner licenses

help:
	@echo "make bootstrap   set up a clean clone (uv envs, pinned security binaries, git hook)"
	@echo "make check       full gate: python, web, database, security (BASE_REF=$(BASE_REF))"
	@echo "make web-check   web/: frozen pnpm install, then pnpm check (lint, tsc, tests, coverage, build)"
	@echo "make db-test     migrations and pgTAP on plain PostgreSQL 17 and on Supabase Postgres 17 (Docker, psql)"
	@echo "make traces-push export pending/held-and-revealed trace mirror rows to local Phoenix and verify"
	@echo "make isolation-reports  run IG-1..3's real suites and post their real report to the local referee"

bootstrap:
	uv sync --locked
	uv sync --locked --project tools/envs/semgrep
	tools/ensure_tools.sh
	tools/githooks/install.sh

hooks:
	tools/githooks/install.sh

# tools-sync runs before py-check: the CodeQL, gitleaks and Makefile gate proofs in the test suite run the pinned
# binaries themselves.
check: deps-sync tools-sync py-check web-check db-test sec-check
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

# ------------------------------------------------------------------ web
# web-check (S6 12): the locked install, then web/'s own gate in order: ESLint (zero warnings), tsc, Vitest, Vitest
# with the 90% coverage gate on src/lib, and the production build (web/package.json "check").
web-check:
	cd web && pnpm install --frozen-lockfile && pnpm check

# ------------------------------------------------------------------ database
# db-test (S5 11.1; S4 WI-S4-01, 02, 04, 08): supabase/migrations and every supabase/tests/*.sql pgTAP file on a
# disposable plain PostgreSQL 17 container with pgTAP (throwaway database plus the shim) and on a disposable
# Supabase Postgres 17 container (its own database, no shim); the cost-parity gate on the migrated seeds; the
# capability fixture regenerated and compared. 127.0.0.1 only, a free high port Docker picks (never 5432),
# containers removed on exit. Any failing, skipped or TODO test fails it.
db-test:
	supabase/tests/harness/db_test.sh

# ------------------------------------------------------------------ observability
# traces-push (S5 8.4, 8.6; WP-07): operator-invoked, not part of `make check`. Exports every row
# ops.v_exportable_spans currently names (pending spans a killed or offline exporter missed, and held spans
# of a tournament just revealed) to local Phoenix, then reads them back and marks the confirmed ones
# verified. Needs ARENA_REFEREE_DSN and PHOENIX_OTLP_ENDPOINT (shape: .env.local.example).
traces-push:
	$(UV_RUN) python -m arena_core.observability.pump

# isolation-reports (S3 9; operator-invoked, not part of make check): runs IG-1, IG-2 and IG-3's own REAL
# suites and posts their real pass/fail and report text to the already-running local arena-referee's
# POST /api/admin/isolation-gate/run (needs `scripts/dev.sh up` first; IG-1 also needs Docker). Never
# fabricates a pass: a suite's own exit code is `passed`.
#
#   IG-1  the pgTAP privilege suite (tools/isolation_gate_pgtap.sh: db_test.sh's own "plain path", one
#         disposable plain PostgreSQL 17 + pgTAP container, every supabase/tests/*.sql file). Its own
#         per-property files, picked from docs/spec/sql/TESTS.md section 0 for S3 9's own wording ("forged
#         turn, cross-trial call, duplicate and replayed work items, stale transcript version, concurrent
#         calls, wrong role, wrong state"):
#           001_capability_matrix.sql       per-role, per-function privilege matrix (wrong role)
#           003_role_reads.sql              "role cannot read X" (wrong role)
#           004_turns_and_versions.sql      stale transcript version (SV-01..04); wrong state (SV-06, SV-12)
#           005_release_evidence.sql        cross-trial, duplicate and replayed release work items (RE-08..12)
#           006_record_subject_turn.sql     forged turn (ST-02..04); cross-trial (ST-06); replayed (ST-05)
#           007_coaching_events_caller.sql  duplicate work item (CC-03); caller separation (CC-14..17)
#           008_finalize_commitment.sql     duplicate and replayed work items (FC-02/03); wrong state (FC-05/13)
#           009_execution_failures.sql      wrong state (EF-02, 04, 06, 08, 10, 11)
#           010_concurrency.sql             concurrent calls (CO-01..09)
#         The whole suite runs every time (run_pgtap.sh's own all-or-nothing per-file verdict, never a
#         narrowed run); the list above documents which file proves which named property.
#   IG-2  the capability-matrix route tests (every investigator route, SSE, reconnect, export; direct calls
#         to arena-subject and arena-referee without the service token refused): services/api/tests/test_app.py,
#         services/subject/tests/test_app.py, services/subject/tests/test_internal_auth.py,
#         services/referee/tests/test_app.py.
#   IG-3  the assistant-context type test (S5 1.2 item 3: the static check and the runtime assertion), both
#         already proved in packages/core/tests/agents/test_coach_prompts.py; this runs exactly those two.
#
# See scripts/isolation_reports.py's own docstring for the full per-file justification.
isolation-reports:
	$(UV_RUN) python -m scripts.isolation_reports

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

# ------------------------------------------------------------------ local fake-model stack (WP-13; S5 10, D-016, D-021)
# make dev runs against the role files in ENV_DIR (default: the repository root, the owner's Supabase project);
# make dev-db creates a disposable local database whose files live in .run/localdb, and make dev-local runs
# against it. make export-run TRIAL=<id> writes recordings/<id>.json. dev-db and dev-db-down never write or
# delete the root .env.local* files.
ENV_DIR ?=
.PHONY: dev dev-local dev-db dev-db-down export-run seed-hosted real-smoke
dev-db:
	scripts/dev.sh db-up
dev-db-down:
	scripts/dev.sh db-down
dev:
	ENV_DIR="$(ENV_DIR)" scripts/dev.sh up
dev-local:
	ENV_DIR=.run/localdb scripts/dev.sh up
export-run:
	@test -n "$(TRIAL)" || { echo "usage: make export-run TRIAL=<trial-id> [ENV_DIR=.run/localdb]"; exit 2; }
	ENV_DIR="$(ENV_DIR)" scripts/dev.sh export-run "$(TRIAL)"

# make seed-hosted EMAIL=<email> (ARENA_OWNER_DSN already set in the operator's shell, never passed here or
# written anywhere): idempotently ingests cases/dev/F01-F09 through sealed.ingest_case_family, registers the
# official roster (A1-A3, S1-S3) through arena.register_candidate, and allowlists one investigator (an
# auth.users row, S4 2.3). Never touches ARENA_USERS_FILE; add the same email there separately. No model call.
seed-hosted:
	@test -n "$(EMAIL)" || { echo "usage: ARENA_OWNER_DSN=... make seed-hosted EMAIL=<allowlisted email>"; exit 2; }
	@test -n "$$ARENA_OWNER_DSN" || { echo "ARENA_OWNER_DSN is not set in the environment"; exit 2; }
	$(UV_RUN) python -m scripts.seed_hosted --email "$(EMAIL)"

# make real-smoke [FAMILY=F01] [COACH=A1] [SUBJECT=S1]: one real subject call and one real coach card through
# the real agent port and spend guard (ARENA_PUBLIC_DSN, ARENA_SUBJECT_DSN, ARENA_DEV_USER, ARENA_USERS_FILE
# already set in the environment -- .env.local plus .env.local.public and .env.local.subject, same as make
# dev; ARENA_MODEL_MODE unset or `vertex` for a real call, `fake` for the zero-spend smoke test this script is
# tested with). Run make seed-hosted first so the candidates and the dev family it draws on are registered.
FAMILY ?= F01
real-smoke:
	@test -n "$$ARENA_PUBLIC_DSN" || { echo "ARENA_PUBLIC_DSN is not set in the environment"; exit 2; }
	@test -n "$$ARENA_SUBJECT_DSN" || { echo "ARENA_SUBJECT_DSN is not set in the environment"; exit 2; }
	$(UV_RUN) python -m scripts.probes.real_smoke --family "$(FAMILY)" $(if $(COACH),--coach "$(COACH)") \
		$(if $(SUBJECT),--subject "$(SUBJECT)")
