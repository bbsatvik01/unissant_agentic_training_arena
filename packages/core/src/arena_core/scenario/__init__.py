"""Deterministic scenario engine (S1 sections 3-11; S8 WP-08; D-014).

Case families are authored once, offline (D-014): there is no generator model. This package is the code
the authoring loop and the build run on an authored family source:

| Module | S1 | What it does |
| --- | --- | --- |
| `source` | 8.3 | `FamilySource`, the typed model of what an authoring agent writes (JSON form) |
| `assemble` | 8.4 | source -> case-family JSON v1.2 with all six packets; deterministic, byte-stable |
| `validators` | 9.1-9.5 | V1 (V1b, V1c, V1d), V2, V3a, V4a, V4b, V4c, V5; pure functions of family files |
| `relay` | 9.1 (S2 8.2, 8.6) | `relay_test.v1` and the replay script: the one module S1 and S2 both import |
| `guardscan` | 9.4 V4c (S2 6.9) | S2 guard rules G3-G5 as data plus the scan the authoring obligation needs |
| `difficulty` | 7.6 | the five knobs and the level bands |
| `seed` | 7.5, 8.1, 10.5 | seeded sampler, style and difficulty factorial, the sampler record and its phi check |
| `brief` | 8.2 | authoring-brief renderer; refuses any example family whose split is not dev (L5) |
| `content` | 6.1, 9.1 | `content_text()` and the V1d byte budget |
| `load` | 4.4, 10.5 | the S4 `sealed.ingest_case_family` bundle with the family source and attestation |

Nothing here calls a model, Vertex or the database.
"""
