# Gitleaks ref-scope diagnosis

Verified 2026-10-15 19:54 UTC with the repository-pinned official Gitleaks 8.30.1 binary, checksum verified before execution. Scans used redaction and the unchanged repository configuration. No credential values are reproduced here.

## Observations

- The [main security run](https://github.com/bbsatvik01/unissant_agentic_training_arena/actions/runs/38789197752) at main `693c8c193229ac70754ffaad8335d757ee684a1a` reports one scanner finding. Its two check annotations are the generic job failure and the Ubuntu runner-migration notice, not two findings.
- Its checkout fetches all repository branch refs. The pinned scanner's default Git source uses `git log -p -U0 --full-history --all --diff-filter=tuxdb`, so a workflow labelled main can encounter another fetched branch's historical content. This does not establish that the flagged content belongs to main's ancestry.
- An explicit exact-main history scan (`--log-opts=693c8c193229ac70754ffaad8335d757ee684a1a`) exited 0 with zero findings.
- The later default all-refs scan, after UI checkpoint `9cd148b`, exited 1 with two findings. These were manually traced to non-secret source values below. A follow-up exact main-plus-UI history scan (`693c8c1` plus `24b2548`, matching those two earlier branch heads) reproduced exactly one finding: the public localStorage namespace. Other fetched dependency-branch refs were not independently reconstructed.

Primary scanner implementation: [Gitleaks 8.30.1 Git source](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/git.go). Repository workflow and Makefile are unchanged.

## Reviewed exact findings

1. `82dbfe0bcf6dd78557a1357ab6f105ea50c7c776:web/src/lib/precinct/npcVisitMemory.ts:generic-api-key:8`

   The fixed public localStorage namespace for opt-in colleague visit memory. Its consumers are getItem/setItem/removeItem; it grants no authentication or service access.

2. `9cd148b0590b7563d994308b4dcfa3d91e12c0f0:docs/ui-v2/courtyard-asset-proof/courtyard-module-preservation.json:generic-api-key:712`

   An object-geometry SHA-256 under the retained-object fingerprint map. `assets-src/build_precinct_courtyard.py` derives it from deterministic JSON geometry data with `hashlib.sha256`, then writes the preservation report. It is provenance for the original accessible writing shelf, not an API credential.

These two findings are verified false positives; this is not a blanket claim about unrelated revisions or uninspected content. No scanner exclusion, allowlist, inline suppression, security-policy edit or history rewrite was performed.

## Publication consequence

The historical oversized GLBs are a separate push-clean blocker. A clean replacement branch may solve that branch-range size check if the owner authorizes it, but retaining the original ui-v2 ref does not remove its findings from an all-refs Gitleaks scan. The smallest scanner-policy remedy would be separately authorized security-owner review of the two exact fingerprints. That root-policy change is outside this UI task's permitted files and has not been made. Existing history remains intact.
