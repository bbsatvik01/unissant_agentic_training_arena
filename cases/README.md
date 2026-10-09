# Case families

Synthetic interview cases for the training arena. Each family is one event graph with a matched truthful and deceptive variant, and three packets per variant (public, private subject packet, evaluator packet). Families are authored once, offline, by Claude agents. A family is accepted only when the deterministic validators and the Codex review pass on the same family-file hash (D-014; S1 sections 8 and 9).

## Layout

| Path | What it holds |
| --- | --- |
| `dev/Fnn.json` | Development family files (schema v1.2), written by the assembler as `json.dumps(family, indent=2, ensure_ascii=False)` plus a final newline. They are derived files: never edit them by hand. |
| `dev/sources/Fnn.source.json` | The family source that the assembler builds `dev/Fnn.json` from: canonical JSON (sorted keys, separators `(",", ":")`, UTF-8 without ASCII escaping, final newline). It also records each variant's `case_id` and `canaries`, drawn once by code from a CSPRNG (never chosen by the author, never derived from anything recorded). Revise a family by changing its source. |
| `dev/reports/Fnn.cx.json` | The latest check report for the family, bound to the family hash it was produced for (`family_sha256`). |
| `dev/seed-plan.json` | Seed plan for F04-F09: violation and misleading types, level, knob targets, style, presentation, persona, facility, dates. |
| `hidden/` | Git-ignored (`cases/.gitignore`). Hidden families are authored by isolated agents and read by nobody on the team before reveal: not the team, not the orchestrating session (S1 L6, L7). They are ingested and sealed in Postgres, then the directory is deleted (S1 10.3). |

F01-F03 are the hand-authored seeds. `dev/F01.json` to `dev/F03.json` are byte-identical to `docs/spec/seed-families/F01.json` to `F03.json`, and their sources reproduce them exactly.

## Checking a family with the kit

The authoring kit is the scratch reference implementation of S1 sections 8.4 and 9 plus the Codex review (CX-1 to CX-4). Its assembler and validators now live in `arena_core.scenario` (WP-08, below); the kit's Codex review and `check.py` loop stay in the orchestrating session's scratch directory (`authoring/kit/`), because CX is an authoring step, not an engine check. Below, `$KIT` is that directory and `$PY` is a Python 3 interpreter with `jsonschema` installed. Run the scripts without `-I` so the kit directory is on `sys.path`.

```sh
cd "$KIT"
$PY check.py /path/to/F04.source.json            # assemble, write, validate, Codex review
$PY check.py /path/to/F04.source.json --skip-cx  # deterministic validators only, for fast revision rounds
```

`check.py` takes a JSON source or a Python module that defines `SRC`, and then:

1. Assembles the family and writes `dev/<ID>.json` and `dev/sources/<ID>.source.json` atomically (temporary file, then rename).
2. Runs `validate.py` (V1 schema with V1b and V1c, V2, V3a, V4a, V4b, V5 including the cross-family checks) over the schemas and every `dev/F*.json`, and `guardscan.py` (V4c, S2 guard rules G3-G5) over the same files.
3. If both pass, runs `cx.py`: four Codex sessions at once. One review session checks CX-1 (ground-truth consistency) and CX-4 (role leakage) over the whole family file and an excerpt of S1 (sections 3-7, 9 and 10.2) cut from the spec at run time. Three blind solve sessions (CX-2 for each variant, CX-3 on the truthful variant) each run in a fresh empty directory with only a solve sheet in the prompt, built by `sheets.py` as S1 9.7 defines it. Code then compares the solves with each variant's resolution criteria.
4. Writes `dev/reports/<ID>.cx.json` and prints one summary line. Exit status 0 means everything passed.

When CX does not run (a validator failed, or `--skip-cx`), the report still records the current family hash, with every CX field `null` and the finding code `CX-NOT-RUN`, so a report never describes an older version of the family. Commit a family only when its check passes.

Report fields: `family`, `pass`, `cx1`, `cx2_truthful`, `cx2_deceptive`, `cx3`, `cx4`, `findings`, `family_sha256` (canonical JSON of the family file), `rules_sha256` (the S1 excerpt the review saw) and `solves` (each solver's finding, cited records and basis). A review finding or a failed solve is `{code, refs, note}`, and a failed solve also names its `sheet`. A Codex session that crashes gives no judgment and is re-run once; if it fails again, or times out, the finding is `{code: SESSION, session, error}` and the check fails. `cx.py --codes-only` reduces findings to codes and IDs, drops solver text, runs Codex with `--ephemeral` and deletes the session files; that mode is for hidden families.

Other kit commands:

| Command | Purpose |
| --- | --- |
| `$PY assemble.py SOURCE [OUT.json]` | Assemble one source; `--check-order SCHEMA_DIR` checks the output key order against the schemas |
| `$PY validate.py SCHEMA_DIR FAMILY.json ...` | Deterministic validators V1-V5 |
| `$PY guardscan.py FAMILY.json ...` | V4c guard-vocabulary scan |
| `$PY sheets.py FAMILY.json [cx2_truthful\|cx2_deceptive\|cx3]` | Print the solve sheets the Codex solvers see |
| `$PY cx.py FAMILY.json --out REPORT.json [--codes-only]` | Codex review alone |
| `$PY mutate.py SCHEMA_DIR dev/F01.json` | Deterministic mutation suite (29 defects, all must be caught) |
| `$PY selftest.py` | Kit properties that the port must keep (below) |

Rules that apply in every revision round:

- A finding is resolved by changing the family, never by changing a validator, a check or a solve sheet (S1 8.5).
- Sources name facts, records and other items with short IDs (`f01`, `u01`, `x01`, `c01`, `r01`, `q01`, `a01`, `g01`, `D1`-`D4`, `R1`-`R6`, `S1`, `S2`). The assembler rewrites those tokens wherever they occur in the source, prose included, so do not use them in record text except as references.
- Content rules from the authoring brief apply: fictional agency, people and places only; no violence; no protected-class traits as clues; no medical detail beyond a named condition category; demeanor and accent are never evidence; no role or verdict words in any public-tier text.

## The engine in `arena_core` (WP-08)

WP-08 ported the kit's assembler and validators into `arena_core.scenario` (S1 v2.7); every `dev/sources/<ID>.source.json` assembles to `dev/<ID>.json` byte for byte, and CI reruns V1-V5 and the S1 9.8 mutation inventory (MU-01 to MU-42 and the control) on every change:

```sh
uv run --locked python -m arena_core.scenario assemble cases/dev/sources/F04.source.json --out cases/dev/F04.json
uv run --locked python -m arena_core.scenario validate cases/dev/F0*.json
uv run --locked python -m arena_core.scenario bundle cases/dev/F04.json --codex codex.json --peer cases/dev/F01.json ...
```

Ledger rows (`known`) and unknown-fact views in the sources are written in the second person (S1 8.3) and copied verbatim; the kit wrote them in the first person and rewrote pronouns at build time, so the committed sources were converted once to the text the families already held. `assemble` draws any missing case ID and canary from a CSPRNG and writes them into the source before it assembles, so a rebuild reproduces the family; `--revise` makes the source the next revision (S1 8.6) with new ones. The Codex review stays in the kit; `bundle` takes its passed result (`{family_sha256, rounds, review, cx2_truthful, cx2_deceptive, cx3}`, bound to the family-file hash it was run on) and writes the results as the attestation's `codex` object (S1 10.5).
