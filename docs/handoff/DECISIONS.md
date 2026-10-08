# Decisions (append-only)

## 2026-10-08 · D-001 Gemini on Vertex AI is the only LLM provider
- **Decision:** every model call (assistants, subjects, scenario generation, judges, TTS, image) uses Gemini models through Vertex AI.
- **Reasoning:** owner directive this session ("gemini models all throughout from vertex, no chinese models"). Matches the TechnoMile stack, so its provider port and Phoenix wiring transfer.
- **Alternatives considered + why rejected:** other providers on Vertex Model Garden and open-weight models: excluded by the owner.
- **Files affected:** all future model clients.
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-002 Reference repos are read-only
- **Decision:** TechnoMile, PangeaChat, gokbase and cloudforce are read, never modified. Patterns are lifted by copying into this repo with attribution.
- **Reasoning:** owner directive: they are proven, hosted projects.
- **Alternatives considered + why rejected:** none.
- **Files affected:** none in this repo; governs every agent brief.
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-003 Platform constraints
- **Decision:** Supabase for data, Arize Phoenix for observability, GCP hosting that scales to zero (no min-instances >= 1, no CPU always-allocated), sized for 1-2 concurrent users, simple architecture.
- **Reasoning:** owner directive this session plus the global scale-to-zero gate.
- **Alternatives considered + why rejected:** always-on hosting: forbidden by the global gate.
- **Files affected:** future infra and deploy files.
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-004 Lift-first research
- **Decision:** reuse TechnoMile's late-September research corpus and code (Vertex/Gemini/ADK, Phoenix, Supabase + GCP topology, UI/UX, role-play, agent security) and research fresh only what is specific to this challenge or has moved since.
- **Reasoning:** the corpus is two weeks old and was critiqued over seven Codex rounds; redoing it wastes the owner's usage budget, which the owner asked to conserve for the build.
- **Alternatives considered + why rejected:** full re-research of every route: duplicate cost for little new information.
- **Files affected:** `docs/research/**`.
- **Reversibility:** cheap.
