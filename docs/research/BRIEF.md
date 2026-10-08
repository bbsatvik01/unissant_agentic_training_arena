# Research brief

Read this, then `docs/challenge/REQUIREMENTS.md` (every requirement ID from the sponsor deck), before starting any route.

## The project

GMU Challenge X, sponsored by Unissant: build an "Investigative AI Training Arena". Human investigators practice interviews with simulated subjects (LLM agents playing a truthful or deceptive role from a private profile) while competing AI assistant agents coach them turn by turn (flag gaps and contradictions with cited transcript evidence, suggest a neutral follow-up, give a finding with confidence). A scenario engine locks case facts, releases evidence on a script and hides role labels and scoring keys. An independent scorer compares locked findings with hidden case facts. A bake-off runs 3 assistant x 3 subject candidates on matched synthetic cases in two tracks (replay frozen transcripts; interactive interviews), with a false-positive gate (<= 5%) and isolation/leakage gate before ranking by deceptive-role recall. Targets: +20% investigator questioning score, >= 80% deceptive recall at <= 5% FPR, >= 95% subject fidelity, coaching within 3 s for 95% of turns. The goal is to win; the prize is an internship.

## Owner constraints (locked)

- LLMs: Gemini models via Vertex AI only. No Chinese models. No other providers.
- Reference repos are READ-ONLY. Never modify, format, install into, or run state-changing commands in them. Never open or print `.env*` files or secrets:
  - TechnoMile (most relevant; A2A/ADK, Phoenix, Supabase, gates): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat`
  - PangeaChat admin assistant v2 worktree (observability): `/Users/balla/PangeaChat/adapi-av2`
  - gokbase: `/Users/balla/Desktop/satvik/gokbase-org`
  - cloudforce: `/Users/balla/Desktop/satvik/Summer Internship/cloudforce/backend`
- Database: Supabase (owner-provided project).
- Observability: Arize Phoenix, maximum coverage.
- Hosting: GCP, scale to zero. Never min-instances >= 1, never CPU always-allocated. 1-2 concurrent users (judges and the team), local use first.
- Architecture: simple, clean, scalable when needed. No over-engineering.
- UI: state of the art; agent avatars, companion "pets", talking agents, agents visibly doing work, virtual interrogation room. Owner will supply a DESIGN.md.
- Safety: synthetic cases only; safe and secure by default.

## Date

Today is 2026-10-08. Prefer 2025-2026 sources. Date-stamp every source. Flag anything older than 12 months on fast-moving technology.

## Research tree (batch 1)

- R1 Internal reuse: TechnoMile
- R2 Internal reuse: PangeaChat adapi-av2
- R3 Internal reuse: gokbase
- R4 Internal reuse: cloudforce
- R5 Investigative interviewing science and coaching-rubric grounding
- R6 LLM deception/detection arenas, role-play fidelity, evaluation statistics, judge calibration, isolation tests
- R7 Gemini on Vertex AI capabilities, latency, pricing, quotas, evaluation service, safety
- R8 Agent runtime and protocol (ADK, A2A) and Phoenix observability
- R9 UI and UX inspiration (interrogation games, agent visualization, avatars, talking, pets, training-sim products)
- R10 Sponsor and competition intelligence (Unissant, GMU Challenge X)
- R11 Data and infrastructure (Supabase, Cloud Run scale-to-zero)

## Source tools

- Google web search: `WebSearch` (load with `ToolSearch` query `select:WebSearch`; `WebFetch` the same way).
- Google Developer Knowledge MCP: `mcp__google-developer-knowledge__search_documents`, `mcp__google-developer-knowledge__answer_query`, `mcp__google-developer-knowledge__get_documents` (load with `ToolSearch`).
- Context7: the MCP server is down this session; use the CLI through Bash: `npx ctx7@latest library "<Official Name>" "<question>"`, then `npx ctx7@latest docs <libraryId> "<question>"`. A quota error is reported, never hidden.

## Output contract (every route)

1. Findings per sub-route with inline citations (title + URL or file path + date).
2. Confidence per finding (high / medium / low) and why.
3. Contradictions and disputed points.
4. Open questions and assumptions made.
5. Implications for our build. No final recommendation; synthesis happens later.
6. Query log: every web, GDK and Context7 query run, so counts are auditable. Never inflate counts.
