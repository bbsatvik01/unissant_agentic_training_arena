# State

- **Date:** 2026-10-08, ~22:25 EDT
- **Branch:** `main` (local only, no remote yet)
- **Phase:** 1, build started (D-013). GCP spend $0. Deadline 2026-11-02 (D-005); slice gate 2026-10-18.

## HOLD 2 (owner directive 2026-10-09 ~01:50 EDT)
- No new agents or workflows. Do not stop anything running; let it finish. Usage refreshes ~07:00 EDT.
- Workflow agents cannot be messaged mid-run, and usage percentage is not readable from this session. If the limit stops them, their committed work and cached agent results survive; resume each with `Workflow({scriptPath, resumeFromRunId})` after 07:00 (runs: cases wf_0246738e-32c, wave 2 wf_9aced0c9-52d, web wf_20ff7f42-fb5).
- Durable checkpoint 2: `~/arena-checkpoint/2026-10-09-0150/` (worktrees, branch commit lists, dirty-file lists, scratchpad). At checkpoint: wt-wp01 6 commits, wt-wp03 4, wt-wp08 3 (each with a few uncommitted files); wt-cases and wt-web uncommitted in progress.

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
