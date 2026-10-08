<!-- Batch 1 research route X3; run wf_d67bee29-e11; agent ab80130bbe3b6e85e; 2026-10-08; Sonnet. Counts: {"google_web": 8, "gdk_mcp": 12, "context7": 3, "files_read": 3} -->

## Route X3 — Gemini on Vertex AI as of 2026-10-08

Baseline read: `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/docs/research/external/E10-vertex-ai-gemini-adk.md` (retrieval date 2026-09-25). This route re-verifies against live docs/benchmarks 13 days later and answers the six X3 questions. Where E10 is still accurate I say so briefly rather than re-deriving it; new/changed/contradicted material is flagged explicitly.

### 0. What changed since E10 (2026-09-25 -> 2026-10-08)

- No new Gemini text model GA'd. `gemini-3.1-pro-preview` is still the only current Pro, still Preview, still global-endpoint-only. No `gemini-3.5-pro` appeared anywhere in today's docs or release notes — E10's contradiction #1 stays unresolved in the direction of "not available."
- 2026-10-06: **Gemini Nano Banana 2.1** (image model) went GA — not relevant to our text pipeline.
- 2026-10-07: **Claude Haiku 5.5** added to Model Garden — irrelevant under the owner's Gemini-only constraint (REQUIREMENTS ambiguity #8).
- No pricing change, no new deprecation announced 2026-09-26 through 2026-10-08 beyond what E10 already logged (the 2026-10-21 MaaS retirement cliff and the 2026-12-31 promo-price expiry both still stand).
- One thing E10 did **not** surface that is decision-relevant: fresh Artificial Analysis benchmarks (below) put real time-to-first-token for every current Gemini 3 tier at 6-26 seconds, which is new load-bearing evidence against KPI-4 that E10's cost-only pass never checked.

---

### 1. Model lineup, thinking controls, structured output, function calling, caching, batch, quotas

**Lineup/regions/deprecation** — unchanged from E10 section 1.2; still current: `gemini-3.8-flash` (GA, global/us/eu/regional), `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` (all GA, global+multi-region), `gemini-3.1-pro-preview` (Preview, global only, cannot disable thinking). [Confidence: high — cross-checked against `docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes` through 2026-10-07, GDK.]

**Thinking controls** — confirmed and refined via today's `models/thinking` doc:
- Gemini 3 family uses `thinking_level` (MINIMAL/LOW/MEDIUM/HIGH), **not** `thinking_budget`; setting both in one request errors (400). `thinking_budget` is deprecated for Gemini 3 and "can cause intermittent 400 errors." [high]
- Per-model supported levels/defaults (today's table): `gemini-3.8-flash` = LOW/MEDIUM/HIGH, default **MEDIUM**, MINIMAL errors; `gemini-3.1-pro-preview` = LOW/MEDIUM/HIGH, default **HIGH**, thinking **cannot be turned off**; `gemini-3.1-flash-lite` and `gemini-3.5-flash-lite` = MINIMAL/LOW/MEDIUM/HIGH, default **MINIMAL**. [high, source: `docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking`]
- **Critical nuance not in E10**: Gemini 3 models can never fully disable thinking (floor is MINIMAL, which still spends tokens and still requires a thought signature in multi-turn use or the call 400s). Only **Gemini 2.5** Flash/Flash-Lite/Pro retain `thinking_budget=0` as a true off-switch (Pro cannot use 0 either). This matters directly for KPI-4 — see section 2. [high]

**Structured output** — `response_schema`/`response_mime_type="application/json"` (OpenAPI subset: `anyOf`, string enums, `format`, `items`, min/max, `nullable`, `required`, `propertyOrdering`) unchanged from E10. **New confirmation today**: Gemini 3 series (`gemini-3.1-pro-preview`, `gemini-3.8-flash`) can now combine **Structured Outputs with built-in tools** (`google_search`, `url_context`, `code_execution`, `file_search`, function calling) in one call — this is Preview, Gemini-3-only. Directly relevant to AST-7 (a flag must cite an exact transcript turn): the assistant could, in one structured call, both reason with a lookup tool and emit the schema-enforced flag/citation/finding object. [high: `ai.google.dev/gemini-api/docs/generate-content/structured-output`]

**Function calling** — parallel function calls confirmed unchanged (one model turn can propose several `functionCall` parts; responses are returned as matching `functionResponse` parts in one follow-up `user` turn). `FunctionCallingConfig` mode `ANY` + `allowedFunctionNames` forces a specific call. [high]

**Context caching** — **a genuine doc-to-doc contradiction found today**, not present in this form in E10:
- `docs.cloud.google.com/.../context-cache/context-cache-overview` (Vertex/Agent Platform page): minimum cacheable prefix is **4,096 tokens for the "Gemini 3 family"**, but **6,144 tokens for `gemini-3.0-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.7-flash` and `gemini-3.8-flash` specifically (implicit caching only)**.
- `ai.google.dev/gemini-api/docs/generate-content/caching` (Gemini Developer API page, pulled the same day): its table lists a flat **4,096** for `gemini-3.8-flash`, `3.7-flash`, `3.1-pro-preview` with no 6,144 exception.
These two official Google pages disagree on the same four model IDs. [high confidence the discrepancy exists as documented; low confidence on which number is actually enforced server-side for us — needs a live API test before relying on hitting the cache at exactly 4-6K tokens]. Everything else matches E10: implicit caching on by default, 90% discount on hit, no storage fee; explicit caching also 90% off (Gemini 2.5+), default TTL 60 min, no max; cache and batch discounts don't stack (cache wins); `cachedContentTokenCount` reported in response metadata.

**Batch prediction** — confirmed 50% discount vs. real-time, up to 200,000 requests/job, up to 72h queue + 24h processing, no fixed quota (shared dynamically-allocated pool), not supported for tuned Gemini 3+ models or explicit caching/RAG, GCS or BigQuery in/out. [high: `models/capabilities/batch-inference`]

**Dynamic shared quota / 429** — matches and extends E10: 429 on PayGo means "temporary high contention," not a hard quota; fix is exponential backoff + the global endpoint + traffic smoothing (avoid second-level spikes even if average TPM is within baseline). The `google-genai` Python/Java SDKs ship **client-side automatic retry** (default 5 attempts, 1.0s initial delay, 60s max delay, configurable `http_status_codes`), configurable per-client or per-request. [high: `models/retry-strategy`, `models/deploy/error-code-429`, `models/standard-paygo`]

---

### 2. Latency: TTFT / output tok/s per tier, and KPI-4 feasibility

Fresh Artificial Analysis data (pulled today, dated by AA as updated 2026-09-26 to early Oct 2026):

| Model (tier) | Time-to-first-token | Output tok/s | Note |
|---|---|---|---|
| Gemini 3.1 Flash-Lite (MINIMAL thinking default) | 5.69s (one AA page) / 6.14s (aggregator) | 273-308 tok/s | Fastest current Gemini tier; AA flags this specific endpoint "deprecated," pointing to 3.5 Flash-Lite as successor — treat as a close proxy, not identical |
| Gemini 3.8 Flash, "High" effort variant | 25.73s | 116.6 tok/s | AA explicitly notes TTFT "reflects reasoning model thinking time before generating" |
| Gemini 3.8 Flash, default/aggregate | ~13.3s (one aggregator) | ~302-429 tok/s (inconsistent across aggregators) | Methodology/effort-setting differs by source — treat the TTFT direction as reliable, the exact seconds as noisy |
| Gemini 3.1 Pro Preview (HIGH only, cannot disable) | 23.96s | 115.3 tok/s | AA: "somewhat higher than average... includes thinking time" |

[Confidence: **high** on the qualitative finding — every current Gemini 3 tier's TTFT is thinking-dominated and lands in single-digit-to-26-second territory, not sub-second; **medium** on the exact seconds, since different third-party aggregators (orcarouter, eesel, pricepertoken, Artificial Analysis itself across sibling pages) report materially different numbers for nominally the same model, likely reflecting different default thinking-effort settings and prompt/response sizes in each harness. Sources: artificialanalysis.ai/models/gemini-3-1-flash-lite-preview/providers (fetched 2026-10-08); artificialanalysis.ai/models/gemini-3-8-flash (fetched 2026-10-08); artificialanalysis.ai/models/gemini-3-1-pro-preview (fetched 2026-10-08); www.eesel.ai/blog/gemini-3-8-flash (2026-09-08, >12 months not applicable, within window).]

**Is <=3s p95 coaching (KPI-4) realistic?** On these numbers: **not with any tier at its default thinking setting**, including the fastest (Flash-Lite at ~6s). Streaming does not fix this specifically because TTFT is measured *to the first output token*, and for a reasoning model that first token only appears after the internal thinking pass completes — streaming only improves perceived latency for the remaining output tokens, not the thinking-bound TTFT. [high confidence on this mechanism, consistent with E10's own note that "thinking tokens are billed as output" and occur before the answer]

Tactics that could still get under 3s, none independently verified against our exact schema/prompt:
1. **Drop thinking to the floor** — `thinking_level=MINIMAL` on Flash-Lite is the best Gemini-3 option, but MINIMAL still spends some thinking tokens (it cannot be fully disabled on Gemini 3).
2. **Use a Gemini 2.5 model with `thinking_budget=0`** for the live-coaching path specifically — this is the only true "no thinking" Gemini option found, and it is a legacy-but-GA tier, so it fits the owner's Gemini-only constraint. Trades some reasoning quality for a real shot at sub-3s.
3. **Exploit SOL-6**: the deck itself splits Practice (live coaching, presumably the KPI-4 target) from Assessment (saved feedback for debrief, not live) — only the Practice-mode coaching call needs to hit 3s; Assessment-mode findings can run on a slower/higher-quality tier. This reduces the problem's scope if KPI-4 is read as Practice-only (open question below).
4. **Minimal, compact prompts + context caching** reduce input-processing time but not thinking time — helps cost more than TTFT.
5. **Parallel/prefetch**: split the coaching output into a fast pre-check (non-reasoning classifier: non-responsive / contradiction / evasion / uncertain) and a slower, backgrounded full finding-with-confidence that doesn't block the visible "flag" shown to the investigator — degrades gracefully if SCN/AST timing allows a two-stage UI update.

---

### 3. BKO-8 cost estimate (assumption-driven; not sourced from a Google-published figure)

Stated assumptions (none verified against real transcripts — flag accordingly):
- 2,160 interactive trials (per REQUIREMENTS BKO-8: 3x3x120x2); average 8 exchanges/trial (cap is 12).
- Per exchange: subject call ~3,000 in / 150 out tokens; assistant/coach call ~2,500 in / 200 out; interviewer-harness neutrality-check call ~500 in / 50 out (ambiguity #4 in REQUIREMENTS — this could instead be rule-based with zero token cost, which would remove this whole line item).
- One judge/scoring call per trial: ~8,000 in / 300 out (full transcript + rubric).
- Global endpoint, Standard PayGo, 2026 promo prices, no caching credit applied (caching would lower all of this further — see note).

Totals across 2,160 trials: **~121M input tokens, ~7.6M output tokens.**

| Scenario | Model mix | Cost (2,160 trials) | Cost (360-trial scaled-down: 3x3x40x1) |
|---|---|---|---|
| Lean | All calls on `gemini-3.1-flash-lite` | **~$42** | **~$7** |
| Balanced | Subject on `3.8-flash`, assistant/coach on `3.1-pro-preview`, harness+judge on flash-lite/flash | **~$195** | **~$33** |
| Pro everywhere | All calls on `gemini-3.1-pro-preview` | **~$333** | **~$55** |

At the 12-exchange cap instead of the 8-exchange average, multiply the exchange-driven share (roughly 90% of each total) by 1.5x. This excludes: Model Armor screening calls (pricing not found — see section 5), Google Search grounding if the assistant uses it, Agent Runtime compute (E10 estimated ~$0.06/run at small scale, not applicable at this scale without a real estimate), and any judge-calibration overhead. Implicit caching on the repeated case-packet/profile prefix (shared across every exchange in a trial) could plausibly cut the Pro-heavy input cost by 30-50%, per E10's own caching sensitivity note. [Confidence: low-medium — this is an engineering estimate built on stated, unverified token-size assumptions, not a measured workload.]

---

### 4. Safety: will Gemini block deception/interrogation role-play?

- **Configurable content filters default to OFF** for Gemini 2.5 and Gemini 3 models (harassment, hate speech, sexually explicit, dangerous content) — so, out of the box, nothing in that layer blocks an "I committed/concealed a violation" subject-profile answer. [high: `ai.google.dev/gemini-api/docs/safety-settings`, `docs.cloud.google.com/.../configure-safety-filters`]
- There is also a **non-configurable, always-on layer** (CSAM, recitation/copyright) that is independent of model choice and irrelevant to our synthetic interrogation content. [high]
- **System instructions are the recommended lever** for brand/content-safety nuance and are explicitly positioned by Google as the tool to pair with filters for custom guidance ("don't answer questions related to X"), which is exactly the mechanism needed to tell the subject-agent model "this is a synthetic training exercise, stay in character, do not break the fourth wall." [high: `docs.cloud.google.com/gemini-enterprise-agent-platform/govern/safety`]
- **Open risk, not resolved by docs**: Google's Generative AI Prohibited Use Policy bans using the product to "impersonate individuals" or produce content "with the intent to deceive," with a stated carve-out for "satire, parody, or clearly disclosed impersonation." A synthetic-training deceptive-subject role-play (EX-4's ground rule: "a simulated score is not a finding about a real person") plausibly fits a disclosed-fiction carve-out, but no source found explicitly confirms that reading for an automated multi-turn interrogation simulator at scale. [medium confidence this is fine; **not verified** against the actual ToS text or any Google guidance specific to red-team/training simulators — treat as an open question, not a green light.]
- **Practical mitigation for refusal-corrupting-fidelity (your question's second half)**: use system instructions to pre-commit the model to the synthetic frame every turn (not just once), keep `safety_settings` at OFF/BLOCK_NONE for the subject-agent call specifically (not the public-facing UI), and monitor `promptFeedback.blockReason` / `candidate.finishReason == SAFETY` so a refusal is caught and retried/flagged rather than silently corrupting SUB-8's fidelity score. No published Google guidance speaks to our specific "deceptive-subject-must-not-break-character" scenario; this is inference from the general safety-settings API, not a sourced best practice. [medium]

---

### 5. Model Armor (GDK): screening subject outputs before the assistant sees them

- Model Armor integrates with Vertex/Agent Platform generateContent calls via **floor settings** (project-wide) or **per-request templates**; it intercepts the prompt before the model and the response before your app. [high]
- Relevant filters: **prompt injection and jailbreak detection** (directly maps to SUB-7's "prompt-injection attempts make the session invalid") plus Responsible AI categories and Sensitive Data Protection. If word count is under 3 words, the PI/jailbreak filter returns `NO_MATCH_FOUND` by design (too little signal) — short subject replies like "No." would not be screened at all. [high]
- Recommended pattern: **separate input and output templates** — input template guards the investigator's question/injection attempts, output template guards what the subject emits before the assistant/coach consumes it (your exact use case). [high: `docs.cloud.google.com/model-armor/overview`]
- **Fail-open behavior is a real gap for SUB-7**: if Model Armor is "temporarily unreachable," has an internal error, or isn't available in the serving region, Agent Platform **skips sanitization and continues processing the request unscreened** — a session could pass through an actual prompt-injection attempt with no flag at all during an outage. [high — this is documented Google behavior, not a hypothetical]
- **Quota**: default 1,200 QPM/project, adjustable; estimate needs as (peak interactions/min) x (2 calls per turn: prompt + response) + 20-30% buffer, per Google's own worked example.
- **Pricing and latency overhead**: **not found** in GDK or web search. No $/request, $/1M-character, or ms-overhead figure for Model Armor itself turned up anywhere (Google's general performance guidance is qualitative only: minimize payload, co-locate region, disable unneeded filters). [This is a genuine open question, not a confidence-graded finding — flag explicitly for the owner/orchestrator before assuming Model Armor is "free" or "fast."]
- Token limits: general filters cover up to 2,000 tokens; the prompt-injection/jailbreak filter specifically was expanded to 10,000 tokens (2025-07-28 release note — >12 months old, flagged per date-hygiene rule, but no newer note supersedes it so treat as still current). [medium-high]

---

### 6. google-genai Python SDK in Vertex mode (Context7, `/googleapis/python-genai`)

- **ADC**: when no `api_key` is passed, the SDK calls `google.auth.default(scopes=['.../cloud-platform'])` to load Application Default Credentials and resolve the project — this is the standard path for `Client(vertexai=True, project=..., location=...)` and is never invoked in Express (API-key) mode. [high — read from SDK source via Context7, `google/genai/_api_client.py`]
- **Async**: `client.aio` namespace; recommended pattern is `async with Client().aio as aclient:` so the underlying async transport closes cleanly; `await aclient.models.generate_content(...)`.
- **Streaming**: sync `for chunk in client.models.generate_content_stream(...)`; async `async for chunk in await client.aio.models.generate_content_stream(...)`. Structured-output schemas stream as valid partial-JSON chunks that concatenate to the full object (confirmed earlier via GDK too).
- **response_schema / Pydantic**: `GenerateContentConfig(response_mime_type="application/json", response_schema=MyPydanticModel)` (or `response_format={"text": {"mime_type": "application/json", "schema": MyModel.model_json_schema()}}` on the newer structured-output surface) — matches GDK's structured-output docs; recursive Pydantic models work via `model_rebuild()`.
- **Retry/backoff** is configurable client- or request-level via `types.HttpRetryOptions(initial_delay=1.0, attempts=5, exp_base=2, max_delay=60, http_status_codes=[408,429,500,502,503,504])` — directly usable for the dynamic-shared-quota 429 handling in section 1.
- **Usage metadata for cost accounting**: `response.usage_metadata.thoughts_token_count` and `.total_token_count` (also `prompt_token_count`, implied `cached_content_token_count` per the caching doc) — every call's actual billed-token breakdown is available post-hoc for a real cost dashboard, not just the modeled estimate in section 3.
- Context7 note: the MCP server for Context7 was down this session per the harness notice; the CLI (`npx ctx7@latest library/docs`) worked without error or quota failure both times it was invoked — unlike E10, which logged a Context7 quota failure. [high — directly observed this session]

---

## Contradictions and disputed points

1. **Context-caching minimum token count for `gemini-3.8-flash`, `3.7-flash`, `3.1-pro-preview`**: the Vertex/Agent Platform overview page says 6,144 tokens (implicit-only) for these models; the Gemini Developer API caching page says a flat 4,096 for the same model IDs, same day, same session. Unresolved — needs a live test, not another doc read.
2. **Latency benchmark numbers for the same model disagree across sources** by as much as 2x (e.g., 3.8 Flash TTFT reported as ~13.3s by one aggregator and 25.73s by Artificial Analysis's own "High"-effort page), most likely reflecting different thinking-effort defaults per harness. The direction (TTFT is multi-second and thinking-dominated on every tier) is robust; the exact seconds are not.
3. **Gemini 3.5 Pro** — E10 flagged a release note mentioning it with no model page; 13 days later, still no model page, no price row, no location entry. Carrying E10's working conclusion forward unchanged: treat as not available.
4. Google's safety-settings docs (filters off by default, nothing blocks synthetic deception content) sit alongside a Prohibited Use Policy that bans "deceptive content" and impersonation in the abstract — the two are not logically contradictory (disclosed fiction is plausibly exempt) but they point an operator toward different risk assessments depending on which page they read first, and neither source directly addresses an automated interrogation-training simulator.

## Open questions

- Which context-caching minimum (4,096 or 6,144) actually governs billing for `3.1-pro-preview`/`3.8-flash` in our Vertex project — requires a live API probe, not another doc read.
- Model Armor's own per-request price and added latency in milliseconds — not published anywhere found; needed before assuming it's cheap/fast enough to run on every subject turn.
- Whether KPI-4's "95% of interview turns" is meant to cover only Practice-mode live coaching (per SOL-6's Practice/Assessment split) or all turns including Assessment — materially changes whether KPI-4 is achievable at all with current Gemini-3 thinking floors.
- Whether disclosed-synthetic-training deceptive role-play squarely clears Google's Prohibited Use Policy's deception/impersonation clause — not verified against the actual Terms text.
- Whether AA's reasoning-dominated TTFT figures (measured on long, open-ended benchmark prompts) transfer proportionally to our short, schema-constrained coaching output, or whether thinking time scales down with a simpler task — untested for our exact prompt shape.
- Whether the interviewer-harness "relay" step (REQUIREMENTS ambiguity #4) should be an LLM call at all, or a rule-based neutrality check — changes the BKO-8 cost model's harness line item to near-zero if rule-based.
- Owner's actual Standard PayGo spend tier (carried over from E10, still unverified) — governs real throughput ceilings for the 2,160-trial run.

## Implications for the arena build

- KPI-4 (<=3s p95 coaching) is not realistic on any current Gemini-3 tier at default thinking settings; the only credible paths are (a) a Gemini 2.5 model with `thinking_budget=0` for the live-coaching call specifically, (b) exploiting the Practice/Assessment split (SOL-6) so only live Practice coaching needs to be fast, and/or (c) a two-stage UI (fast non-reasoning pre-check shown immediately, fuller reasoning finding backfilled).
- The Gemini-3 "cannot fully disable thinking" floor (MINIMAL still thinks, still needs thought signatures) means the session/transcript store (Supabase) must persist the raw thought-signature blobs per turn for every multi-turn call, not just text, or follow-up calls will 400 — this generalizes E10's ADK finding to the raw SDK path too.
- AST-7's citation requirement and the new Gemini-3 "structured output + built-in tools" combo (Preview) are a natural fit, but Preview status argues for a fallback (custom function-calling-based evidence lookup) if reliability for a hackathon demo matters more than using the newest surface.
- Context caching: placing the static case packet/profile first in every subject and assistant call is worth doing regardless of which cache-minimum number is correct, since both candidates (4,096/6,144 tokens) are well within a case-packet-sized prompt; this also substantially softens the BKO-8 cost estimate in section 3.
- Model Armor's fail-open behavior means it cannot be the sole enforcement point for SUB-7 (prompt-injection invalidates a session) — an app-level secondary check or at minimum structured logging of Model Armor's `invocationResult` is needed so an outage doesn't silently erase the invalidation signal.
- The cost model (section 3) suggests the full BKO-8 protocol (2,160 trials) is affordable even at a Pro-heavy mix (~$333 in raw tokens, before Model Armor/grounding/compute), and the scaled-down 360-trial variant is roughly 1/6 of any scenario — spend is unlikely to be the binding constraint; latency (KPI-4) and the unresolved caching/safety questions are the bigger open risks.
- `google-genai`'s built-in retry config plus the global-endpoint/traffic-smoothing guidance gives a concrete pattern for running 2,160 trials without hitting a hard quota wall, but argues for a rate-limited worker pool in the BKO runner rather than firing all trials concurrently.

---

## Query log

**GDK (`mcp__google-developer-knowledge__search_documents`), 12 calls:**
1. Gemini thinking level thinking budget latency Vertex AI Agent Platform
2. Gemini structured output response schema Pydantic JSON schema
3. Gemini context caching implicit explicit minimum tokens discount
4. Gemini safety settings system instructions block categories
5. Model Armor prompt injection jailbreak detection Vertex AI
6. google-genai Python SDK Vertex AI client ADC async streaming usage_metadata
7. batch prediction discount Gemini pricing Vertex AI
8. Gemini function calling Vertex AI parallel function calls
9. dynamic shared quota 429 RESOURCE_EXHAUSTED Gemini Vertex AI retry backoff
10. Model Armor pricing per 1000 requests cost latency overhead
11. Gemini Enterprise Agent Platform release notes October 2026
12. Model Armor pricing SKU dollars per unit sanitize API

**Google web (`WebSearch`), 5 calls:**
1. Gemini 3.8 Flash Flash-Lite Pro latency time to first token tokens per second benchmark October 2026
2. Gemini Vertex AI refuse deception roleplay interrogation jailbreak safety 2026
3. Model Armor Vertex AI pricing latency per request 2026
4. "Artificial Analysis" Gemini 3.8 Flash OR "Gemini 3.1 Flash-Lite" time to first token output tokens per second
5. Model Armor latency milliseconds added overhead benchmark Vertex AI

**Google web (`WebFetch`), 3 calls:**
1. https://artificialanalysis.ai/models/gemini-3-1-flash-lite-preview/providers
2. https://artificialanalysis.ai/models/gemini-3-8-flash
3. https://artificialanalysis.ai/models/gemini-3-1-pro-preview

**Context7 (CLI, `npx ctx7@latest`), 3 calls — no quota errors, no failures:**
1. `library "google-genai" "Vertex AI mode client config ADC async streaming response_schema Pydantic usage metadata"`
2. `library "google-genai Python" "Vertex AI mode client config with ADC, async client, streaming, response_schema with Pydantic, usage_metadata for cost accounting"`
3. `docs /googleapis/python-genai "Vertex AI mode client config with Application Default Credentials, async client, streaming, response_schema with Pydantic, usage_metadata for cost accounting"`

**Files read, 3:**
1. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/Unissant Agent trainign arena/docs/research/BRIEF.md`
2. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/Unissant Agent trainign arena/docs/challenge/REQUIREMENTS.md`
3. `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/docs/research/external/E10-vertex-ai-gemini-adk.md`
