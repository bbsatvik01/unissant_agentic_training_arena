# Coach improvement harness: research summary (2026-10-15)

Recommended combination (pending owner approval):
1. GEPA reflective prompt evolution (gepa-ai/gepa, MIT; ICLR 2026) over Phoenix datasets built from dev-split runs only; proposes edits to the coach's strategy/system prompt.
2. ACE-style coaching playbook (arXiv:2510.04618; kayba-ai/agentic-context-engine): append-only, human-reviewed lessons distilled from referee judgments and human-calibration disagreements, versioned with the prompt.
3. PROCTOR-style gates (arXiv:2609.02246): critic, optimizer and grader separated; mechanical checks (schema, citation-before-verdict, latency/cost) outrank any LLM judge; canary/gateproof cases; frozen dev holdout; champion/challenger promotion only on a holdout win with no false-positive regression; human approves; promoted version hash-pinned before any sealed tournament. Hidden split never visible to any component.

Key evidence: GEPA beats GRPO/MIPROv2 with far fewer rollouts but can overfit (documented train-up/test-down case), hence the holdout and champion rule; ACE delta updates avoid context collapse; PROCTOR shows structural constraints hold under optimizer pressure while "behave better" instructions do not.
Sources: arXiv 2507.19457, 2510.04618, 2609.02246, 2303.11366, 2308.10144; Arize Phoenix release notes (Sep 2026); Microsoft Foundry agent optimization loop write-up.
