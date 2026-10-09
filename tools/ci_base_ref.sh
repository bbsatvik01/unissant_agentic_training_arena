#!/usr/bin/env bash
# Print the commit CI compares the change against (ratchet, push-clean, diff-cover): the state before it.
#   pull_request                 the PR's base commit (PR_BASE_SHA = github.event.pull_request.base.sha)
#   push                         the branch tip before the push (PUSH_BEFORE_SHA = github.event.before)
#   first push, branch creation  (before is all zeros) and workflow_dispatch: the root commit, so the whole
#                                history after it is checked. The root commit 463fd16 and every path ever
#                                added in this repository's history were verified push-clean on 2026-10-08.
# Fails closed when the chosen base is not a commit in the checkout (a shallow clone, a force push).
set -euo pipefail

ZERO_SHA=0000000000000000000000000000000000000000
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base="${PR_BASE_SHA:?ci_base_ref: PR_BASE_SHA is required on pull_request}" ;;
  push) base="${PUSH_BEFORE_SHA:-}" ;;
  *) base="" ;;
esac
if [[ -z "$base" || "$base" == "$ZERO_SHA" ]]; then
  base="$(git rev-list --max-parents=0 HEAD | tail -n 1)"
fi
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "ci_base_ref: base $base is not a commit in this checkout (fetch-depth: 0 is required)" >&2
  exit 1
fi
echo "$base"
