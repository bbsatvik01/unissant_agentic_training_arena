-- =============================================================================
-- 0002_cases.sql  (DRAFT, spec S4; not applied anywhere)
-- Case families and variants (public tier, no role), packets in three tiers, evidence
-- artifacts with release predicates, the hidden-split seal, the candidate registry.
-- Requirements: SCN-1, SCN-4, SCN-7, SCN-8, SCN-9, SCN-10, SCN-11, SCN-12, AST-5, BKO-5.
--
-- Seal pattern adapted from TechnoMile supabase/migrations/20260928001100_holdout_scoring.sql
-- lines 16-24 and 119-142 (hash of sorted ids, recomputed inside Postgres, append-only rows).
-- Every content table is immutable once written: a case can be added, never edited.
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
  variant_code text not null check (variant_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
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
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and pg_column_size(packet) <= 65536),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

-- -----------------------------------------------------------------------------
-- Subject-private tier (SCN-8): role, actions, knowledge, disclosable facts, concealed
-- facts, uncertainty limits, objective, permitted behaviors, disclosure gates, style.
-- -----------------------------------------------------------------------------
create table subject.private_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and pg_column_size(packet) <= 65536),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

-- -----------------------------------------------------------------------------
-- Evaluator-only tier (SCN-9)
-- -----------------------------------------------------------------------------
create table sealed.evaluator_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  role       text not null check (role in ('truthful', 'deceptive')),
  -- canonical event facts (atomic fact ids), material contradictions, resolution criteria, rubric
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and pg_column_size(packet) <= 131072),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

create table sealed.hidden_public_packets (
  variant_id uuid primary key references arena.case_variants(id) on delete restrict,
  packet     jsonb not null check (jsonb_typeof(packet) = 'object' and pg_column_size(packet) <= 65536),
  sha256     text not null generated always as (ledger.hash_jsonb(packet)) stored
);

-- Evidence artifacts and their deterministic release predicates (SCN-4, SCN-10). Replaces
-- the direction's separate release_predicates table: one row carries the content and the
-- predicate, so a predicate can never point at a missing artifact.
--   scheduled_turn:     released automatically once that many exchanges are complete
--   request_after_turn: releasable on request once that many exchanges are complete
create table sealed.evidence_artifacts (
  variant_id         uuid not null references arena.case_variants(id) on delete restrict,
  record_id          text not null check (record_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  kind               text not null check (kind in ('record', 'clarification', 'context_change', 'difficulty_change')),
  title              text not null check (length(title) between 1 and 200),
  content            jsonb not null check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 32768),
  sha256             text not null generated always as (ledger.hash_jsonb(content)) stored,
  requestable        boolean not null,
  scheduled_turn     smallint check (scheduled_turn between 0 and 12),
  request_after_turn smallint check (request_after_turn between 0 and 12),
  primary key (variant_id, record_id),
  constraint evidence_predicate_shape check (
    scheduled_turn is not null or (requestable and request_after_turn is not null)),
  constraint evidence_request_shape check (requestable = (request_after_turn is not null))
);

-- Bundle hash per ingested family (idempotent re-ingest check). Sealed: the bundle carries roles.
create table sealed.family_ingests (
  family_id      uuid primary key references arena.case_families(id) on delete restrict,
  bundle_sha256  text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now()
);

-- The hidden split is sealed once, before any tournament on it freezes (SCN-12).
create table sealed.hidden_split_seals (
  id           uuid primary key default gen_random_uuid(),
  seal_sha256  text not null check (seal_sha256 ~ '^[0-9a-f]{64}$'),
  n_families   integer not null check (n_families > 0),
  n_variants   integer not null check (n_variants > 0),
  created_at   timestamptz not null default now()
);
create unique index hidden_split_seals_one on sealed.hidden_split_seals ((true));

-- -----------------------------------------------------------------------------
-- Candidate registry (AST-5, BKO-5): an immutable version per row, hashed.
-- -----------------------------------------------------------------------------
create table arena.candidates (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('assistant', 'subject')),
  name       text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  version    text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- assistant: model, prompt_sha256, tools, coaching_policy, max_input_tokens, max_output_tokens,
  --            thinking_level, timeout_s;  subject: model, prompt_sha256, policy, max_input_tokens,
  --            max_output_tokens, thinking_level, timeout_s
  manifest   jsonb not null check (jsonb_typeof(manifest) = 'object'),
  sha256     text not null generated always as (ledger.hash_jsonb(manifest)) stored,
  created_at timestamptz not null default now(),
  unique (kind, name, version),
  constraint candidate_manifest_keys check (
    manifest ?& array['model', 'prompt_sha256', 'max_input_tokens', 'max_output_tokens', 'thinking_level', 'timeout_s']
    and (kind <> 'assistant' or manifest ?& array['tools', 'coaching_policy'])
    and (kind <> 'subject' or manifest ? 'policy'))
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
-- Seal digest. One line per hidden variant:
--   family_code:variant_code:public_sha:private_sha:evaluator_sha:artifacts_sha
-- artifacts_sha = sha256 of "record_id:sha256" lines sorted by code point. The seal is the
-- sha256 of all lines sorted by code point and joined by newlines.
-- -----------------------------------------------------------------------------
create or replace function sealed.hidden_split_digest()
returns table (seal_sha256 text, n_families integer, n_variants integer)
language sql stable security definer set search_path = '' as $$
  with lines as (
    select f.family_code || ':' || v.variant_code || ':' || hp.sha256 || ':' || pp.sha256 || ':' || ep.sha256 || ':' ||
           ledger.hash_text((select string_agg(a.record_id || ':' || a.sha256, E'\n' order by a.record_id collate "C")
                               from sealed.evidence_artifacts a where a.variant_id = v.id)) as line,
           f.id as family_id
      from arena.case_families f
      join arena.case_variants v on v.family_id = f.id
      join sealed.hidden_public_packets hp on hp.variant_id = v.id
      join subject.private_packets pp on pp.variant_id = v.id
      join sealed.evaluator_packets ep on ep.variant_id = v.id
     where f.split = 'hidden'
  )
  select ledger.hash_text(string_agg(line, E'\n' order by line collate "C")),
         count(distinct family_id)::integer, count(*)::integer
    from lines
$$;

-- -----------------------------------------------------------------------------
-- ingest_case_family (arena_referee). One transaction writes every tier of one family.
-- bundle: {family_code, domain, split, variants: [{variant_code, style, difficulty, role,
--          public_packet, private_packet, evaluator_packet,
--          artifacts: [{record_id, kind, title, content, requestable, scheduled_turn, request_after_turn}]}]}
-- Refuses: a hidden family after the seal (AR001); a family without both roles (SCN-11, AR007);
-- more than 6 artifacts on a variant (MAX_RELEASES, AR006); a re-ingest with different
-- content (AR003). An identical re-ingest returns the existing id.
-- -----------------------------------------------------------------------------
create or replace function sealed.ingest_case_family(p_bundle jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_sha     text := ledger.hash_jsonb(p_bundle);
  v_family  uuid;
  v_variant uuid;
  v_split   text := p_bundle ->> 'split';
  v_var     jsonb;
  v_art     jsonb;
  v_existing text;
begin
  perform ledger.require_read_committed();
  if jsonb_typeof(p_bundle) is distinct from 'object' or jsonb_typeof(p_bundle -> 'variants') is distinct from 'array' then
    raise exception using errcode = 'AR007', message = 'bundle must be an object with a variants array';
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

  insert into arena.case_families (family_code, domain, split)
    values (p_bundle ->> 'family_code', p_bundle ->> 'domain', v_split)
    returning id into v_family;
  insert into sealed.family_ingests (family_id, bundle_sha256) values (v_family, v_sha);

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
      insert into sealed.evidence_artifacts (variant_id, record_id, kind, title, content, requestable,
                                             scheduled_turn, request_after_turn)
        values (v_variant, v_art ->> 'record_id', v_art ->> 'kind', v_art ->> 'title', v_art -> 'content',
                (v_art ->> 'requestable')::boolean, (v_art ->> 'scheduled_turn')::smallint,
                (v_art ->> 'request_after_turn')::smallint);
    end loop;
  end loop;
  return v_family;
end $$;

-- seal_hidden_split (arena_referee): once, over every hidden variant. Appends a ledger event.
create or replace function sealed.seal_hidden_split()
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v record;
  v_id uuid;
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
  insert into sealed.hidden_split_seals (seal_sha256, n_families, n_variants)
    values (v.seal_sha256, v.n_families, v.n_variants) returning id into v_id;
  -- the seal hash is public: it is published before candidates freeze
  perform ledger.append_event('hidden_split_sealed', null, null,
    jsonb_build_object('seal_id', v_id, 'seal_sha256', v.seal_sha256, 'n_families', v.n_families,
                       'n_variants', v.n_variants));
  return v.seal_sha256;
end $$;

create or replace function sealed.verify_hidden_seal()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.seal_sha256 = d.seal_sha256 and s.n_variants = d.n_variants
                     from sealed.hidden_split_seals s, sealed.hidden_split_digest() d), false)
$$;

-- register_candidate (arena_referee). Idempotent for an identical manifest.
create or replace function arena.register_candidate(p_kind text, p_name text, p_version text, p_manifest jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id  uuid;
  v_sha text;
begin
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

revoke all on all tables in schema arena, subject, sealed from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on function arena.tg_packet_split(), sealed.hidden_split_digest(), sealed.ingest_case_family(jsonb),
  sealed.seal_hidden_split(), sealed.verify_hidden_seal(), arena.register_candidate(text, text, text, jsonb)
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;

-- arena_referee reads every tier (labeling, judging, scoring) and writes cases only through functions.
grant usage on schema arena, subject, sealed, ledger to arena_referee;
grant select on arena.case_families, arena.case_variants, arena.public_packets, arena.candidates,
  subject.private_packets, sealed.evaluator_packets, sealed.hidden_public_packets, sealed.evidence_artifacts,
  sealed.family_ingests, sealed.hidden_split_seals
  to arena_referee;
create policy case_families_referee on arena.case_families for select to arena_referee using (true);
create policy case_variants_referee on arena.case_variants for select to arena_referee using (true);
create policy public_packets_referee on arena.public_packets for select to arena_referee using (true);
create policy candidates_referee on arena.candidates for select to arena_referee using (true);
create policy private_packets_referee on subject.private_packets for select to arena_referee using (true);
create policy evaluator_packets_referee on sealed.evaluator_packets for select to arena_referee using (true);
create policy hidden_public_packets_referee on sealed.hidden_public_packets for select to arena_referee using (true);
create policy evidence_artifacts_referee on sealed.evidence_artifacts for select to arena_referee using (true);
create policy family_ingests_referee on sealed.family_ingests for select to arena_referee using (true);
create policy hidden_split_seals_referee on sealed.hidden_split_seals for select to arena_referee using (true);

grant execute on function sealed.ingest_case_family(jsonb), sealed.seal_hidden_split(), sealed.verify_hidden_seal(),
  sealed.hidden_split_digest(), arena.register_candidate(text, text, text, jsonb)
  to arena_referee;
