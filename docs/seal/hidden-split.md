# Hidden split seal (WP-27, S1 10.3)

- Sealed: 2026-10-13 on the hosted project, verified (`sealed.verify_hidden_seal()` true, 9 family ingests).
- seal_sha256: fdc96908cde1366c36acd2e44cc83b86e7b03ddcdc950dfbe44d7f7b5d6c7323
- n = 9 families (18 cases), levels 3/3/3, 8 violation types, sampler max_phi 0.350 (D-033).
- Codes: H30af989b07, H46f9527bd8, H472308eb91, H618b4adcee, H935b7bf521, Ha133abf188, Hb056a5bfb9, Hc111d8f5fc, Hdc70a9db09.
- Authoring (codes and counts only): 9 pass CX-1, CX-2 truthful, CX-2 deceptive, CX-3, CX-4; 3 in one Codex round, 6 in two. Discarded seeds: 9 (8 CX-1, 1 CX-2) plus 3 balanced-subset drops.
- Pre-seal checks: validator issues 0 (V1-V5, dev + whole hidden split), sampler problems 0, IG-4 dry run 0 hits.
- cases/hidden/ and the authoring Codex sessions were deleted after the archive verified. The authoring agents' local Claude transcripts await owner deletion (list: scratchpad hidden/transcripts_to_delete.txt).
