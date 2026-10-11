"""The referee's own pure pipeline (WP-14): R1 and R2 storage shaping, the S3 4.2 validity proposal wrapper,
and `debrief.v1` assembly from already-adapted S3 inputs (S3 1.3, 3.8, 4.2, 5.7).

Everything here is a pure function over typed values; no database or model call. `arena_referee` wires these
to `arena_core.db` and the agent port."""
