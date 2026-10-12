-- WP-seal-prep: a revealed hidden tournament's trials 404 on GET /api/trials/{id}/recording and
-- scripts/export_run.py. `ArenaDb.public_packet` (arena.v_dev_cases) resolves only the dev split, so
-- `arena_core.events.load.load_trial`/`load_tournament_trial` fall back to an empty packet for every hidden
-- variant, revealed or not; `load_recording` then answers 404 for a revealed hidden trial the same as an
-- unknown id, even though `arena.trial_visible` already says the trial's own content (transcripts, released
-- evidence, events, findings) is visible (S4's `arena.v_transcripts`/`v_released_evidence`/`v_trial_events`/
-- `v_findings`, all gated on `arena.trial_visible`). This migration gives the hidden variant's PUBLIC packet
-- (`sealed.hidden_public_packets`; `arena_public` has no grant on schema `sealed` at all, RR-01..15) the same
-- rule: visible once SOME trial on that variant is visible, never before (SCN-12).
--
-- A hidden variant's packet cannot simply join `arena.trial_visible(t.id)` for one specific trial (a packet is
-- keyed by variant, not by trial), so the view below exposes a packet row once ANY trial on its variant is
-- visible -- in practice this is "the variant's tournament has been revealed" (hidden-split variants are
-- never used by a training trial, D-014; `arena.trial_visible`'s own rule for a non-training trial is exactly
-- `tr.split = 'dev' or tr.status = 'revealed'`, and a hidden variant's tournament is never `dev`-split).
--
-- Standard view-ownership security (no `security_invoker`): this view, owned by the migration role, may read
-- `sealed.hidden_public_packets` and `arena.trials` for its own WHERE clause even though `arena_public` (the
-- only role granted SELECT on the view itself, below) holds no grant on either -- the same pattern every
-- other arena_public projection view in 0004 already relies on (`arena.v_transcripts` reading `arena.turns`,
-- `ledger.v_commitments` calling `arena.trial_visible` over `ledger.finding_commitments`).
create view arena.v_hidden_cases with (security_barrier = true) as
  select p.variant_id, p.packet as public_packet
    from sealed.hidden_public_packets p
   where exists (select 1 from arena.trials t where t.variant_id = p.variant_id and arena.trial_visible(t.id));

revoke all on arena.v_hidden_cases
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
grant select on arena.v_hidden_cases to arena_public;
