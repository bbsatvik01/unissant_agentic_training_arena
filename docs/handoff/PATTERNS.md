# Patterns: mandatory gates and habits

The global hard gates in `~/.claude/CLAUDE.md` apply in full (handoff discipline, pre-push quality bar, never rig CI, scale to zero, owner approval for infra config). This file adds project habits.

## Workflow rules
- Atomic commits, conventional prefixes (`feat:`, `fix:`, `docs:`, `docs(handoff):`, `chore:`).
- Never push to `main` without explicit per-push owner authorization. Branch + PR for anything shared.
- `git pull --rebase` before committing when parallel agents write.

## Simplicity and lifting first
- Before writing new code, lift the proven pattern from TechnoMile, PangeaChat (adapi-av2), gokbase or cloudforce, with attribution. Reference repos are read-only.
- Simplest code that meets the acceptance. Every agent brief says this.

## Research mandate calibration
- Architecture, vendor and framework decisions: research-harness (tree-of-thought batches; >= 10 Google web + >= 10 Google Developer Knowledge MCP + >= 10 Context7 lookups cumulative; Codex adversarial critique until green x green).
- Spec implementation: 0-3 doc lookups. Mechanical scaffolding: 0.
- Library and SDK APIs: Context7 (`ctx7` CLI) or Google Developer Knowledge MCP, never training-data recall.

## Subagent sizing and concurrency
- Sonnet for gather and mechanical work (~1-3 h scope); Opus for architecture and large refactors (<= 5 h scope).
- At most ~8 concurrent agents per session across all workflows (TechnoMile hang, 2026-09-25). Outputs land on disk as each agent finishes.
- Research agents return full findings for `docs/research/**` and a compact summary.

## Verification gates
- Deep code review (Opus) after each major chunk; do not proceed until GREEN.
- Cross-model (Codex) adversarial review before any push; green x green.
- CI gates are never softened: fix the code, not the gate.

## Numbers come from scripts
- Every cost, statistic, matrix total or sensitivity claim in a design or research doc is produced by a script in the repo (`docs/research/synthesis/*.py` for research) and re-run when inputs change. Agent-reported arithmetic is recomputed, never copied.

## Product bar (from the sponsor brief)
- Every assistant flag cites an exact transcript turn (AST-7). A flag that cites style or demeanor instead of content is unsupported (PRB-4).
- Hidden data (evaluator packets, held-out families, role labels) is unreachable from assistant and investigator code paths by construction, and tests prove it (SCN-5, SCN-12, EVL-10).
- Metrics are computed exactly as REQUIREMENTS.md section 11 defines them.

## Permission walls (always ask)
- Push to main, secret writes, destructive DB ops, API key issuance, infra config (workers, rate limits, health checks, min-instances).
- GCP project: the workstation's default gcloud project is `kbg-production` (gokbase production). Never run arena commands against it. Every gcloud or Vertex call passes the arena project explicitly once the owner provides it.

## Code dispatch protocol (subagent-dispatch-protocol, adapted while there is no remote)
- Every code or data agent works in its own git worktree on its own branch off local `main` (`/private/tmp/wt-<name>`), applies red-to-root-cause and TDD, runs the full local gate green, runs Codex on its own diff to `VERDICT: CORRECT` with `GATE-SOFTENING: no`, and commits on its branch. It never pushes and never opens a PR.
- The orchestrator then runs an independent cold Codex gate on the branch diff (plus re-running the gates). Only on CORRECT does the branch merge into local `main`. Once a remote exists (OD-3), the merge becomes a PR with CI.
- Agents run Codex and test suites in the foreground as one blocking call; never background and end the turn.
- At most ~8 agents in flight across all workflows (16 GB machine; LESSONS 2026-09-25).

## Design system
- Pending the owner's DESIGN.md. Until it lands, no styling or visual design; pure modules, contracts and the unstyled slice UI are allowed (S6 header; slice gate 2026-10-18).

## Handoff discipline
- Update STATE.md after every dispatch, completion, decision, verdict and milestone. Commit `docs(handoff): ...` the same turn.
