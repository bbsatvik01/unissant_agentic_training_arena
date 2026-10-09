"""The scorer library (S3 1.4-1.5, 2, 3.7, 4.3-4.4, 5, 6, 8, 9; WP-15): pure functions, no database and no model.

Inputs are the typed contract objects of `arena_core.contracts` (read through the one S2-to-S3 adapter,
`arena_core.contracts.adapter`) and small frozen dataclasses for rows the referee reads from S4; outputs are typed
results. Point estimates and every gate comparison are exact (`fractions.Fraction`); only bootstrap and permutation
statistics use float64 (S3 1.4).

| Module | S3 |
| --- | --- |
| `exact` | 1.4: the 5% gate, rubric mapping, seeds, percentile indices |
| `rubric` | 2: the 22 checks, PFQ routing (3.7), closure checks and the confidence ceiling, rubric hash (2.11) |
| `labels` | 3.3: the EVL-8 decision tree |
| `flags` | 5.3: citation existence, support, duplicates, evasion matching (strict and broad) |
| `inclusion` | 4.2-4.4: validity proposal, inclusion, block infra rule, manifest text and hash |
| `stats` | 5.1, 5.4: cluster bootstrap, zero-event and family-level bounds, attrition (port of `stats_contracts.py`) |
| `metrics` | 5.2-5.3: role, subject, QQ, closure, cost and execution metrics |
| `ranking` | 5.5, 9: eligibility, isolation gate, ranking, rank intervals, paired differences |
| `kpi` | 6: KPI-1, KPI-4, evidence coverage |
| `fairness` | 8: FA-1 to FA-5d, Holm |
"""
