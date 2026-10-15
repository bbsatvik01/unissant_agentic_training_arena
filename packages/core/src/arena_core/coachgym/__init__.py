"""Coach Gym (D-036): the continuous coach-improvement harness, pure parts.

The optimizer (GEPA) and the reflector run as an operator tool (`scripts/coach_gym`); this package holds what
that tool and arena-api share and what needs no model and no database:

- `examples`: the dataset shape (one example = the coach's input at one turn of a DEV-split trial plus the
  reference outcome), the fixed dev holdout and the canary examples.
- `metric`: the grader. Mechanical checks first (schema, citation before verdict, latency and cost budget), each
  zeroing the example on failure; then the components read from the referee's and the humans' labels and the
  case's ground truth; the aggregate metrics and the promotion rule (no false-positive regression, never above
  the S3 1.4 gate of 5%).
- `playbook`: the ACE-style append-only lessons (curator and renderer).
- `candidate`: a challenger as a new coach manifest version (existing manifest and hash machinery).
- `registry`: the append-only `coachlab/` files the Coach Lab API reads.
"""
