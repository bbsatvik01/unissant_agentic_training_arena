-- =============================================================================
-- 20261008000200_cases.sql  (spec S4 v2.7; ported unchanged in substance from docs/spec/sql/0002_cases.sql, WP-03)
-- Case families and variants (public tier, no role), packets in three tiers, evidence
-- artifacts with release predicates, the hidden-split seal, the candidate registry.
-- Requirements: SCN-1, SCN-4, SCN-7, SCN-8, SCN-9, SCN-10, SCN-11, SCN-12, AST-5, BKO-5.
--
-- Seal pattern adapted from TechnoMile supabase/migrations/20260928001100_holdout_scoring.sql
-- lines 16-24 and 119-142 (hash of sorted ids, recomputed inside Postgres, append-only rows).
-- Every content table is immutable once written: a case can be added, never edited. A development
-- family is revised by ingesting the revision under a new family_code that supersedes it (SG1-11).
-- Sizes are serialized UTF-8 bytes of the jsonb text (octet_length(x::text)), the size that reaches a
-- prompt or a wire frame, not the compressed storage size (SG1-14).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Public tier (arena). No role column anywhere in this schema (SCN-5).
-- -----------------------------------------------------------------------------
create table arena.case_families (
  id          uuid primary key default gen_random_uuid(),
  family_code text not null unique check (family_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  domain      text not null check (length(domain) between 1 and 100),
  split       text not null check (split in ('dev', 'hidden')),
  created_at  timestamptz not null default now()
);

create table arena.case_variants (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references arena.case_families(id) on delete restrict,
  -- variant_code = the variant's opaque case_id (S1 loader rule L3; public-packet.schema.json
  -- caseId pattern). The shape check means a loader bug cannot write a role word here (C-25).
  variant_code text not null check (variant_code ~ '^C-[0-9A-HJKMNP-TV-Z]{8}$'),
  -- style factors (pace, register, recall confidence, ...) assigned by factorial design,
  -- independent of role (SCN-3, SCN-11, PRB-4)
  style        jsonb not null check (jsonb_typeof(style) = 'object'),
  difficulty   smallint not null check (difficulty between 1 and 5),
  created_at   timestamptz not null default now(),
  unique (family_id, variant_code)
);
create index case_variants_family_idx on arena.case_variants (family_id);

-- Public packets of DEVELOPMENT variants (SCN-7). Hidden variants keep theirs in
-- sealed.hidden_public_packets until a running trial projects them (arena.trial_context).
-- packet: {case_id, objective, known_timeline, initial_documents, interview_context,
--          requestable_records: [{record_id, title}]}
create table arena.public_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and octet_length(packet::text) <= 65536),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

-- -----------------------------------------------------------------------------
-- Subject-private tier (SCN-8): role, actions, knowledge, disclosable facts, concealed
-- facts, uncertainty limits, objective, permitted behaviors, disclosure gates, style.
-- -----------------------------------------------------------------------------
create table subject.private_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and octet_length(packet::text) <= 65536),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

-- -----------------------------------------------------------------------------
-- Evaluator-only tier (SCN-9)
-- -----------------------------------------------------------------------------
create table sealed.evaluator_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  role       text not null check (role in ('truthful', 'deceptive')),
  -- canonical event facts (atomic fact ids), material contradictions, resolution criteria, rubric
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and octet_length(packet::text) <= 131072),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

create table sealed.hidden_public_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and octet_length(packet::text) <= 65536),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

-- Evidence artifacts and their deterministic release predicates (SCN-4, SCN-10). Replaces
-- the direction's separate release_predicates table: one row carries the content and the
-- predicate, so a predicate can never point at a missing artifact.
--   scheduled_turn:     released automatically once that many exchanges are complete
--   request_after_turn: releasable on request once that many exchanges are complete
-- Exactly one of the two is set (S1 6.2). record_id: S1 rec-NN (initial documents doc-NN stay in the
-- public packet; C-16). doc_kind: S1's document kind (public-packet.schema.json $defs.artifactKind), so
-- the evidence board keeps it (C-24); kind is the release behaviour and follows doc_kind (S1 4.4).
-- Content is at most 12,288 bytes serialized, so the evidence_released event that carries it stays
-- under the 14,336-byte event payload limit and every SSE delta under 16 KiB (SG1-14, D9). Ingest
-- refuses a row that differs from the evaluator packet's releasable record (SG1-09).
create table sealed.evidence_artifacts (
  variant_id         uuid not null references arena.case_variants(id) on delete restrict,
  record_id          text not null check (record_id ~ '^rec-0[1-6]$'),
  kind               text not null check (kind in ('record', 'clarification', 'context_change')),
  doc_kind           text not null check (doc_kind in (
                       'access_exception_report', 'badge_log', 'door_log', 'sensor_metadata', 'camera_metadata',
                       'camera_status', 'alarm_log', 'monitor_alert', 'dispatch_log', 'work_order', 'staffing_note',
                       'visitor_register', 'lockbox_log', 'credential_record', 'access_change_notice', 'incident_ticket',
                       'seal_audit', 'witness_statement', 'supervisor_statement', 'email', 'policy_excerpt',
                       'procedure_excerpt', 'facilities_notice', 'clarification', 'context_change')),
  title              text not null check (length(title) between 1 and 200),
  content            jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 12288),
  sha256             text not null generated always as (ledger.hash_jsonb(content)) stored,
  requestable        boolean not null,
  scheduled_turn     smallint check (scheduled_turn between 0 and 12),
  request_after_turn smallint check (request_after_turn between 0 and 12),
  primary key (variant_id, record_id),
  constraint evidence_predicate_shape check (
    scheduled_turn is not null or (requestable and request_after_turn is not null)),
  constraint evidence_request_shape check (requestable = (request_after_turn is not null)),
  constraint evidence_one_predicate check ((scheduled_turn is null) <> (request_after_turn is null)),
  constraint evidence_kind_follows_doc_kind check (kind = case doc_kind when 'clarification' then 'clarification'
                                                                         when 'context_change' then 'context_change'
                                                                         else 'record' end)
);

-- Bundle hash per ingested family (idempotent re-ingest check) and the sealed authoring archive (S1 10.5).
-- SG1-08, SG1-19: one archive shape across S1 and SQL. `source` is the accepted family file as canonical
-- JSON text (S1 8.4) and `attestation` is S1 10.5's object {family_id, revision, family_sha256,
-- validator_version, checks_passed, codex}. Ingest checks that the text hashes to the attested
-- family_sha256, that every required check and every Codex result passed, and that the bundle's variants
-- are exactly the family file's variants (same case ids, roles and three packets), so the archive cannot
-- carry a file other than the one whose packets run. Reports outside the sealed tier stay codes and counts.
create table sealed.family_ingests (
  family_id      uuid primary key references arena.case_families(id) on delete restrict,
  bundle_sha256  text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  source         text not null check (octet_length(source) <= 524288),
  source_sha256  text not null generated always as (ledger.hash_text(source)) stored,
  attestation    jsonb not null check (jsonb_typeof(attestation) = 'object' and octet_length(attestation::text) <= 65536),
  created_at     timestamptz not null default now()
);

-- Development family revisions (SG1-11, SG1-22). A revised family is ingested under a new family_code
-- (for example F01.r2) whose bundle names, in `supersedes`, the active family it replaces; the old family
-- is retired here in the same transaction, and ingest is the only writer. A revision (family file
-- revision >= 2) without the right `supersedes`, or a `supersedes` on revision 1, is refused. A family
-- holding a KPI-1 case-set member is never revised (SG1-23): the study's fixed sets stay valid. Retired families leave the case library (arena.v_dev_cases), new sessions and new
-- tournament rosters; trials that already ran keep their variant ids and packets. Hidden families are
-- never revised (the split is sealed whole).
create table arena.family_retirements (
  family_id     uuid primary key references arena.case_families(id) on delete restrict,
  superseded_by uuid not null references arena.case_families(id) on delete restrict,
  retired_at    timestamptz not null default now(),
  constraint retirement_not_self check (family_id <> superseded_by)
);

-- The hidden split is sealed once, before any tournament on it freezes (SCN-12). The seal stores the
-- split's sampler record (S1 10.5) and publishes its hash beside the digest (SG1-19).
create table sealed.hidden_split_seals (
  id              uuid primary key default gen_random_uuid(),
  seal_sha256     text not null check (seal_sha256 ~ '^[0-9a-f]{64}$'),
  n_families      integer not null check (n_families > 0),
  n_variants      integer not null check (n_variants > 0),
  sampler_record  jsonb not null check (jsonb_typeof(sampler_record) = 'object'
                                        and sampler_record ?& array['seed', 'n', 'assignment', 'max_phi']
                                        and octet_length(sampler_record::text) <= 65536),
  sampler_sha256  text not null generated always as (ledger.hash_jsonb(sampler_record)) stored,
  created_at      timestamptz not null default now()
);
create unique index hidden_split_seals_one on sealed.hidden_split_seals ((true));

-- -----------------------------------------------------------------------------
-- Candidate registry (AST-5, BKO-5): an immutable version per row, hashed.
-- -----------------------------------------------------------------------------
-- kind: S2 manifest.v1's four kinds (C-47). Only assistant and subject candidates fill tournament
-- slots (arena.add_planned_trials) and training sessions (training.start_session); referee and
-- negative_control versions are registered so their manifests are hashed and auditable.
create table arena.candidates (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('assistant', 'subject', 'referee', 'negative_control')),
  name       text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  version    text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- S2 3.1 manifest.v1: every top-level key present (fields that do not apply are null);
  -- kind, candidate_id and version agree with the row.
  manifest   jsonb not null check (jsonb_typeof(manifest) = 'object'),
  sha256     text not null generated always as (ledger.hash_jsonb(manifest)) stored,
  created_at timestamptz not null default now(),
  unique (kind, name, version),
  constraint candidate_manifest_keys check (
    manifest ?& array['manifest_version', 'candidate_id', 'kind', 'display_name', 'version', 'official', 'transport',
                      'model', 'prompt', 'tools', 'coaching_policy', 'subject_policy', 'limits', 'repair', 'sampling',
                      'lineage']
    and manifest ->> 'manifest_version' = 'manifest.v1'
    and manifest ->> 'kind' = kind
    and manifest ->> 'candidate_id' = name
    and manifest ->> 'version' = version
    and jsonb_typeof(manifest -> 'limits') = 'object'
    and (kind <> 'assistant' or jsonb_typeof(manifest -> 'coaching_policy') = 'object')
    and (kind <> 'subject' or jsonb_typeof(manifest -> 'subject_policy') = 'object'))
);

-- -----------------------------------------------------------------------------
-- Immutability and tier-placement guards
-- -----------------------------------------------------------------------------
create trigger case_families_immutable before update or delete on arena.case_families
  for each row execute function arena.tg_forbid_mutation();
create trigger case_variants_immutable before update or delete on arena.case_variants
  for each row execute function arena.tg_forbid_mutation();
create trigger public_packets_immutable before update or delete on arena.public_packets
  for each row execute function arena.tg_forbid_mutation();
create trigger private_packets_immutable before update or delete on subject.private_packets
  for each row execute function arena.tg_forbid_mutation();
create trigger evaluator_packets_immutable before update or delete on sealed.evaluator_packets
  for each row execute function arena.tg_forbid_mutation();
create trigger hidden_public_packets_immutable before update or delete on sealed.hidden_public_packets
  for each row execute function arena.tg_forbid_mutation();
create trigger evidence_artifacts_immutable before update or delete on sealed.evidence_artifacts
  for each row execute function arena.tg_forbid_mutation();
create trigger family_ingests_immutable before update or delete on sealed.family_ingests
  for each row execute function arena.tg_forbid_mutation();
create trigger family_retirements_immutable before update or delete on arena.family_retirements
  for each row execute function arena.tg_forbid_mutation();
create trigger hidden_split_seals_immutable before update or delete on sealed.hidden_split_seals
  for each row execute function arena.tg_forbid_mutation();
create trigger candidates_immutable before update or delete on arena.candidates
  for each row execute function arena.tg_forbid_mutation();

-- A public packet lives in arena only for dev variants, in sealed only for hidden ones.
create or replace function arena.tg_packet_split() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_split text;
begin
  select f.split into v_split
    from arena.case_variants v join arena.case_families f on f.id = v.family_id
   where v.id = new.variant_id;
  if (tg_table_schema = 'arena' and v_split <> 'dev') or (tg_table_schema = 'sealed' and v_split <> 'hidden') then
    raise exception using errcode = 'AR001',
      message = format('%s.%s holds %s packets only', tg_table_schema, tg_table_name,
                       case tg_table_schema when 'arena' then 'dev' else 'hidden' end);
  end if;
  return new;
end $$;
create trigger public_packets_dev_only before insert on arena.public_packets
  for each row execute function arena.tg_packet_split();
create trigger hidden_public_packets_hidden_only before insert on sealed.hidden_public_packets
  for each row execute function arena.tg_packet_split();

-- -----------------------------------------------------------------------------
-- Seal digest (SG3-08, SG1-09). One line per hidden variant:
--   family_code:variant_code:sha256(canonical jsonb of the variant's whole case material)
-- The canonical jsonb holds everything an interview or the scoring consumes: the family row (code,
-- domain, split), the variant row (code, style, difficulty), the three packets, the role, and every
-- artifact row in full (record_id, kind, doc_kind, title, content, requestable, scheduled_turn,
-- request_after_turn), and the family's archive (the sha256 of the accepted family file text and the
-- attestation, SG1-19). Every hash is recomputed from stored values; no stored hash column is read. The
-- seal is the sha256 of the lines sorted by code point and joined by newlines.
-- -----------------------------------------------------------------------------
create or replace function sealed.hidden_split_digest()
returns table (seal_sha256 text, n_families integer, n_variants integer)
language sql stable security definer set search_path = '' as $$
  with lines as (
    select f.family_code || ':' || v.variant_code || ':' || ledger.hash_jsonb(jsonb_build_object(
             'family', jsonb_build_object('family_code', f.family_code, 'domain', f.domain, 'split', f.split),
             'variant', jsonb_build_object('variant_code', v.variant_code, 'style', v.style, 'difficulty', v.difficulty),
             'public_packet', hp.packet, 'private_packet', pp.packet, 'role', ep.role, 'evaluator_packet', ep.packet,
             'artifacts', coalesce((select jsonb_agg(to_jsonb(a) - 'variant_id' - 'sha256' order by a.record_id collate "C")
                                      from sealed.evidence_artifacts a where a.variant_id = v.id), '[]'::jsonb),
             'archive', jsonb_build_object('source_sha256', ledger.hash_text(i.source), 'attestation', i.attestation))) as line,
           f.id as family_id
      from arena.case_families f
      join arena.case_variants v on v.family_id = f.id
      join sealed.hidden_public_packets hp on hp.variant_id = v.id
      join subject.private_packets pp on pp.variant_id = v.id
      join sealed.evaluator_packets ep on ep.variant_id = v.id
      join sealed.family_ingests i on i.family_id = f.id
     where f.split = 'hidden'
  )
  select ledger.hash_text(string_agg(line, E'\n' order by line collate "C")),
         count(distinct family_id)::integer, count(*)::integer
    from lines
$$;

-- -----------------------------------------------------------------------------
-- ingest_case_family (arena_referee). One transaction writes every tier of one family.
-- bundle: {family_code, domain, split, supersedes (dev revisions >= 2 only), source (family file text),
--          attestation,
--          variants: [{variant_code, style, difficulty, role, public_packet, private_packet, evaluator_packet,
--          artifacts: [{record_id, kind, doc_kind, title, content, requestable, scheduled_turn,
--                       request_after_turn}]}]}   (S1 4.4; doc_kind is S1's artifactKind, C-24)
-- Refuses: a hidden family after the seal (AR001); a family without both roles (SCN-11, AR007); more
-- than 6 artifacts on a variant (MAX_RELEASES, AR006); artifact rows that differ from the evaluator
-- packet's releasable records, or a public requestable list that differs from the requestable rows
-- (SG1-09, AR007); an archive that does not match (SG1-19, AR007: source not a family file whose
-- family_id, revision, split and domain give this family_code; attestation hash not the source's sha256;
-- a required check or Codex result missing or not pass; bundle variants other than the file's variants);
-- a revision whose supersedes is missing, wrong or not active, or names a KPI-1 case-set family
-- (SG1-11, SG1-22, SG1-23, AR007); a re-ingest with different content (AR003). An identical re-ingest
-- returns the existing id.
-- Hidden ingests and seal_hidden_split serialize on the seal table (SG3-09, SG1-10): an ingest takes it
-- in SHARE mode before it checks for the seal, the seal takes it in EXCLUSIVE mode, so an ingest that
-- passed its check commits before the seal reads the split, and an ingest that starts after the seal
-- waits for it and is refused.
-- -----------------------------------------------------------------------------
create or replace function sealed.ingest_case_family(p_bundle jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_sha      text := ledger.hash_jsonb(p_bundle);
  v_family   uuid;
  v_variant  uuid;
  v_split    text := p_bundle ->> 'split';
  v_var      jsonb;
  v_art      jsonb;
  v_existing text;
  v_old      arena.case_families;
  v_src      jsonb;
  v_att      jsonb;
  v_rev      integer;
begin
  perform ledger.require_read_committed();
  if jsonb_typeof(p_bundle) is distinct from 'object' or jsonb_typeof(p_bundle -> 'variants') is distinct from 'array' then
    raise exception using errcode = 'AR007', message = 'bundle must be an object with a variants array';
  end if;
  if v_split = 'hidden' then
    lock table sealed.hidden_split_seals in share mode;
  end if;
  select f.id, i.bundle_sha256 into v_family, v_existing
    from arena.case_families f join sealed.family_ingests i on i.family_id = f.id
   where f.family_code = p_bundle ->> 'family_code';
  if found then
    if v_existing = v_sha then
      return v_family;
    end if;
    raise exception using errcode = 'AR003', message = 'family_code reused with different content';
  end if;
  if v_split = 'hidden' and exists (select 1 from sealed.hidden_split_seals) then
    raise exception using errcode = 'AR001', message = 'the hidden split is sealed; no hidden family can be added';
  end if;
  if (select count(distinct x ->> 'role') from jsonb_array_elements(p_bundle -> 'variants') x
       where x ->> 'role' in ('truthful', 'deceptive')) <> 2 then
    raise exception using errcode = 'AR007', message = 'a family needs matched truthful and deceptive variants (SCN-11)';
  end if;
  -- SG1-19: the archive is the family file whose packets run, attested as passed.
  if jsonb_typeof(p_bundle -> 'source') is distinct from 'string' then
    raise exception using errcode = 'AR007', message = 'source is the family file text';
  end if;
  begin
    v_src := (p_bundle ->> 'source')::jsonb;
  exception when others then
    raise exception using errcode = 'AR007', message = 'source is not JSON';
  end;
  v_att := p_bundle -> 'attestation';
  v_rev := case when jsonb_typeof(v_src -> 'revision') = 'number' then (v_src ->> 'revision')::integer end;
  if jsonb_typeof(v_src) is distinct from 'object' or v_rev is null or v_rev < 1
     or jsonb_typeof(v_att) is distinct from 'object'
     or not (v_att ?& array['family_id', 'revision', 'family_sha256', 'validator_version', 'checks_passed', 'codex'])
     or v_att ->> 'family_sha256' is distinct from ledger.hash_text(p_bundle ->> 'source')
     or v_att ->> 'family_id' is distinct from v_src ->> 'family_id'
     or v_att -> 'revision' is distinct from v_src -> 'revision'
     or p_bundle ->> 'family_code' is distinct from
        ((v_src ->> 'family_id') || (case when v_rev >= 2 then '.r' || v_rev::text else '' end))
     or v_split is distinct from v_src ->> 'split' or p_bundle ->> 'domain' is distinct from v_src ->> 'domain'
     or jsonb_typeof(v_att -> 'checks_passed') is distinct from 'array'
     or not (v_att -> 'checks_passed' @> '["V1", "V1b", "V1c", "V1d", "V2", "V3a", "V4a", "V4b", "V4c", "V5"]'::jsonb)
     or jsonb_typeof(v_att #> '{codex,rounds}') is distinct from 'number'
     or (v_att #>> '{codex,rounds}')::numeric not between 1 and 5
     or (v_att #>> '{codex,review}', v_att #>> '{codex,cx2_truthful}', v_att #>> '{codex,cx2_deceptive}',
         v_att #>> '{codex,cx3}') is distinct from ('pass', 'pass', 'pass', 'pass') then
    raise exception using errcode = 'AR007', message = 'the archive must be the attested, passed family file (SG1-19)';
  end if;
  -- SG1-19, SG1-28: every operational field of a bundle variant comes from the file: case id, role, the three
  -- packets, and the family's style and difficulty level (S1 4.4 loader table).
  if (select coalesce(jsonb_agg(jsonb_build_object('code', x ->> 'variant_code', 'role', x ->> 'role',
                                                   'public', x -> 'public_packet', 'private', x -> 'private_packet',
                                                   'evaluator', x -> 'evaluator_packet', 'style', x -> 'style',
                                                   'difficulty', x -> 'difficulty')
                                order by x ->> 'variant_code' collate "C"), '[]'::jsonb)
        from jsonb_array_elements(p_bundle -> 'variants') x)
     is distinct from
     (select coalesce(jsonb_agg(jsonb_build_object('code', e.value ->> 'case_id', 'role', e.key,
                                                   'public', e.value -> 'public_packet', 'private', e.value -> 'private_packet',
                                                   'evaluator', e.value -> 'evaluator_packet', 'style', v_src -> 'style',
                                                   'difficulty', v_src #> '{difficulty,level}')
                                order by e.value ->> 'case_id' collate "C"), '[]'::jsonb)
        from jsonb_each(case when jsonb_typeof(v_src -> 'variants') = 'object' then v_src -> 'variants' else '{}'::jsonb end) e) then
    raise exception using errcode = 'AR007', message = 'bundle variants must be the family file''s variants (SG1-19)';
  end if;
  -- SG1-22: a revision names its active predecessor and replaces it here; revision 1 names none.
  if v_rev >= 2 then
    select * into v_old from arena.case_families where family_code = p_bundle ->> 'supersedes' for update;
    if v_split is distinct from 'dev' or v_old.id is null or v_old.split <> 'dev'
       or p_bundle ->> 'supersedes' is distinct from
          ((v_src ->> 'family_id') || (case when v_rev >= 3 then '.r' || (v_rev - 1)::text else '' end))
       or exists (select 1 from arena.family_retirements r where r.family_id = v_old.id) then
      raise exception using errcode = 'AR007', message = 'a revision supersedes its active predecessor (SG1-22)';
    end if;
    if exists (select 1 from training.case_set_members m join arena.case_variants cv on cv.id = m.variant_id
                where cv.family_id = v_old.id) then
      raise exception using errcode = 'AR007', message = 'a KPI-1 case-set family is never revised (SG1-23)';
    end if;
  elsif p_bundle ? 'supersedes' then
    raise exception using errcode = 'AR007', message = 'only a revision names supersedes (SG1-22)';
  end if;

  insert into arena.case_families (family_code, domain, split)
    values (p_bundle ->> 'family_code', p_bundle ->> 'domain', v_split)
    returning id into v_family;
  insert into sealed.family_ingests (family_id, bundle_sha256, source, attestation)
    values (v_family, v_sha, p_bundle ->> 'source', v_att);
  if v_old.id is not null then
    insert into arena.family_retirements (family_id, superseded_by) values (v_old.id, v_family);
  end if;

  for v_var in select * from jsonb_array_elements(p_bundle -> 'variants') loop
    if jsonb_array_length(coalesce(v_var -> 'artifacts', '[]'::jsonb)) > 6 then
      raise exception using errcode = 'AR006', message = 'at most 6 evidence artifacts per variant (MAX_RELEASES)';
    end if;
    insert into arena.case_variants (family_id, variant_code, style, difficulty)
      values (v_family, v_var ->> 'variant_code', v_var -> 'style', (v_var ->> 'difficulty')::smallint)
      returning id into v_variant;
    if v_split = 'dev' then
      insert into arena.public_packets (variant_id, packet) values (v_variant, v_var -> 'public_packet');
    else
      insert into sealed.hidden_public_packets (variant_id, packet) values (v_variant, v_var -> 'public_packet');
    end if;
    insert into subject.private_packets (variant_id, packet) values (v_variant, v_var -> 'private_packet');
    insert into sealed.evaluator_packets (variant_id, role, packet)
      values (v_variant, v_var ->> 'role', v_var -> 'evaluator_packet');
    for v_art in select * from jsonb_array_elements(coalesce(v_var -> 'artifacts', '[]'::jsonb)) loop
      insert into sealed.evidence_artifacts (variant_id, record_id, kind, doc_kind, title, content, requestable,
                                             scheduled_turn, request_after_turn)
        values (v_variant, v_art ->> 'record_id', v_art ->> 'kind', v_art ->> 'doc_kind', v_art ->> 'title', v_art -> 'content',
                (v_art ->> 'requestable')::boolean, (v_art ->> 'scheduled_turn')::smallint,
                (v_art ->> 'request_after_turn')::smallint);
    end loop;
    -- SG1-09: the executable rows equal the evaluator packet's releasable records (id, kind, title, content,
    -- predicate), and the public requestable list equals the requestable rows (id, kind, title, threshold).
    if (select coalesce(jsonb_agg(jsonb_build_object('id', a.record_id, 'kind', a.doc_kind, 'title', a.title, 'content', a.content,
                                                     'scheduled', a.scheduled_turn, 'on_request', a.request_after_turn)
                                  order by a.record_id collate "C"), '[]'::jsonb)
          from sealed.evidence_artifacts a where a.variant_id = v_variant)
       is distinct from
       (select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'artifact_id', 'kind', e ->> 'kind', 'title', e ->> 'title',
                                                     'content', e -> 'content',
                                                     'scheduled', case when e #>> '{release,type}' = 'scheduled'
                                                                       then (e #>> '{release,after_exchanges}')::integer end,
                                                     'on_request', case when e #>> '{release,type}' = 'on_request'
                                                                        then (e #>> '{release,after_exchanges}')::integer end)
                                  order by e ->> 'artifact_id' collate "C"), '[]'::jsonb)
          from jsonb_array_elements(coalesce(v_var #> '{evaluator_packet,evidence_artifacts}', '[]'::jsonb)) e
         where e #>> '{release,type}' in ('scheduled', 'on_request'))
       or
       (select coalesce(jsonb_agg(jsonb_build_object('id', a.record_id, 'kind', a.doc_kind, 'title', a.title,
                                                     'after', a.request_after_turn) order by a.record_id collate "C"), '[]'::jsonb)
          from sealed.evidence_artifacts a where a.variant_id = v_variant and a.requestable)
       is distinct from
       (select coalesce(jsonb_agg(jsonb_build_object('id', r ->> 'record_id', 'kind', r ->> 'kind', 'title', r ->> 'title',
                                                     'after', (r ->> 'requestable_after_exchanges')::integer)
                                  order by r ->> 'record_id' collate "C"), '[]'::jsonb)
          from jsonb_array_elements(coalesce(v_var #> '{public_packet,requestable_records}', '[]'::jsonb)) r) then
      raise exception using errcode = 'AR007',
        message = 'artifact rows must equal the evaluator packet''s releasable records and the public requestable list';
    end if;
  end loop;
  return v_family;
end $$;

-- sampler_matches (internal; SG1-29): the sampler record names exactly the sealed hidden families, once
-- each, and every assignment entry {family_id, violation_type, misleading_types, level, style} equals what
-- that family's archived file says (taxonomy, difficulty.level, style). n is the family count.
create or replace function sealed.sampler_matches(p jsonb)
returns boolean
language sql stable security definer set search_path = '' as $$
  with fam as (
    select i.source::jsonb as f from sealed.family_ingests i join arena.case_families c on c.id = i.family_id
     where c.split = 'hidden'),
  a as (select x from jsonb_array_elements(case when jsonb_typeof(p -> 'assignment') = 'array'
                                                then p -> 'assignment' else '[]'::jsonb end) x)
  select jsonb_typeof(p) = 'object' and p ?& array['seed', 'n', 'assignment', 'max_phi']
     -- SG1-33: a non-negative integer seed and a numeric max_phi within S1 7.5's accepted range (at most 0.40);
     -- the authoring session's validator recomputes phi from the assignment before calling the seal
     and jsonb_typeof(p -> 'seed') = 'number' and (p ->> 'seed')::numeric >= 0
     and (p ->> 'seed')::numeric = trunc((p ->> 'seed')::numeric)
     and jsonb_typeof(p -> 'max_phi') = 'number' and (p ->> 'max_phi')::numeric between 0 and 0.40
     and jsonb_typeof(p -> 'assignment') = 'array' and jsonb_typeof(p -> 'n') = 'number'
     and (p ->> 'n')::numeric = (select count(*) from fam)
     and (select count(*) from a) = (select count(*) from fam)
     and (select count(distinct x ->> 'family_id') from a) = (select count(*) from a)
     and not exists (
       select 1 from a
        where not exists (
          select 1 from fam
           where fam.f ->> 'family_id' = a.x ->> 'family_id'
             and a.x -> 'violation_type' = fam.f #> '{taxonomy,violation_type}'
             and a.x -> 'misleading_types' = fam.f #> '{taxonomy,misleading_types}'
             and a.x -> 'level' = fam.f #> '{difficulty,level}'
             and a.x -> 'style' = fam.f -> 'style'))
$$;

-- seal_hidden_split (arena_referee): once, over every hidden variant, with the split's sampler record
-- (S1 10.5: seed, n, assignment, max_phi; n must equal the sealed family count). Appends a ledger event
-- carrying the seal hash and the sampler record's hash (SG1-19).
create or replace function sealed.seal_hidden_split(p_sampler_record jsonb)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v record;
  v_id uuid;
  v_sampler_sha text;
begin
  perform ledger.require_read_committed();
  lock table sealed.hidden_split_seals in exclusive mode;
  if exists (select 1 from sealed.hidden_split_seals) then
    raise exception using errcode = 'AR001', message = 'the hidden split is already sealed';
  end if;
  select * into v from sealed.hidden_split_digest();
  if v.n_variants is null or v.n_variants = 0 then
    raise exception using errcode = 'AR001', message = 'no hidden variants to seal';
  end if;
  if not coalesce(sealed.sampler_matches(p_sampler_record), false) then
    raise exception using errcode = 'AR007', message = 'the sampler record must match exactly the sealed families (SG1-29)';
  end if;
  insert into sealed.hidden_split_seals (seal_sha256, n_families, n_variants, sampler_record)
    values (v.seal_sha256, v.n_families, v.n_variants, p_sampler_record) returning id, sampler_sha256 into v_id, v_sampler_sha;
  -- the seal hash is public: it is published before candidates freeze
  perform ledger.append_event('hidden_split_sealed', null, null,
    jsonb_build_object('seal_id', v_id, 'seal_sha256', v.seal_sha256, 'sampler_sha256', v_sampler_sha,
                       'n_families', v.n_families, 'n_variants', v.n_variants));
  return v.seal_sha256;
end $$;

-- verify_hidden_seal (SG3-39): the recomputed digest equals the stored seal, the stored sampler record still
-- matches the archive, and both the seal hash and the sampler hash recomputed from stored values equal the
-- public ledger commitment of that seal (its hidden_split_sealed event; the chain is verified separately), so
-- an owner edit with triggers disabled to the seal row or the sampler record is detected.
create or replace function sealed.verify_hidden_seal()
returns boolean
language plpgsql stable security definer set search_path = '' as $$   -- plpgsql: ledger.events is created in 0003
begin
  return coalesce((select s.seal_sha256 = d.seal_sha256 and s.n_variants = d.n_variants
                          and sealed.sampler_matches(s.sampler_record)
                          and exists (select 1 from ledger.events e
                                       where e.event_type = 'hidden_split_sealed'
                                         and e.payload ->> 'seal_id' = s.id::text
                                         and e.payload ->> 'seal_sha256' = d.seal_sha256
                                         and e.payload ->> 'sampler_sha256' = ledger.hash_jsonb(s.sampler_record))
                     from sealed.hidden_split_seals s, sealed.hidden_split_digest() d), false);
end $$;

-- register_candidate (arena_referee). Idempotent for an identical manifest. Checks the S2 3.1
-- manifest.v1 shape (C-47) and refuses a malformed manifest with AR007 before the table constraint.
create or replace function arena.register_candidate(p_kind text, p_name text, p_version text, p_manifest jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id  uuid;
  v_sha text;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object'
     or not (p_manifest ?& array['manifest_version', 'candidate_id', 'kind', 'display_name', 'version', 'official',
                                 'transport', 'model', 'prompt', 'tools', 'coaching_policy', 'subject_policy', 'limits',
                                 'repair', 'sampling', 'lineage'])
     or p_manifest ->> 'manifest_version' is distinct from 'manifest.v1'
     or (p_manifest ->> 'kind', p_manifest ->> 'candidate_id', p_manifest ->> 'version')
        is distinct from (p_kind, p_name, p_version)
     or jsonb_typeof(p_manifest -> 'limits') is distinct from 'object'
     or (p_kind = 'assistant' and jsonb_typeof(p_manifest -> 'coaching_policy') is distinct from 'object')
     or (p_kind = 'subject' and jsonb_typeof(p_manifest -> 'subject_policy') is distinct from 'object') then
    raise exception using errcode = 'AR007',
      message = 'manifest must be manifest.v1 with every key, matching kind, candidate_id and version';
  end if;
  select id, sha256 into v_id, v_sha from arena.candidates
   where kind = p_kind and name = p_name and version = p_version;
  if found then
    if v_sha = ledger.hash_jsonb(p_manifest) then
      return v_id;
    end if;
    raise exception using errcode = 'AR003', message = 'candidate version reused with a different manifest';
  end if;
  insert into arena.candidates (kind, name, version, manifest) values (p_kind, p_name, p_version, p_manifest)
    returning id into v_id;
  perform ledger.append_event('candidate_registered', null, null,
    jsonb_build_object('candidate_id', v_id, 'kind', p_kind, 'name', p_name, 'version', p_version,
                       'sha256', ledger.hash_jsonb(p_manifest)));
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- RLS (default deny) and privileges
-- -----------------------------------------------------------------------------
alter table arena.case_families enable row level security;
alter table arena.case_variants enable row level security;
alter table arena.public_packets enable row level security;
alter table subject.private_packets enable row level security;
alter table sealed.evaluator_packets enable row level security;
alter table sealed.hidden_public_packets enable row level security;
alter table sealed.evidence_artifacts enable row level security;
alter table sealed.family_ingests enable row level security;
alter table sealed.hidden_split_seals enable row level security;
alter table arena.candidates enable row level security;
alter table arena.family_retirements enable row level security;

revoke all on all tables in schema arena, subject, sealed from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on function arena.tg_packet_split(), sealed.hidden_split_digest(), sealed.ingest_case_family(jsonb),
  sealed.seal_hidden_split(jsonb), sealed.verify_hidden_seal(), sealed.sampler_matches(jsonb),
  arena.register_candidate(text, text, text, jsonb)
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;

-- arena_referee reads every tier (labeling, judging, scoring) and writes cases only through functions.
grant usage on schema arena, subject, sealed, ledger to arena_referee;
grant select on arena.case_families, arena.case_variants, arena.public_packets, arena.candidates, arena.family_retirements,
  subject.private_packets, sealed.evaluator_packets, sealed.hidden_public_packets, sealed.evidence_artifacts,
  sealed.family_ingests, sealed.hidden_split_seals
  to arena_referee;
create policy case_families_referee on arena.case_families for select to arena_referee using (true);
create policy case_variants_referee on arena.case_variants for select to arena_referee using (true);
create policy public_packets_referee on arena.public_packets for select to arena_referee using (true);
create policy candidates_referee on arena.candidates for select to arena_referee using (true);
create policy family_retirements_referee on arena.family_retirements for select to arena_referee using (true);
create policy private_packets_referee on subject.private_packets for select to arena_referee using (true);
create policy evaluator_packets_referee on sealed.evaluator_packets for select to arena_referee using (true);
create policy hidden_public_packets_referee on sealed.hidden_public_packets for select to arena_referee using (true);
create policy evidence_artifacts_referee on sealed.evidence_artifacts for select to arena_referee using (true);
create policy family_ingests_referee on sealed.family_ingests for select to arena_referee using (true);
create policy hidden_split_seals_referee on sealed.hidden_split_seals for select to arena_referee using (true);

grant execute on function sealed.ingest_case_family(jsonb), sealed.seal_hidden_split(jsonb), sealed.verify_hidden_seal(),
  sealed.hidden_split_digest(), arena.register_candidate(text, text, text, jsonb)
  to arena_referee;
