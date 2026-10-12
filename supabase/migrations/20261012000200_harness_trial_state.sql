-- WP-28: the tournament job's own in-flight reads of the trial it is executing (S5 5.3; S4 2.3, 5.5).
--
-- The harness reads back, between its own steps, what it just wrote: the turn's coach card (to relay or fall
-- back, S2 8.2), the released records' titles (the corpus script's evidence-slot question, S2 8.6), whether a
-- record was released after the previous exchange (A1's deep-update cadence, S2 4.4.1), whether a question is
-- open (S5 5.4), and the case's public packet (opening question, requestable records, replay topics). Until now
-- it read these through the arena_public projections, which are gated on `arena.trial_visible` (a dev trial,
-- or a revealed tournament's), so a running hidden trial's own writes were invisible to the job running it.
--
-- `arena.trial_visible` stays as it is: it decides what every projection, every recording export and the
-- tournament view show, and a hidden trial stays invisible there until reveal, for every caller (L7).
-- Instead, the job gets one function with the same reach `arena.trial_context` already gives an arena_public
-- harness request (the trial's own packet, releases and coaching, S4 Q1), narrowed in three ways:
--   * harness requests only: no `arena.actor_id` (S4 2.3) and a tournament trial (S4 5.5's caller separation);
--     an investigator request, any training trial and an unknown id are refused alike (AR040, no oracle);
--   * in flight only: the trial is `running`. Once it is finalized or terminated nothing is readable here, so
--     after the run nothing hidden reaches arena_public until reveal (S4 Q1, RR-27, RR-28);
--   * only what the harness decides with: released record ids, titles and exchange counts (never their
--     content), whether a question is open, and the coach_card / coach_unavailable events; no transcript text,
--     no subject answer, no deep update, no finding, nothing of the private or evaluator packet.
create or replace function arena.harness_trial_state(p_trial uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v arena.trials;
begin
  select * into v from arena.trials where id = p_trial;
  if v.id is null or v.kind = 'training' or arena.actor_id() is not null then
    raise exception using errcode = 'AR040', message = 'this request may not act on this trial';
  end if;
  if v.status <> 'running' then
    raise exception using errcode = 'AR001',
      message = format('trial is %s: its state is readable only while the trial runs', v.status);
  end if;
  return jsonb_build_object(
    'trial_id', v.id, 'kind', v.kind, 'transcript_version', v.transcript_version, 'exchanges', v.exchanges,
    'public_packet', coalesce((select packet from arena.public_packets where variant_id = v.variant_id),
                              (select packet from sealed.hidden_public_packets where variant_id = v.variant_id)),
    'open_question', exists (select 1 from arena.turns where trial_id = v.id and answer is null),
    'released', coalesce((select jsonb_agg(jsonb_build_object('record_id', record_id, 'title', title,
                                                              'released_after_exchanges', released_after_exchanges)
                                           order by release_seq)
                            from arena.released_evidence where trial_id = v.id), '[]'::jsonb),
    'coach_events', coalesce((select jsonb_agg(jsonb_build_object('seq', seq, 'kind', kind, 'turn_no', turn_no,
                                                                  'payload', payload) order by seq)
                                from arena.trial_events
                               where trial_id = v.id and kind in ('coach_card', 'coach_unavailable')), '[]'::jsonb));
end $$;

revoke all on function arena.harness_trial_state(uuid)
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
grant execute on function arena.harness_trial_state(uuid) to arena_public;
