# Hidden-split sealing runbook (S1 10.3, S8 WP-27)

Operator procedure for authoring, sealing and freezing the hidden split, and opening the first hidden
tournament on it. Follows S1 10.3's sealing sequence literally; each step below names the real command or
API call that performs it. The owner decisions this depends on (OD-8 case count, OD-9 style factor, OD-12
hidden-case-steward access, OD-14 attrition/block-infra rule) are tracked in `docs/spec/S8-build-plan.md`
section 1.3 and `docs/handoff/DECISIONS.md`; this runbook assumes they are already settled before step 1
starts.

**Proof that this sequence works end to end**: `services/tournament/tests/it_tournament.py`'s
`test_hidden_split_seal_freeze_and_open_prove_the_wp27_sequence` runs steps 1-5 below for real (2 throwaway
synthetic hidden families, never committed) against a disposable, migrated database (`make db-test`'s own
"tournament path" container). Read that test's docstring before running a real sealing session: it also
states exactly where the sequence stops today and why (see "Known gap" at the end of this file).

## 0. Preconditions

- The hidden-split family count (OD-8) and style factor (OD-9) are decided.
- `prompts/manifests/*.json` (the official roster) is up to date: `python -m arena_core.agents.manifests check`.
- `prompts/referee/rubric.v1.json` is up to date: `python -m arena_core.agents.manifests check` (the same
  command; see 6382535).
- The database is migrated to the latest `supabase/migrations/*.sql` (the owner's hosted project, applied by
  the owner; never apply migrations to the hosted project from an agent session without explicit authorization).
- `ARENA_REFEREE_DSN` is set to the operator's own `arena_referee` login (not the running referee service's
  pooled credential: this is a one-off CLI session, the same pattern `scripts/seed_hosted.py` uses for the
  dev split).

## 1. Isolated authoring session (S1 10.3 step 1)

The operator starts an isolated authoring session (a Claude agent whose transcript the team and the
orchestrating session do not read, L6/L7) with:

- The repository's authoring code and rules (`prompts/scenario/authoring.rules.v1.txt`, S1 8).
- `n` (the planned hidden family count, OD-8) and the style/difficulty factorial (S1 7.5).
- Working directory restricted to the git-ignored `cases/hidden/` (confirmed in `.gitignore`; never commit
  anything under it).

Inside the session, the sampler draws the hidden seed specs and the style/difficulty assignment from one
recorded seed (S1 8.1); each family's provenance carries its seed-spec hash. The split's sampler record
(`{seed, n, assignment, max_phi}`, S1 10.5) is recorded now and used again at step 4.

## 2. Author and validate each family (S1 10.3 step 2)

For each hidden family, inside the isolated session:

1. Author the family file against schema v1.2 through the WP-09 authoring loop (S1 8.5), with Codex
   cross-review (S1 9.7) started from inside the isolated session.
2. Validate and build its ingest bundle:

   ```
   uv run --locked python -m arena_core.scenario bundle cases/hidden/<FAMILY_ID>.json \
     --codex cases/hidden/reports/<FAMILY_ID>.cx.json \
     --dev-dir cases/dev \
     --hidden cases/hidden/<every other accepted hidden family>.json \
     --sampler-record cases/hidden/sampler_record.json \
     --out cases/hidden/bundles/<FAMILY_ID>.json
   ```

   This runs every deterministic check (V1, V1b, V1c, V1d, V2, V3a, V4a, V4b, V4c, V5) against the whole
   corpus named by `--dev-dir`/`--hidden`/`--sampler-record` (S1 10.3's own corpus requirement: a hidden
   family's V5 needs the rest of the hidden split, not just the dev split) and writes the S4 ingest bundle
   (family file text, attestation, per-variant packets and artifacts) on success. A rejected family goes
   back to step 2.1; the session returns only the authoring report (codes and counts, L7).
3. Ingest the accepted bundle into the sealed archive:

   ```
   ARENA_REFEREE_DSN=... uv run --locked python -m scripts.seal_hidden_split \
     --bundle cases/hidden/bundles/<FAMILY_ID>.json [--bundle cases/hidden/bundles/<other accepted families>.json ...] \
     --sampler-record cases/hidden/sampler_record.json
   ```

   Passing every bundle built so far (not just the newest) is fine: ingest is idempotent per family code
   (an identical bundle re-ingested returns the existing row; S1 10.3 step 2's own "ingest refuses a hidden
   family once the split is sealed" and "a re-ingest with different content" rules apply). Run this with
   `--bundle` naming every accepted family once all are ready, or incrementally as each is accepted --
   either way, nothing is sealed yet without step 3.

## 3. Seal the split (S1 10.3 step 3)

Once every planned family is accepted and ingested, the SAME command above with a complete `--bundle` list
seals the split (idempotent: if ingest already ran for all of them, this run only re-confirms nothing is
missing). `scripts/seal_hidden_split.py`'s own `seal()`:

1. Ingests every named bundle (a no-op for any already ingested).
2. Calls `sealed.seal_hidden_split(sampler_record)` once (refuses a second seal, AR001 -- the script reports
   `already_sealed: true` instead of failing if this run is a retry after the split was already sealed).
3. Calls `sealed.verify_hidden_seal()` and fails (exit 1) if it does not return true.

It prints one JSON object: `seal_sha256`, `already_sealed`, `verified`, `family_codes`, `n_families`. This
is the "publish the seal hash" half of S1 10.3 step 3 (the hash itself; the ledger event
`hidden_split_sealed` carrying it is already public once this call returns).

## 4. Commit, verify the archive, then delete `cases/hidden/` (S1 10.3 step 4)

1. **Commit** the printed `seal_sha256`, `n_families` and the authoring report (codes and counts only, L7)
   to the repository -- for example as a `docs(handoff):` entry in `docs/handoff/HISTORY.md` and/or a short
   note in `docs/handoff/DECISIONS.md`, never the family files themselves. This is the "published
   commitment" S1 10.3 names.
2. **Confirm the archive independently** before deleting anything:

   ```sql
   select count(*) from sealed.family_ingests fi join arena.case_families f on f.id = fi.family_id
    where f.split = 'hidden';                                   -- equals n_families
   select sealed.verify_hidden_seal();                           -- true
   ```

   Both checks must hold with the operator's own eyes on the result before step 4.3 -- this is deliberately
   a manual judgment call, never scripted (an automated deletion that ran before a seal failure was noticed
   would destroy the only unsealed copy of a family that needs re-authoring).
3. **Delete** `cases/hidden/` and the isolated authoring session's own transcripts (Claude and Codex). The
   sealed archive (`sealed.family_ingests`, `sealed.hidden_split_seals`) is now the only copy of record
   (L6). Nothing hidden has reached the repository, CI artifacts or logs at any point in steps 1-4.

## 5. Register the frozen roster and open a hidden tournament

1. Register the official candidates (idempotent; a real run uses the live prompt files, never a possibly
   stale committed hash):

   ```python
   from arena_core.agents.manifests import official_manifests, check_roster
   from arena_tournament import lifecycle
   manifests = official_manifests()
   check_roster(list(manifests.values()))  # S2 3.3/S5 3.3: equal budgets, official, in-process, allowlisted
   for m in manifests.values():
       await lifecycle.register_candidate(connect, m)
   ```

2. Build the roster (`arena_tournament.roster.build_roster`) over the sealed hidden families' variants, then:

   ```python
   tid = await lifecycle.create_tournament(connect, lifecycle.TournamentSpec(name=..., split="hidden", seed=...))
   await lifecycle.add_planned_trials(connect, tid, roster_rows)
   await lifecycle.freeze_tournament(connect, tid)
   ```

   `freeze_tournament` itself refuses a hidden split that is not sealed and verifying (AR021) -- seal before
   freeze is enforced by the database, not just this ordering.
3. **OD-14**: the block-infra rule predeclared for this tournament is `block_invalid`
   (`arena_core.scoring.inclusion`) as it stands today -- the only rule implemented, invalidating a block
   when more than 5% of its planned trials are `infra_failed` (direction 7.1's literal default). The owner
   decision (OD-14, C-36) is still pending a choice between this and the alternative in OQ-2/OQ-3; until it
   resolves, every tournament uses this one rule, and that is itself the "predeclaration" -- there is no
   second rule a tournament manifest could select between yet.
4. **Canary placement + the hidden-text scan** (S1 10.4/L9, S3 9's IG-4 and IG-6), gating `frozen -> running`
   for a hidden split specifically (never skippable): run IG-1 (`tools/isolation_gate_pgtap.sh` or
   `make isolation-reports`), IG-2 and IG-3 (the real route and type tests), then:

   ```
   POST /api/admin/tournaments/{id}/open
   {"ig1": {"passed": true, "report_text": "..."}, "ig2": {...}, "ig3": {...}}
   ```

   against the running `arena-referee` (an `admin`-role console identity; `scripts/referee_admin_client.py`
   handles the CSRF double submit). IG-4 (hidden-text scan over every prompt/fixture/dev-case file against
   the hidden split's own corpus), IG-5 (chain/commitment/corpus-seal verification) and IG-6 (canary audit
   over every candidate's own outputs) are computed live, server-side, from the sealed archive and the
   current database -- never from the request body. A failing gate leaves the tournament `frozen`, not
   `running`; nothing here is retried automatically.

## Known gap: hidden-tournament execution does not run yet (WP-28)

A hidden tournament that reaches `running` (step 5.4 passed) cannot actually be run by
`arena_tournament.runner.TournamentRunner` today: `run_replay_track_prerequisite` refuses every hidden split
outright (`HiddenTournamentError`), and for a confirmed reason, not an oversight -- the harness's own
mid-execution reads (`ArenaDb.public_packet`, and more fundamentally `HarnessAsker`/`CorpusAsker`'s reads of
`arena.v_trial_events` and `arena.v_released_evidence`, both gated by `arena.trial_visible`) see nothing for
a trial that is `running` but not yet `revealed`, because `trial_visible`'s non-training rule is `split =
'dev' or status = 'revealed'` with no allowance for the executing job reading its own in-flight writes.

A narrowing that first looks sufficient -- `or arena.actor_id() is null`, since every `arena-api` route
constructs `ArenaDb` with a real, non-optional actor (`arena_api.state.ApiState.db(actor: UUID)`), so that
clause could only ever add visibility for an automated job/CLI call, never a browser-facing investigator
one -- is not narrow enough on inspection: `scripts/export_run.py` and `scripts/dev_tournament_demo.py` also
call `ArenaDb` with `actor=None`, so the same clause would let `make export-run <hidden-trial-id>` read a
hidden trial's full recording before reveal, exactly what L7 forbids. Distinguishing "the tournament job
reading its OWN currently-running trial" from "any `actor=None` caller reading ANY trial" needs a real
design decision (a dedicated credential, or an explicit execution-context flag threaded through `ArenaDb`
separately from "no investigator"), not a one-line change to a function every content view in the system
depends on. This is tracked as a WP-28 follow-up, not attempted inside this runbook or its proof test.

Once that gap closes, the remaining steps are: a fake-model run (`arena_tournament.main.run_tournament` or
the real job), `POST /api/admin/tournaments/{id}/scoring` (`begin_scoring`), `POST
/api/admin/tournaments/{id}/reveal`, then `GET /api/trials/{id}/recording` (or `make export-run`) resolves
through `arena.v_hidden_cases` (the sealed-run export gap d0db9da closes, 18f3eef its own gate-fix
follow-up) -- proven separately:
`test_a_small_tournament_runs_every_track_through_the_real_functions_and_closes` (same file)
proves the real `TournamentRunner` execution machinery end to end on a dev tournament, and
`supabase/tests/012_reveal_manifest.sql`'s `rvh`/RV-19/RV-20 golden path proves a hidden tournament's
content becomes visible exactly at reveal, not before, including the recording packet.
