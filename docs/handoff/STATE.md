# State

- **Date:** 2026-10-11
- **Branch:** `main` (local only, no remote yet)
- **Phase:** 1, build (D-013). GCP spend $0. Deadline 2026-11-02 (D-005); slice gate 2026-10-18.

## RESUMED 2026-10-11 (owner: full speed, simple, UI is the centerpiece D-020, record runs D-021, Codex gates sparingly)
| Item | State | Next |
| --- | --- | --- |
| WP-18 part 2 | MERGED (cc4d45f) + follow-up merged | done |
| WP-11 guard | MERGED (066e044); py-check green on main | done |
| WP-05 port | MERGED (8ab36a8) | done |
| WP-12 subject | MERGED | pilot via WP-13 (D-024) |
| WP-14 referee | MERGED (new migration 20261011000100 to apply) | done |
| WP-16 reveal + leaderboards (a0b00bfa4c3d5b0bc, Sonnet, wt-wp16-reveal) | building | review, merge |
| WP-13 orchestrator (ad05fb8f3c14649dc, Opus, wt-wp13-orch) | building: routes, SSE, D-021 export-run, D-024 actor, local launcher | review, merge |
| WP-04 pgTAP | MERGED (23 files green) | done |
| WP-07 observability | MERGED; Phoenix live run + screenshot deferred to WP-24 | done |
| UI stage 1 | MERGED (38792cd); reads as a gray prototype vs owner bar | stage 1b running |
| UI stage 1b (ac2a4c78d321feac9, feat/ui-world-1b) | realistic humans + lip sync (D-025), full-bleed cinematic shots, PBR lighting/materials | review screenshots, merge |
| Supabase | 0600-1100 + 20261011000100 APPLIED 2026-10-11 via owner DSN (transactional, stored byte-exact; 12 migrations); global ceiling $74 set, per-user $5, kill switch off. Role logins enabled (owner-authorized, random passwords) and .env.local.{public,subject,referee} written (0600, git-ignored); each role connects | next: advisor follow-ups: duplicate referee read policies (perf WARN), unindexed FKs (INFO); public.rls_auto_enable is Supabase's platform helper |
- Queue: WP-13 (incl. D-021 export-run + history route) after WP-12; UI stage 2 live wiring + debrief; WP-16/17; WP-24.
- Budget plan $74 approved (D-022); apply right after 0600. Codex up to 7 rounds per agent (D-022).

## HOLD 2 (owner directive 2026-10-09 ~01:50 EDT)
- No new agents or workflows. Do not stop anything running; let it finish. Usage refreshes ~07:00 EDT.
- Workflow agents cannot be messaged mid-run, and usage percentage is not readable from this session. If the limit stops them, their committed work and cached agent results survive; resume each with `Workflow({scriptPath, resumeFromRunId})` after 07:00 (runs: cases wf_0246738e-32c, wave 2 wf_9aced0c9-52d, web wf_20ff7f42-fb5).
- Durable checkpoint 2: `~/arena-checkpoint/2026-10-09-0150/` (worktrees, branch commit lists, dirty-file lists, scratchpad). At checkpoint: wt-wp01 6 commits, wt-wp03 4, wt-wp08 3 (each with a few uncommitted files); wt-cases and wt-web uncommitted in progress.

## HOLD 3 (owner directive, 2026-10-09 night; lifted 2026-10-11)
- Do not stop running agents; send nothing new. Resume when the owner returns.
- All three agents finished on their side; nothing running. Running (normal agents, addressable with SendMessage):
  | Agent id | Work | Worktree / branch | Next step when it reports |
  | --- | --- | --- | --- |
  | ac1b3a38666e87dcf | WP-05 DONE on its side (1e7d458, self Codex CORRECT): wire-exact byte measure (json \\u escapes), S5 4.10 cap replay (13,614 calls, matches simulate_d009), per-role lifecycle | /private/tmp/wt-wp05-port feat/wp05-port | on resume: cold Codex gate, merge; then switch port to WP-10 sent_schema/budget.request_bytes/repair helpers + parity test |
  | adb48fe0d3cc9a911 | WP-11 DONE on its side (6d15ad7, one scoped Codex round CORRECT): FX-COOP checker cut to IDs + verbatim released quotes + review binding (S2 11.1 07c756b); G2 uses the fence marker set | /private/tmp/wt-wp11-guard feat/wp11-guard | on resume: cold Codex gate (scoped to current spec), merge |
  | a80b942018d564e81 | WP-18 part 2 DONE on its side (007d133, self Codex CORRECT): 5 findings fixed; snapshot contract gained question_seq/event_seq/SnapshotCard; ajv validators now compiled at build time (CSP blocker fixed); retryable ending state | /private/tmp/wt-wp18b-web feat/wp18b-web | on resume: cold Codex gate, merge; confirm the exact-path lint/coverage exclusion of generated web/src/lib/contracts/compiled/validators.js (1.7 MB, ~160 KB gz); update S5/S6 snapshot fields |
- OPEN DECISION (cost_model, mine): escaped wire bytes make non-ASCII cost 2-3x UTF-8, so S2's adversarial maximum exceeds input limits (card 117,219 -> well over 128,000). Options: cap questions/model fields in transmitted bytes (simplest), or raise LIMITS 2-3x. Decide on resume with WP-10's renderer numbers. db-test now ~27 min (cap replay).
- Supabase blocked at migration 0600 of 10 (0100-0500 applied byte-exact); owner action: .env.owner with the session-pooler DSN, or restart the Claude Code session so the MCP allow rules load; then apply 0600-1000 and roles.
- Next queue after the three merges: WP-12 subject service, WP-13 orchestrator + routes + SSE, WP-14 referee, WP-07 observability, then WP-19 slice UI (DESIGN.md D-018) and WP-24 integration; first local end-to-end text run follows.
- Spec follow-ups collected: content_text separator (S2 4.4.1 ' ; ' vs code ' | '); AC-S3-4.5 F01 material count; S3 5.3 code block duplicate rule; S3 5.5 full ranking key; S2 HOLD range wording; finding_contract migration into spec 0004; web-check CI job.
- Durable checkpoint: /Users/balla/arena-checkpoint/2026-10-09-1831

## WP-10 merged (2026-10-09 night)
- WP-10 prompts/builders/manifests/byte bounds merged (8b3b0df; cold Codex CORRECT, 3 rounds). Question cap 600 chars and 2,400 normalized bytes (contracts/rendered.py). S2 11.1 FX-COOP enforcement split recorded (a355544).
- In fix loops: WP-05 port (serialized byte bound, cap replay, per-role tests), WP-11 guard (FX-COOP option A), WP-18 part 2 (5 findings).
- Supabase still blocked at 0600 (owner: .env.owner or session restart).

## Progress (2026-10-09 evening)
- WP-15 scorer merged (cold Codex CORRECT, 2 rounds). Spec follow-ups from it: AC-S3-4.5 says 12 material facts for F01 truthful (file has 13); S3 5.3 reference code duplicate rule; S3 5.5 full (recall, QQ) key; rubric CONFIG lexicon/prompts must be filled by the WP that adds them (lineage tripwire).
- In fix loops with the same agents: WP-10 prompts (3 majors), WP-11 guard (fixture content), WP-05 port (building), WP-18 part 2 (building).
- Supabase blocked at migration 0600: background agents cannot answer the MCP permission prompt; owner asked to provide .env.owner (session pooler DSN) for a psql apply, or restart the session.

## Owner answers (2026-10-09 ~14:10)
- gcloud ADC done (verified token). Budget alert created on billing account 015779-E976C5-FCD8BF: $75, project cna-guardian, label app=unissant-arena, thresholds 33/67/87/100% (budget id bc74c6da-7df4-442f-9572-bea7ba1593f1).
- Database: owner's Supabase. Agent a73ac65007530d4a6 applying the ten migrations via MCP, then role passwords (owner-authorized) into git-ignored .env.api/.env.subject/.env.referee.
- Docker only for the pgTAP test harness (OrbStack works); disk cleanup by owner later; KPI-1: owner + one friend (n=2).
- DESIGN.md: docs/design/DESIGN.md (D-018).

## Build wave 4 dispatched (2026-10-09)
| Agent id | WP | Worktree / branch |
| --- | --- | --- |
| ac1b3a38666e87dcf | WP-05 agent port + spend-guard client (cna-guardian, label, fake model; real Vertex smoke left to the owner) | /private/tmp/wt-wp05-port feat/wp05-port |
| aa5c3224c8090bdc8 | WP-10 prompts, builders, manifests | /private/tmp/wt-wp10-prompts feat/wp10-prompts |
| adb48fe0d3cc9a911 | WP-11 guard runner, relay test, replay script, lexicons | /private/tmp/wt-wp11-guard feat/wp11-guard |
| acd646de7e54c665f | WP-15 scorer library (pure) | /private/tmp/wt-wp15-scorer feat/wp15-scorer |
| a80b942018d564e81 | WP-18 part 2 web state (API wrapper, trialReducer, session controller) | /private/tmp/wt-wp18b-web feat/wp18b-web |
- Shared protocol: scratchpad gates/agent_protocol.md. Each returns on self Codex CORRECT; then coordinator cold gate and merge. Next after these: WP-12 subject service, WP-13 orchestrator + routes, WP-14 referee, WP-07 observability.

## WP-02 merged (2026-10-09)
- feat/wp02-contracts merged: contracts package, adapter, quote predicate (Py + TS), deterministic schema export, wire fixtures, web-check in make check; the only wire writer is projections.wire_deltas (bytes in one call); frame lint is a tripwire. Migration 20261009001000_finding_contract.sql: fold into spec 0004. D-017 per-user cap $5 merged (3f4e5b4).
- Open small items: web-check job in CI (pinned Node/pnpm actions); fold finding_contract into spec.
- Next: dispatch WP-05 (agent port + global guard client, cna-guardian, label), WP-10 (prompts, manifests), WP-11 (guard, relay, replay), WP-15 (scorer), WP-18 part 2 (reducer, controller, API wrapper).

## Build wave 3 (2026-10-09)
- WP-02 contracts agent dispatched (id a46dbfe21eaa90fbf, worktree /private/tmp/wt-wp02, branch feat/wp02-contracts).
- Spec agent (ae6c4a65789796395) folding the 0800 draft SQL fixes into docs/spec/sql + S4/TESTS (v2.8) and deciding rule F4.
- After WP-02: WP-05 agent port + global guard client, WP-10 prompts/manifests, WP-11 guard/relay/replay, WP-15 scorer, WP-18 part 2 (parallel), then WP-13 orchestrator + routes.

## WP-08 merged (2026-10-09)
- feat/wp08-scenario merged (cold Codex CORRECT after 2 rounds; db-test green via OrbStack). Engine: assembler byte-identical for F01-F09, V1-V5, MU-01..MU-42, sampler record checks, ingest bundle requiring the full V5 corpus, guardscan equal to S2 6.9 (test parses the spec). Case IDs and canaries random and recorded. Open for spec: rule F4 (material flag) not in V2; F01 r:02 f:08 and F02 r:02 f:05 are material:false.
- Main now has: spec v2.7 GREEN, dev cases, scaffold+gates, web foundation, DB migrations+harness, scenario engine.
- Next build queue: fold 0800 fixes into spec SQL; WP-02 contracts; WP-05 agent port + global guard client (cna-guardian, label app=unissant-arena); WP-10 prompts; WP-11 guard/relay/replay; WP-13 orchestrator + routes; WP-15 scorer; WP-18 part 2.

## WP-03 merged (2026-10-09)
- feat/wp03-db merged (cold Codex CORRECT after 2 rounds). Migration 20261008000800_draft_fixes.sql carries 7 fixes to the v2.7 draft SQL (reservation rounding, same-key lock, purpose in identity, usage-report repeats, voice exchange retry release, voice quota recheck at open, exchange 13 AR004): fold into docs/spec/sql and S4. Test IDs CM-16..CM-21 to record in TESTS.md. Docker Desktop is hung; harness ran on OrbStack (DOCKER_CONTEXT=orbstack).
- deps-policy fixed on main (579f327).

## Merges and ports (2026-10-09)
- WP-01 scaffold merged into main (0237c86): self Codex CORRECT, cold Codex CORRECT after 3 rounds (D-015 allowlist cna-guardian only; conftest under mypy and bandit; two S603 suppressions accepted as verified false positives).
- Web branch 7e1bd0a: voice machine on v2.7 exchange lines[]; confirmation cold gate running.
- Port agents (normal, addressable): WP-08 scenario engine to v2.7 + verifier fixes (id ae0097c07b1dec950, wt-wp08); WP-03 migrations to v2.7 + harness fixes (id a73ac65007530d4a6, wt-wp03). Other agent ids: web aadec2824ba80c8be, scaffold a7856425e128d71bd, seeds a735e3ef1d8570e23, spec ae6c4a65789796395.

## SPEC GREEN (2026-10-09)
- Codex spec round 6: GREEN in every session (spec v2.7, 7911a78 + b66e881). Dev cases F01-F09 merged (b3e4fc5), green under v2.5 CX rules.
- Next: port WP-08 and WP-03 to v2.7 (new normal agents; workflow agents are not addressable), WP-01 scaffold fix in progress, web voice rebuild in progress; then WP-02 contracts and the build waves.

## Wave 2 landed (2026-10-09)
- WP-01 `feat/wp01-scaffold` 218fb65: Codex self-gate CORRECT after 11 rounds (gates hardened against every bypass found); make check green (743 tests, 95.76%); verifier PASS (4 lows). Cold Codex gate running; merge on CORRECT.
- WP-08 `feat/wp08-scenario` 05eb56e and WP-03 `feat/wp03-db` 4093286: both Codex CORRECT and gates green, but verifiers FAIL (blocker): built on spec v2.1/v2.2; main is v2.6. Need a port to v2.6 (after Codex round 5), plus WP-08 findings (case IDs derivable from the sampler seed; canaries computable without a secret; untested load/validator branches) and WP-03 findings (plain-PG path really runs the Supabase image; db_test.sh untested; skip/todo regex misses qualified calls). Spec should record CM-14..CM-19.
- Spec v2.6 committed (5ceb21b); Codex spec round 5 running.

## Spec v2.5 (2026-10-09)
- 5e54a22: Codex round 3 fixed (24/25); voice is display-only (exchanges stored by arena-subject, no turns or work items); debrief envelope one function; 87 SQL smoke assertions green. Codex spec round 4 running (scratchpad codex/spec4).
- Sent back: web agent rebuilds the voice machine to v2.5; seed agent fixes F02 r:02 (SG1-30) and re-checks all nine families under v2.5 rules.
- OWNER DECISION PENDING (rate-limit setting, needs approval): per-user daily spend cap $3.00 is below the voice whole-session hold $3.39 (cost_model VOICE_RESERVATION at byte limits), so every voice session is refused. Options: raise the cap to >= $3.40, or remove the per-user cap (one team operator, D-016).

## Web cold gate round 2 (2026-10-09)
- feat/web-foundation at 5f998d9: lint restrictions added (72 fixtures), semver exclusion removed, source-map-js age exclusion kept as a verified expiring exception (security patch, expires 2026-10-15). Cold Codex round 2: ISSUES-FOUND, softening no: voice machine follows the superseded voice protocol (exchange frame, draining on 4410, no resume after D-016). SSE/companion/lint pass. Hold the voice fix until spec v2.5 (voice simplification in progress with the spec agent), then send it to the web agent (aadec2824ba80c8be), cold-gate again, merge.

## Progress (2026-10-09 ~04:30 EDT)
- Spec v2.4 committed (1392310): 38 round-2 findings dispositioned (36 real, 2 removed under D-016); SQL 51 smoke assertions green. Codex spec round 3 running (scratchpad codex/spec3).
- Dev cases F01-F09 merged into main (8c03747): validators green on v2.4 schemas; Codex CX green per family under v2.3 rules (v2.4 tightened CX-2 to all account facts: re-run later).
- Web branch: cold Codex red (lint restrictions missing; dependency exceptions); sent back to the same agent (aadec2824ba80c8be). Reducer/controller/wire validation deferred to WP-18 part 2.
- Disk: Data volume 98% full (8.7 GB free); this session uses ~1 GB; most is other projects (PangeaChat 12 GB in /private/tmp). Do not delete other projects' data; owner to free space.

## Resumed work (2026-10-09, owner: 25% usage left, continue; D-016 local demo, keep simple)
- Normal agents (addressable with SendMessage for red-protocol follow-ups): web fix (wt-web: SSE stream-end retry major + 2 minors, self Codex gate) id aadec2824ba80c8be; seeds F01-F03 to CX green + sync into wt-cases id a735e3ef1d8570e23; spec round-2 majors with D-016 simplification id ae6c4a65789796395.
- Still running: wave 2 workflow `w8o2onnit` (WP-01 gate, WP-08, WP-03).

## Web foundation (2026-10-09 ~03:10 EDT)
- Branch `feat/web-foundation` 49fe031: Vite/React/TS strict, ticketed SSE client, voice machine, companion FSM; pnpm check green (501 tests, 100% coverage on src/lib, build OK, audit clean); agent Codex self-gate CORRECT after 14 rounds.
- Independent verifier: FAIL on one major: ticketed-stream counts the server's normal 600 s stream end (S5 6.4) as a failure, so retries run out on a healthy long session; plus 2 minors (stale comment on rejected-frame cursor; celebrating one-shot seeded from an already-ready session). Fix after 07:00 (red-to-root-cause: a clean server close is not an error), then my cold Codex gate and merge.
- Spec note from the agent: S5 7.3 voice frames lack question-to-answer correlation; recommend an utterance count on investigator transcription frames (add to the round-2 fix list).

## Dev cases (2026-10-09 ~02:55 EDT)
- Case workflow done (18/18 agents). F04-F09 green on validators + Codex CX + skeptic (F04 and F09 fixed after skeptic findings); committed on branch `data/dev-cases` (9fd1dd2) as a checkpoint. F01-F03 copies held back: Codex CX-1 still finds seed defects (F01 doc-02 vs f:24, l:01 label; F02 f:14 timing and HOLD leak; F03 x:03, FREE f:03/f:04 leak g:02). Spec v2.3 (a3ca7e9) already changed the seeds for some of these; after 07:00 re-sync seeds, fix the rest in the spec, re-run check.py, then cold Codex gate and merge.

## Codex spec round 2 (2026-10-09 ~02:30 EDT)
- YELLOW, RED, RED, RED: 4 blockers, 35 majors (down from ~60). Recorded in `docs/spec/review-codex-r2.md`. Fixes queued for after 07:00 (hold).

## Latest (2026-10-09 ~01:45 EDT)
- Spec fix round 1 complete (4/4 fixers; 109 dispositions in `docs/spec/review-codex-r1.md`); spec v2.3 committed (a3ca7e9, de3524d). LIMITS now byte-bounded per D11 (subject 80k, card/deep/final 128k, referee 160k bytes); conservative sim for 30 cases now 12/15 blocks (expected complete); direction 8.2 table updated; tuning deferred (D-013).
- Codex spec round 2 running (bg `b9mnxieqt`, 4 sessions; outputs scratchpad `codex/spec2/`). Codex CLI is not a workflow (owner's no-new-workflow rule respected).
- Still running: cases `waitahbsj`, wave 2 `w8o2onnit`, web `wyuftupho`.

## Owner directives 2026-10-09 ~01:20 EDT
- D-015: GCP project `cna-guardian` for Vertex (API enabled, ADC present; billing status unreadable here). Pass it explicitly; never touch the gcloud default.
- No new workflows until tomorrow's usage refresh; do not stop anything running. Only record results and commit finished work until then.

## Resumed 2026-10-09 01:15 EDT (usage limit reset 01:10)
- The limit stopped: fix:S6-S8, web build, authors F06-F09 + final, and all three wave-2 agents. All four workflows relaunched with resumeFromRunId (completed agents cached): spec fix `widpqyalk`, cases `waitahbsj`, wave 2 `w8o2onnit`, web `wyuftupho`. Web and wave-2 prompts carry a resume note.
- Spec v2.3 for S1-S5, schemas, seeds, SQL committed (a3ca7e9) before resuming.
- Follow-up: the case kit's calibration found CX-1 seed defects (F01 doc-02 door policy vs f:24; F02 f:14 vs rec-04; F03 x:03 not established false). Check which the S1 fixer closed; fix the rest and re-sync F01-F03 into cases/dev.
- Durable backup of pre-limit state: `~/arena-checkpoint/2026-10-08-2335/`.

## Where things stand
- **Direction** v10.4 (D-013, D-014): 30 hidden cases baseline (~$44 / ~$66, complete), 34 pilot-gated; one global spend ceiling $74; case families authored offline by Claude agents + Codex.
- **UI direction** v2.1: GREEN (Codex UI round 2). Awaits owner review and DESIGN.md.
- **Spec** v2.1/v2.2 committed (1ad3222): S1 reconciled, X-02..X-17 resolved, D-013/D-014 applied; SQL re-applied on fresh PG16 with all smokes passing. Codex spec review round 1: RED, RED, RED, YELLOW (4 blockers, ~60 majors; `docs/spec/review-codex-r1.md`). Fix workflow running with 11 shared decisions (D1-D11) so all parts implement one contract.
- **Code:** WP-01 scaffold on branch `feat/wp01-scaffold` (7e484f4, pre-gate; make check green, 10 gateproofs). Main tree cleaned (backup in scratchpad `backup-wp01/`).
- **Supabase:** project `fzjgcwkvveetegpngujr`, PostgreSQL 17.11, empty (no tables, no migrations); pgtap 1.3.3 and dblink available. Harness targets PG17.
- **GCP:** `cna-guardian` (D-015); no Vertex call made yet; GCP spend $0.

## Owner directive (2026-10-08 ~21:50, D-013)
- Build the pipeline end to end first; cost tuning later; one global $74 ceiling keeps the $75 cap; keep it simple; get Codex to GREEN on the spec.
- Owner decisions still open: 30 vs 34 cases (OD-8), volunteers (OD-7), GCP project (never `kbg-production`; the workstation gcloud default IS kbg-production, so never call gcloud without an explicit project), Supabase project, DESIGN.md, repo destination, voice exception rule, A2A track, team roster, plugin installs, pet name.

## Owner directives (2026-10-08 ~22:10)
- D-014: case families authored once by Claude agents + Codex review; Gemini 3.1 Pro dropped; other models kept.
- Supabase project `fzjgcwkvveetegpngujr` (owner-provided). Supabase MCP added at **project scope only** (`.mcp.json`, server name `supabase`); user-scope MCP config untouched so the owner's other project keeps its own Supabase. Owner approved and logged in; tools work in this session (verified: project URL https://fzjgcwkvveetegpngujr.supabase.co; database empty, no tables, no migrations). Destructive database operations through it need explicit owner approval.

## Active subagents / workflows
| agent_id | description | model | dispatched_at | expected_completion | output_path |
| --- | --- | --- | --- | --- | --- |
| task `wznwlwvt8` / run `wf_0246738e-32c` | Dev case authoring F04-F09 (kit -> 3 authors at a time -> skeptic/fix -> final commit) | Opus | 22:15 EDT | ~01:00 EDT | `/private/tmp/wt-cases`, branch `data/dev-cases` |
| task `wspgs42zb` / run `wf_20ff7f42-fb5` | WP-18 part 1 web foundation + independent verify | Opus | 22:18 EDT | ~00:00 EDT | `/private/tmp/wt-web`, branch `feat/web-foundation` |
| task `wr15p0y5x` / run `wf_9aced0c9-52d` | Wave 2: WP-01 self Codex gate; WP-08 scenario engine port; WP-03 migrations + PG17 pgTAP harness + capability fixture; verifier per branch | Opus x3 (+3 verifiers) | 22:23 EDT | ~01:00 EDT | `/private/tmp/wt-wp01`, `wt-wp08`, `wt-wp03` |
| task `w389ifutb` / run `wf_09e6717a-210` | Spec fix round 1: fix:S1, fix:S2-S3, fix:S4-SQL-S5 in parallel, then fix:S6-S8 against the final backend | Opus x4 | 22:40 EDT | ~00:30 EDT | main tree `docs/spec/**` |

## Next dispatch queue
1. Spec fix round 1 running -> Codex spec round 2 (4 sessions) -> repeat until GREEN. Then delta-port SQL changes into WP-03 and S1 changes into WP-08; re-sync F01-F03 seeds into cases/dev.
2. As each branch lands: cold Codex gate (independent) + re-run gates -> merge into main on CORRECT. Order: wp01 first, then wp03/wp08 (rebase onto main), web, cases.
3. Wave 3 after spec GREEN: WP-02 contracts (Pydantic + exported schemas + S3 adapter), WP-04 pgTAP suite (2 agents), WP-15 scorer, WP-10 prompts/manifests, WP-11 guard/relay/replay, WP-05 agent port + global guard client (fake model until GCP), WP-07 observability.
4. Apply migrations to Supabase after WP-03/WP-04 merge (role passwords are secret writes: owner authorization).
5. Hidden-family authoring (15) after spec GREEN, isolated, sealed.

## Standing facts
- Voice: gokbase/cloudforce use `gemini-3.1-flash-live-preview` on AI Studio (not on Vertex; shuts down 2026-11-17). Vertex GA Live models `gemini-3.8-live`, `gemini-live-2.5-flash-native-audio` may be allowlist-gated; day-1 probe needed.
- Gemini 2.5 retires on Vertex 2026-10-16 to 10-20; only 3.x remains; thinking floor MINIMAL.
- MCP servers needing reconnect or sign-in: context7, gcloud, github, cloud-run, observability, storage (failed); Sentry, mobbin, PostHog, Vercel (auth).

## Local commits ahead of origin
- No remote configured.

## Live infrastructure
- None.
