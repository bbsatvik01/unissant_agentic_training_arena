<!-- Batch 2 research route X8; run wf_70bb0865-2f7; agent a5bc6e4f6308dbc26; 2026-10-08; Sonnet. Counts: {"google_web": 8, "gdk_mcp": 14, "context7": 2, "files_read": 4} -->

# X8 — Latency and cost engineering for KPI-4 (coaching ≤3s p95) under the $100 bake-off cap

> Run wf (this session); agent (research batch 2, route X8); 2026-10-08; Sonnet 5. Counts: google_web=8, gdk_mcp=14, context7=2, files_read=4.

# Route X8 — Latency and cost engineering for KPI-4 under the $100 cap

Read first: `docs/research/external/X3-gemini-vertex-delta-latency-cost.md` (batch 1), `BRIEF.md`, `REQUIREMENTS.md`, `DECISIONS.md` (D-001 to D-008). This route re-verifies X3's latency claims against official Google pricing/docs and builds the cost model X3 flagged as "assumption-driven."

## 0. Headline finding that changes X3's conclusion

**Gemini 2.5 Flash / Flash-Lite / Pro shut down on the Agent Platform (formerly Vertex AI) on 2026-10-20 — 13 days from today, and before our 2026-11-02 deadline.** Source: `documents/firebase.google.com/docs/ai-logic/faq-and-troubleshooting` (GDK, retrieved 2026-10-08): *"Agent Platform Gemini API (formerly Vertex AI): October 20, 2026"* for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. The Gemini Developer API (API-key/AI Studio) path for the same models has no announced shutdown, but D-001 locks us to Vertex AI only. [Confidence: **high** — official Google deprecation page, cross-confirmed by the `gemini-2.5-flash-lite` model page's own banner: "Important: this model is being retired on October 20th, 2026."]

**This kills X3's tactic #2** ("use a Gemini 2.5 model with `thinking_budget=0` for the live-coaching path specifically") as a durable mitigation for KPI-4: by the time the bake-off runs, the only Gemini models available on our provider (Vertex/Agent Platform) will be Gemini 3.x, and **no Gemini 3.x model supports a true thinking-off switch** — the floor is `MINIMAL`, which still spends thinking tokens and still requires thought signatures in multi-turn calls (confirmed again this session: `docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking`). There is now **no path to a literal zero-thinking Gemini call on Vertex for the remainder of this project's life**. KPI-4 engineering must assume a non-zero, model-imposed latency floor on every call, permanently.

## 1. Official pricing (Vertex/Agent Platform via GDK, all dated 2026-10-08)

All tables below are from `ai.google.dev/gemini-api/docs/pricing`, the canonical Gemini pricing page (GDK's `docs.cloud.google.com/vertex-ai/generative-ai/pricing` document was not retrievable by exact ID this session — see Open questions). Per-1M-token USD, Standard tier unless noted; promo prices hold through 2026-12-31 then step up 2027-01-01 where shown.

| Model | Input | Output (incl. thinking) | Cached input | Batch in/out | Notes |
|---|---|---|---|---|---|
| `gemini-3.1-pro-preview` | $2.00 (≤200k) / $4.00 (>200k) | $12.00 / $18.00 | $0.20 / $0.40 + $4.50/1M/hr storage | $1.00–2.00 / $6.00–9.00 | Preview, global-only, thinking cannot be disabled (default HIGH) |
| `gemini-3.8-flash` | $0.75 → $1.50 (2027) | $3.75 → $7.50 | $0.075 → $0.15 + $0.50–1.00/1M/hr | $0.375 / $1.875 | GA 2026-09-02; default thinking MEDIUM; MINIMAL not supported (errors) |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | $0.025 + $1.00/1M/hr | $0.125 / $0.75 | GA; default thinking MINIMAL; supports MINIMAL/LOW/MEDIUM/HIGH |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | $0.03 + $1.00/1M/hr | $0.15 / $1.25 | GA 2026-07-21, successor to 3.1-flash-lite per Artificial Analysis — **but priced higher on both input and especially output** ($2.50 vs $1.50 out) than the model it replaces |
| `gemini-2.5-flash` | $0.30 | $2.50 | $0.03 + $1.00/1M/hr | $0.15 / $1.25 | Shuts down on Vertex 2026-10-20 |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 | $0.01 + $1.00/1M/hr | $0.05 / $0.20 | Cheapest tier found anywhere in the lineup; shuts down on Vertex 2026-10-20 |

[Confidence: **high** for the numbers as published; **medium** on whether these exact $/token figures are what our Vertex project is actually billed under, since the document fetched is the Gemini Developer API pricing page, not a Vertex-specific console page — see Open questions.]

**New contradiction not in X3**: `gemini-3.5-flash-lite` (the model Artificial Analysis names as 3.1-flash-lite's deprecated-endpoint successor) costs **more** per token than `gemini-3.1-flash-lite` on both input ($0.30 vs $0.25) and output ($2.50 vs $1.50 — a 67% jump). A naive "always take the newest Flash-Lite" policy would silently increase cost 1.5-1.7x. `gemini-3.1-flash-lite` remains GA with no shutdown date until 2027-05-07, so it is not yet forced to migrate.

## 2. Latency evidence for short, structured, minimal-thinking calls

No source found (Google-published or third-party) benchmarks TTFT specifically for a ~2-4k input / ~200-400 output structured-JSON coaching call. What exists:

- **Google's own optimization guidance** (`ai.google.dev/gemini-api/docs/optimization`, GDK, 2026-10-08): TTFT and TTLT are explicitly named as the two latency metrics; levers are (a) model choice, (b) shorter prompts reduce TTFT specifically, (c) `max_output_tokens` reduces TTLT, (d) Provisioned Throughput removes PayGo cold-start/queuing variance, (e) lower thinking budget/level reduces latency, (f) streaming improves perceived latency only — none of these is quantified in milliseconds or seconds by Google. [high confidence the guidance exists; **no quantitative claim to verify**]
- **Standard vs Priority vs Flex service tiers** (same doc): Standard = "seconds to minutes," Priority = "seconds" (non-sheddable, 75-100% price premium), Flex = "minutes" (sheddable, 50% discount). For a 3s p95 target, **Priority tier is the only Google-documented tier with a "seconds" latency class** — this is new information X3 did not surface. [high]
- **Third-party TTFT (Artificial Analysis, carried from X3, re-affirmed, no update found this session)**: Flash-Lite ~5.7-6.1s, Flash ~13-26s (methodology-dependent), Pro ~24s — all measured on **open-ended, not schema-constrained, benchmark prompts** at unknown thinking-effort settings per-model. [medium — unchanged from X3]
- **Streaming of structured JSON**: confirmed via GDK (`ai.google.dev/gemini-api/docs/generate-content/structured-output` and `firebase.google.com/docs/ai-logic/generate-structured-output`) that `generate_content_stream` / Interactions API streaming emits valid partial-JSON chunks concatenable into the final object, for Python/JS/Java/Go. This does not reduce TTFT (first token still gated behind the thinking pass) but lets the UI render fields as they complete rather than waiting for the whole object — directly useful for "stream the first flag" (Q3). [high]
- **Global vs regional endpoint**: Google's own docs (`docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations`) state the global endpoint "can improve overall availability and reduce resource exhausted (429) errors" by terminating TLS close to the client, but **no document found quantifies a latency delta in ms between global and a specific region** for generateContent calls. This is a genuine gap, not a resolved question. [high confidence the qualitative claim exists; **no data** on the quantitative question asked]
- **Quotas**: RPM for Gemini 2.0+ models on Standard PayGo follow the dynamic shared-quota model (no fixed number published); spend-based rate limiting kicks in per usage tier ($10/$50/$200 per rolling 10 min for Tier 1/2/3) — relevant to the bake-off's ability to run many trials concurrently without 429s. [high]

**Conclusion carried forward from X3, now reinforced**: TTFT on every available (post-2026-10-20) Gemini model is thinking-dominated; no evidence found this session changes that a <=3s p95 coaching call is unlikely on any current tier's default settings, and the one true "disable thinking" escape hatch (Gemini 2.5, `thinking_budget=0`) is being removed from our only allowed provider before the deadline.

## 3. Tactics to hit <=3s p95

1. **MINIMAL thinking level on Flash-Lite (3.1 or 3.5)** is the only "thinking-off-adjacent" Gemini 3 setting; it is the model default for both flash-lite tiers, so no extra config is even needed — but it is a floor, not an off switch, and needs thought signatures persisted turn-to-turn (Supabase schema implication, carried from X3). [high]
2. **Priority service tier** (75-100% cost premium, "seconds" latency class, non-sheddable) is a concrete, Google-documented lever for the live-coaching call path specifically, not previously surfaced in X3. Given the $100 cap, this should be reserved for the Practice-mode live-coaching call only (SOL-6 split), not the whole pipeline. [high docs, **unverified in ms** for our prompt shape]
3. **Two-stage coaching** (fast flag, deeper finding backfilled): X3 proposed this from first principles; this session found no Google-published reference architecture for it, but the pattern is well-established in the adjacent "real-time agent assist" industry — Cresta and similar contact-center platforms report **sub-200ms-to-~300ms guidance latency** by running a fast classification/retrieval layer in front of a slower LLM reasoning layer, and by streaming transcript-to-recommendation incrementally rather than waiting for sentence completion. [AssemblyAI, "How does real-time agent assist work" and "Build real-time agent assist," 2026, medium confidence as an architecture pattern — these are STT-centric agent-assist products, not Gemini-specific, so the ms figures do not transfer directly, but the staged-pipeline shape is directly analogous to AST-1→AST-3's "assess, flag, suggest, finding" sequence]
4. **Context caching the case packet** (static prefix: case ID, timeline, profile, rubric) shared across every turn in a trial: implicit caching is on by default for Gemini 2.5+ and Gemini 3 models and gives a 90% input-token discount on the cached portion; Google's own optimization doc lists caching's latency benefit as "faster time-to-first-token" (not quantified), separate from its cost benefit. One blog-level source claims a caching redesign cut first-token latency "from 13 seconds to 500ms" for a disk-cache pattern — **not Gemini-specific, not verified, treat as directional, not load-bearing**. [low-medium]
5. **Prompt compaction** (rolling summary + fact cards instead of full transcript replay each turn) reduces input tokens, which Google explicitly ties to TTFT ("shorter prompts reduce time to first token") — this is the one lever with a direct, sourced causal link to TTFT specifically, distinct from thinking time. [high, directional; magnitude unverified]
6. **Per-call thinking level**, **streaming partial JSON to the UI**, and **p95-per-turn measurement** are all mechanically available (sections 1-2) but none is proven, in combination, to land under 3s for our exact prompt — this remains unverified and is the subject of the Q5 benchmark below.

No example found of a shipped system that combines Gemini 3's MINIMAL thinking + structured-output streaming + context caching and reports a measured sub-3s p95 for a reasoning-adjacent coaching task. This is a genuine engineering unknown, not a solved problem elsewhere.

## 4. Cost model for the bake-off (<=$100, 25% retry/dev margin)

Per-trial token accounting, refined from X3 to explicitly price every cost center the brief names (subject call, assistant call, harness step, fidelity/evasion labeling, final finding, trainer-proxy scoring). Assumptions (stated, unverified against real transcripts, same caveat as X3):

- Avg 8 exchanges/trial (12-exchange cap); per exchange: subject call 3,000 in / 150 out; assistant/coach call 2,500 in / 200 out; harness neutrality-check call 400 in / 30 out (ambiguity #4 — zero if rule-based instead); per-turn fidelity/evasion disclosure-tag call 1,500 in / 50 out (separate judge call; zero if folded into the subject's own structured output, which is the cheaper design). Once per trial: final-finding call 4,000 in / 250 out; trainer-proxy scoring call 8,000 in / 300 out.
- At 8 exchanges: ~71,200 in / ~3,990 out tokens per trial. At the 12-exchange cap: ~100,800 in / ~5,710 out. Table below uses the 12-exchange cap (conservative).
- No caching discount applied in the headline table (see caching note below); no Model Armor, grounding, or Live-voice cost included (D-006's voice layer is priced separately under Live-API audio rates, not the text-scored bake-off path per SOL-1).

Per-trial cost by model mix (Standard tier, promo pricing):

| Mix | Definition | $/trial |
|---|---|---|
| A — All Flash-Lite (3.1) | every call on `gemini-3.1-flash-lite` | $0.0338 |
| A2 — All Flash-Lite (2.5, cheapest) | every call on `gemini-2.5-flash-lite` | $0.0124 — **unavailable after 2026-10-20 (section 0)** |
| B — Flash assistant + Flash-Lite subject | subject/harness/fidelity on 3.1-flash-lite; assistant, final-finding, trainer-proxy on `gemini-3.8-flash` | $0.0448 |
| C — One Pro assistant | subject/harness/fidelity on 3.1-flash-lite; assistant + final-finding on `gemini-3.1-pro-preview`; trainer-proxy on 3.1-flash-lite | $0.0852 |

Totals across tournament sizes, with the 25%-margin threshold (cost must be <=$80 to leave 25% margin under the $100 cap):

| Tournament | Trials | Mix A | Mix B | Mix C |
|---|---|---|---|---|
| 3×3×120×2 (full BKO-8) | 2,160 | **$73.0** — fits w/ margin | **$96.8** — fits raw, fails margin | **$184.0** — does not fit |
| 3×3×120×1 | 1,080 | $36.5 — fits w/ margin | $48.4 — fits w/ margin | $92.0 — fits raw, fails margin |
| 3×3×60×2 | 1,080 | $36.5 — fits w/ margin | $48.4 — fits w/ margin | $92.0 — fits raw, fails margin |
| 3×3×40×1 (dev) | 360 | $12.2 — fits w/ margin | $16.1 — fits w/ margin | $30.7 — fits w/ margin |

[Confidence: **low-medium**, same as X3 — this is an engineering estimate on stated, unverified token-size assumptions, not a measured workload. The qualitative ranking (A cheapest, C most expensive; full 2,160-trial protocol is the only size that stresses the cap) is more reliable than the exact dollar figures.]

**Caching sensitivity**: if ~60-70% of each per-exchange input (the static case packet/profile/rubric prefix) hits the 90%-discount cache after the first call in a trial, input-token cost for the repeated-structure calls (subject, assistant, harness, fidelity) drops roughly 35-50%, which would move Mix B's full-protocol total from ~$97 to roughly $60-70 and give it real margin room; this is directionally consistent with X3's own 30-50% caching-sensitivity note and not independently re-derived here.

**Replay track** (BKO-6) is materially cheaper than any number above: no subject-generation cost (transcripts are already frozen), and assistant-evaluation-only calls over frozen transcripts are batch-eligible (50% discount, not supported for tuned Gemini 3+ models but fine for base models). This is additive to, not included in, the interactive-trial table.

**Discrepancy flagged against X3**: X3's own "Lean" estimate for 2,160 trials was ~$42 (vs this route's Mix A at $73). The gap is this route's addition of the explicit per-turn fidelity/evasion-labeling call (REQUIREMENTS SCN-10/EVL-8's sealed disclosure tag), which X3 did not price as a separate line item. If that tag is folded into the subject's own structured-output call at zero marginal cost (the cheaper design choice), Mix A collapses back to roughly X3's $42-50 range. This is a design decision, not a pricing dispute, and should be made explicitly before locking the cost ledger.

## 5. One-hour latency benchmark script (own project)

**Outline**: Python, `google-genai` SDK in Vertex mode (`Client(vertexai=True, project=..., location="global")`, ADC via `google.auth.default`), `asyncio`.

```
for model in [gemini-3.1-flash-lite, gemini-3.8-flash, gemini-3.1-pro-preview]:
  for thinking_level in [MINIMAL, LOW, (MEDIUM/HIGH only where it's the forced default)]:
    for n in range(50):
      t0 = monotonic()
      stream = await client.aio.models.generate_content_stream(
          model=model, contents=<fixed ~3k-token case-packet prompt>,
          config=GenerateContentConfig(
              thinking_config=ThinkingConfig(thinking_level=thinking_level),
              response_mime_type="application/json", response_schema=CoachFlag))
      first_chunk_t = None
      async for chunk in stream:
          if first_chunk_t is None: first_chunk_t = monotonic()
      t_end = monotonic()
      log(model, thinking_level, n, ttft=first_chunk_t - t0, total=t_end - t0,
          usage=response.usage_metadata)  # prompt/thoughts/total token counts
```

- Run with a **rate-limited worker pool** (e.g. `asyncio.Semaphore(5)`), not full concurrency, per X3's own quota guidance (dynamic shared quota, traffic smoothing).
- Log per call: model, thinking_level, TTFT, total latency, `prompt_token_count`, `thoughts_token_count`, `total_token_count`, HTTP status/retry count. Compute p50/p95 per (model, thinking_level) cell with pandas/numpy.
- N=50 x 3 models x ~2 thinking settings = 300 calls at ~3k in / ~300 out tokens each ≈ 900k input + 90k output tokens total. **Expected cost: well under $1** even entirely on `gemini-3.1-pro-preview` (≈$1.80 + $1.08 ≈ $2.88 worst case; on Flash-Lite, cents). Negligible against the $100 cap — run this early and often rather than treating it as precious budget.
- This is the only way to resolve the open question (below) of whether AA's reasoning-dominated TTFT transfers to our short schema-constrained prompt shape; nothing in GDK or web search substitutes for it.

## Contradictions and disputed points

1. **Gemini 2.5 Flash-Lite's retirement date, confirmed and pinned**: X3 carried this as "the 2026-10-21 MaaS retirement cliff" from E10 without a primary citation; this session found the primary source (`firebase.google.com/docs/ai-logic/faq-and-troubleshooting`) and the exact date (2026-10-20) for the Agent Platform/Vertex path specifically, which **reverses X3's own tactic #2 as a usable mitigation** — not a contradiction between two docs, but a correction of X3's own prior low-confidence carry-forward into a high-confidence, decision-reversing fact.
2. **"Successor" Flash-Lite model costs more, not less**: `gemini-3.5-flash-lite` is priced above `gemini-3.1-flash-lite` on both axes, contradicting the usual assumption that a newer same-tier model is cheaper. `gemini-3.1-flash-lite` (GA until 2027-05-07) remains the cheaper, currently-recommended choice.
3. **This route's cost estimate vs X3's**: $73 (Mix A, full protocol) vs X3's $42 ("Lean"), driven by this route's explicit pricing of the per-turn fidelity/evasion-labeling call that X3 folded into zero (see section 4). Not a factual disagreement, a scope difference — flag for the owner to pick one design.
4. **TTFT numbers across third-party aggregators still disagree by ~2x for the same model** (carried unchanged from X3; this session found no new data resolving it, only Google's own qualitative, unquantified optimization guidance).

## Open questions

- Whether the `ai.google.dev/gemini-api/docs/pricing` table (Gemini Developer API) is priced identically to the Vertex-specific console pricing page (`cloud.google.com/vertex-ai/generative-ai/pricing`) for standard PayGo — GDK could not retrieve the Vertex-specific document by name this session (404); web search returned only localized/mirrored URLs, not fetched. Historically Google has kept these at parity for current-generation models, but this is **not verified** for our exact billing path and should be confirmed against the live Vertex console before the cost ledger is finalized.
- Whether KPI-4's 3-second target is measured as TTFT-of-the-first-visible-flag (favoring the two-stage/streaming tactics) or time-to-the-full-finding-with-confidence (which no current tactic reliably hits) — unresolved, carried from X3.
- No quantified regional-vs-global endpoint latency delta exists in any source found; only the qualitative "global reduces 429s" claim.
- Priority service tier's actual latency distribution for our prompt shape is undocumented in seconds/ms; "seconds" is Google's only characterization.
- Whether folding the fidelity/evasion disclosure tag into the subject's own structured-output call (zero marginal cost) versus a separate judge call (this route's conservative default) is the intended design — materially changes the cost table in section 4.
- Context-caching minimum-token-count contradiction from X3 (4,096 vs 6,144 tokens for the same four Gemini 3 model IDs across two Google pages) remains unresolved; not re-tested this session.

## Implications for the arena build

- The project can no longer plan around "drop to Gemini 2.5 for a true latency floor" as a KPI-4 fallback at any point after 2026-10-20 — this option is gone before the build even starts in earnest. Every coaching-call design must assume Gemini 3.x's `MINIMAL` thinking floor as the best available, non-zero baseline.
- Priority service tier is a real, Google-documented, cap-compatible (75-100% premium on what is likely a small fraction of total calls — just the live Practice-mode coaching call) lever worth prototyping before concluding KPI-4 is infeasible; it was not in X3 and should enter the architecture discussion.
- The one-hour benchmark (section 5) is cheap, fast, and the only way to get real numbers for our actual schema and prompt size — it should run before any further architectural commitment on KPI-4, not after.
- The cost model confirms X3's bottom line: dollar spend is very unlikely to be the binding constraint on the full 2,160-trial protocol under any Flash/Flash-Lite-centered mix with context caching; a Pro-everywhere or Pro-assistant-heavy mix at full scale is the one combination that risks the cap, especially without caching.
- `gemini-3.1-flash-lite` (not `3.5-flash-lite`) is currently the better cost/latency default for high-volume subject and harness calls, pending the benchmark's TTFT comparison between the two.
- The explicit per-turn fidelity/evasion-labeling cost center the brief asked us to price is a real design fork (fold into subject output vs. separate judge call) with a measurable cost delta (~$25-30 difference at full scale per this route's model) and a measurable latency delta (one more call in the hot path if separate) — this should be decided once, not discovered mid-build.

---

## Query log

**GDK (`mcp__google-developer-knowledge__search_documents` / `get_documents`), 14 calls:**
1. Vertex AI Gemini pricing gemini-3.1-pro-preview gemini-3.8-flash gemini-2.5-flash gemini-2.5-flash-lite input output tokens
2. Gemini streaming structured output partial JSON response_schema latency
3. Vertex AI global endpoint vs regional endpoint latency Gemini
4. Gemini 2.5 flash thinking budget 0 latency low latency guidance Vertex AI
5. get_documents: ai.google.dev/gemini-api/docs/pricing, ai.google.dev/gemini-api/docs/optimization.md.txt (optimization doc not found by that exact id)
6. Gemini API quotas rate limits per project requests per minute Flash-Lite Flash Pro
7. Gemini 3.1 Pro Preview pricing per 1 million tokens standard global batch cached
8. Gemini API optimization latency reduce time to first token best practices inference
9. Gemini 3.8 Flash pricing standard tier input output cached context caching 1 million tokens
10. Gemini 2.5 Flash pricing input output per 1 million tokens standard batch Paid Tier
11. Gemini 3.5 Flash-Lite pricing input output per 1 million tokens standard batch
12. Vertex AI generative AI pricing page Gemini models per 1000 characters parity with Gemini API
13. Gemini 2.5 Flash retirement date October 2026 deprecation Pro Flash-Lite shut down

**Google web (`WebSearch`), 7 calls:**
1. Vertex AI Gemini pricing page October 2026 gemini-3.1-pro-preview gemini-3.8-flash input output price
2. Gemini 2.5 Flash-Lite thinking_budget 0 latency benchmark short structured output JSON
3. two-stage LLM coaching fast flag deep analysis backfill latency architecture pattern
4. Gemini API context caching case packet reduce latency cost real-time coaching system
5. Artificial Analysis Gemini 2.5 Flash-Lite time to first token short prompt 2026
6. "p95 latency" coaching OR triage real-time LLM assistant production case study streaming first token UI
7. real-time call coaching AI latency architecture Cresta OR Observe.AI streaming nudge agent assist

**Google web (`WebFetch`), 1 call:**
1. https://assemblyai.com/blog/how-does-real-time-agent-assist-work-an-implementation-guide

**Context7 (CLI, `npx ctx7@latest`), 2 calls — no quota errors, no failures:**
1. `library "google-genai Python" "concurrent async batch requests measuring per-call latency TTFT benchmarking"` → resolved `/googleapis/python-genai`
2. `docs /googleapis/python-genai "run concurrent async generate_content calls with asyncio.gather, measure per-call latency time to first token with generate_content_stream, N repeated calls benchmarking pattern"`

**Files read, 4:**
1. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/Unissant Agent trainign arena/docs/research/BRIEF.md`
2. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/Unissant Agent trainign arena/docs/challenge/REQUIREMENTS.md`
3. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/Unissant Agent trainign arena/docs/handoff/DECISIONS.md`
4. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/Unissant Agent trainign arena/docs/research/external/X3-gemini-vertex-delta-latency-cost.md`
