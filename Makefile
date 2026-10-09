# Investigative AI Training Arena: local quality gate.
#   make bootstrap   clean-clone setup: uv sync
#   make check       the full gate WP-01 ships; any failure fails the target (never softened, global
#                     hard gate: never rig, soften or bypass CI/tests)
#
# `make check` here is WP-01's scope only (S8 build plan): ruff, mypy strict, pytest with the coverage
# gate, bandit -ll -ii, and the lifted tools/ gates (ratchet, no-rigging/suppression allowlist, roles,
# cost-parity stub). Later work packages add db-test (WP-04), web-check (WP-18) and the rest of
# sec-check (WP-07, WP-31) as those trees exist; this file's thresholds only ever get stricter
# (tools/gates/ratchet.toml, lifted from TechnoMile T21).

SHELL := /bin/bash
# macOS ships GNU make 3.81, which ignores .SHELLFLAGS: every recipe line with a pipe or loop starts
# with its own `set -euo pipefail;` below.
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
# Gates run strictly in order: deps-sync must finish before any gate reads the environment.
.NOTPARALLEL:
MAKEFLAGS += --no-print-directory

# `override` makes these immune to command-line and environment overrides (`make check COVERAGE_MIN=0`
# has no effect); each is assigned exactly once (tools/check_ratchet.py fails on a second assignment).
override COVERAGE_MIN := 90
override PYTEST_WARNINGS := error
override BANDIT_FLAGS := -ll -ii

BASE_REF ?= main
PY_SOURCES := packages services tools
GATES_DIR := .gates
UV_RUN := uv run --locked

.PHONY: help bootstrap check deps-sync py-check \
	lint format-check typecheck no-rigging roles cost-parity ratchet test \
	bandit

help:
	@echo "make bootstrap   set up a clean clone (uv sync)"
	@echo "make check       full gate (WP-01 scope: py-check + bandit; BASE_REF=$(BASE_REF))"

bootstrap:
	uv sync --locked

check: deps-sync py-check bandit
	@echo "make check: ALL GATES GREEN"

# Installed environment must match the lockfile exactly before any gate reads it.
deps-sync:
	uv sync --locked

# ------------------------------------------------------------------ python
py-check: lint format-check typecheck no-rigging roles cost-parity ratchet test

lint:
	$(UV_RUN) ruff check .

format-check:
	$(UV_RUN) ruff format --check .

typecheck:
	$(UV_RUN) mypy

no-rigging:
	$(UV_RUN) python -m tools.check_no_rigging

roles:
	$(UV_RUN) python -m tools.check_roles

cost-parity:
	$(UV_RUN) python -m tools.check_cost_parity

ratchet:
	$(UV_RUN) python -m tools.check_ratchet --base "$(BASE_REF)"

test:
	@# A stale report from an earlier run must never satisfy a later coverage read.
	rm -f coverage.xml .coverage
	@mkdir -p $(GATES_DIR)
	$(UV_RUN) pytest -W $(PYTEST_WARNINGS) --cov --cov-fail-under=$(COVERAGE_MIN) --cov-report=term-missing:skip-covered \
		--cov-report=xml --cov-report=json:$(GATES_DIR)/coverage.json

# ------------------------------------------------------------------ security
# Bandit gets the exact file list (tracked + new, not ignored) so the venv and caches are never scanned.
PY_FILES_CMD := git ls-files -z --cached --others --exclude-standard -- $(foreach d,$(PY_SOURCES),'$(d)/*.py')

bandit:
	$(PY_FILES_CMD) | xargs -0 $(UV_RUN) bandit -q $(BANDIT_FLAGS)
