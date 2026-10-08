<!-- Batch 2 research route X7; run wf_70bb0865-2f7; agent a39b1e80a048e75d6; 2026-10-08; Sonnet. Counts: {"google_web": 4, "gdk_mcp": 11, "context7": 4, "files_read": 9} -->

## Route X7: Gemini Live API and TTS on Vertex AI as of 2026-10-08

Resolves the apparent conflict between D-001 (Gemini via Vertex only) and D-006 (real-time voice lifted from gokbase, which pins the live model to the Gemini Developer API / AI Studio key, `vertexai=False`). Read first: BRIEF.md, REQUIREMENTS.md, DECISIONS.md (all three in full), plus the actual code this conflict is about: `gokbase-org/backend/app/rag/live/session.py:1400-1408` and `cloudforce/backend/agents/live/session_manager.py:1-40,100-160`, and batch-1's `docs/research/internal/I5-gokbase-cloudforce-delta.md` and `docs/research/external/X3-gemini-vertex-delta-latency-cost.md` (both 2026-10-08).

### 1. Which Gemini Live models exist on Vertex today, and does the gokbase model exist there at all?

Vertex's Live API supported-models table (GDK, `docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api`) lists exactly three models:

| Model ID | Status | Notes |
|---|---|---|
| `gemini-3.8-live` | GA (Sept 2026) | Recommended; native audio, transcriptions, VAD, affective dialog, proactive audio, tool use, live avatar |
| `gemini-live-2.5-flash-native-audio` | GA (Dec 12, 2025; retires Dec 13, 2026) | Same feature set minus live avatar; 128K context, 1000 concurrent sessions/project |
| `gemini-3.5-transcribe-live-preview` | Preview | STT-only, no audio out |

`gemini-3.1-flash-live-preview` — the model both gokbase and cloudforce actually call — is **not on this Vertex list at all**. It only exists on the Gemini Developer API side (`ai.google.dev`), where its own deprecations table (GDK) shows release March 11, 2026, shutdown Nov 17, 2026, replacement `gemini-3.8-live`. So the "lift the gokbase model onto Vertex" framing is moot: that exact model was never going to be on Vertex; the real question is whether `gemini-3.8-live` or `gemini-live-2.5-flash-native-audio` works for this project. Confidence: high (official model table, single source, cross-checked against the Developer-API deprecations table which independently corroborates the model's 3.1-era position in the family).

**Allowlist reality check (the load-bearing finding).** Catalog GA does not mean working access. Web search surfaced multiple 2026 Google developer-forum threads: `gemini-3.8-live` returns `APIError 1008 — Publisher model ... was not found or your project does not have access to it` on Vertex's Live endpoint for non-allowlisted projects, and does not even appear in `ListModels`; `gemini-live-2.5-flash-native-audio` returns "You are not allowlisted to request audio output" or `aiplatform.endpoints.predict denied`, with Google support directing developers to file a Cloud Console support-ticket allowlist request. This is functionally the same gate cloudforce's code comment (`session_manager.py:130-135`, written 2026-05) described for `gemini-3.1-flash-live-preview` — it has simply moved onto the newer model IDs. **The D-001/D-006 conflict is not resolved by "Vertex Live is GA now"; it is resolved only by testing `live.connect()` against this specific GCP project.** Confidence: high for the pattern (multiple independent forum reports, consistent symptom); the project-specific outcome is unknown (open question).

### 2. Connection, session limits, audio, VAD, transcription, function calling, affective dialog, voices, latency

Confirmed via GDK + Context7 (python-genai SDK source), high confidence:

- **Connect**: `genai.Client(vertexai=True, project=..., location=...)` then `client.aio.live.connect(model="gemini-3.8-live", config=...)`. ADC (`google.auth.default(scopes=['.../cloud-platform'])`) is used whenever no `api_key` is set; the SDK's auth-mode decision tree (`_api_client.py`) confirms api_key and project/location are mutually exclusive on the Vertex path — this mechanically matches gokbase's comment that "API keys are not supported by this API" on Vertex.
- **Raw WebSocket**: `wss://{location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`, `Authorization: Bearer <OAuth token>` (e.g. `gcloud auth application-default print-access-token`).
- **Browser auth**: no Vertex-specific ephemeral-token mechanism was found. The only ephemeral-tokens doc that exists (`ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens`) is scoped to the Gemini Developer API. Vertex's own session doc shows only ADC (server) or a manually-fetched gcloud bearer token — neither is safe to ship to a browser. **Implication: Vertex Live needs a backend-mediated WebSocket proxy**, which is exactly what gokbase and cloudforce already build; the architecture pattern survives the Vertex migration even if the specific client constructor call changes. Medium confidence (absence of a Vertex ephemeral-token doc is not proof none exists — flagged as open question).
- **Session limits**: WebSocket connection capped at ~10 minutes regardless of content (reconnect via session resumption; resumption handle valid ~2 hours after last termination; `GoAway` message sent 60s before forced termination). Without context-window compression, audio-only sessions are capped ~15 minutes, audio+video ~2 minutes (128K context, ~25 audio tokens/sec exhausts it fast). With compression (`trigger_tokens` 5,000-128,000 / `target_tokens` 0-128,000, sliding window), sessions are effectively unbounded. Up to 1,000 concurrent sessions per project on pay-as-you-go.
- **Audio formats**: input raw 16-bit PCM, 16kHz, little-endian; output raw 16-bit PCM, 24kHz. Client should resample to 16kHz and send 20-100ms chunks (never buffer a full second).
- **VAD / barge-in**: `RealtimeInputConfig.AutomaticActivityDetection` with configurable `start_of_speech_sensitivity` / `end_of_speech_sensitivity` / `silence_duration_ms` / `prefix_padding_ms`. On interruption the server sends `server_content.interrupted: true` — client must immediately discard its audio buffer.
- **Transcription**: both `input_audio_transcription` and `output_audio_transcription` are independent config flags (gokbase already sets both).
- **Function calling**: supported on both GA Live models via `function_declarations` in the setup message, including async function calling; cannot be combined with Google Search grounding in the same setup (search-only tools vs. non-search tools are mutually exclusive).
- **Affective dialog / proactive audio**: both are **default-on** in `gemini-3.8-live` (no config needed) but must be explicitly enabled (`enable_affective_dialog=True`, `proactivity.proactive_audio=True`) only on `gemini-live-2.5-flash-native-audio`. This is a real config-field difference a lift from gokbase would need to branch on by model.
- **Voices / languages**: 24 languages, ~30 HD voices (shared catalog with Chirp 3 HD voices).
- **Latency**: no concrete figures (ms time-to-first-audio-byte or turn round-trip) were found in GDK, web, or Context7 results in this pass — open question, flagged for a live benchmark.

### 3. Pricing: Vertex vs Developer API, and a 10-minute/12-exchange estimate

No dedicated Vertex-labeled per-token Live price table was retrieved in full (GDK returned a link to "Agent Platform pricing" but not the table itself — open question). Using the Developer API (`ai.google.dev/gemini-api/docs/pricing`) tables as an order-of-magnitude proxy (low confidence on the exact Vertex number, since Vertex historically prices close to but not always identically to the Developer API):

- `gemini-3.8-live` / `gemini-3.1-flash-live-preview` tier: audio-in $3.00/1M tokens or $0.005/min; audio-out $12.00/1M tokens or $0.018/min.
- `gemini-2.5-flash-native-audio-preview-12-2025` tier: audio-in $3.00/1M tokens; audio-out $12.00/1M tokens (no stated per-minute equivalent, but at 25 tokens/sec it works out the same).

A 10-minute, 12-exchange interview, roughly 10 minutes of audio-in (continuous listening) and ~5 minutes of audio-out (model speaking roughly half the time): **≈$0.05-$0.09 audio-in + ≈$0.09 audio-out ≈ $0.14-$0.18 total** for the voice channel alone. This is trivial against the $100 bake-off cap (D-007); it does not change the cost math that already flagged the per-turn coaching/judge LLM calls as the real budget driver. Confidence: low (Developer-API price used as a Vertex proxy; needs the actual Vertex SKU to confirm).

### 4. Differences that would break a straight lift of gokbase's code onto Vertex

1. **Client constructor**: gokbase does `genai.Client(api_key=settings.GEMINI_LIVE_API_KEY, vertexai=False)`. A Vertex port needs `genai.Client(vertexai=True, project=..., location=...)` with ADC (service account or workload identity) — no API key field at all in that path.
2. **Model ID**: `gemini-3.1-flash-live-preview` does not exist on Vertex; must target `gemini-3.8-live` or `gemini-live-2.5-flash-native-audio`.
3. **Affective dialog / proactive audio config**: as above, conditionally required depending on which of the two Vertex models is chosen.
4. **Allowlist**: an entirely new failure mode gokbase's code never had to handle (AI Studio API keys are open by default; Vertex Live access for an ordinary project is not).
5. **Auth plumbing**: the backend needs IAM/ADC wiring (service account with `roles/aiplatform.user` or equivalent) rather than a single env-var API key — a bigger deploy-config change than a code change, and per the owner's infra-approval gate this should be called out and approved before building, not bundled silently into a feature PR.
6. **No ephemeral-token browser path on Vertex** (see §2) — if gokbase's architecture ever assumed a thinner client, Vertex forces the backend-proxy shape that cloudforce already uses; no architectural loss, but worth confirming gokbase's own session.py doesn't assume a direct-to-client path anywhere (not fully audited in this pass — file is 147KB, only the relevant lines were grepped and read).

### 5. Gemini TTS on Vertex vs Cloud TTS; STT options for push-to-talk

**TTS**: `gemini-2.5-flash-tts` and `gemini-2.5-pro-tts` are GA, callable through either the Cloud Text-to-Speech API or the Vertex AI API, across ~14 regions (us-central1 among them) plus a `global` endpoint. Both support single- and multi-speaker synthesis (flash-lite is single-speaker only), natural-language style/pace/tone/whisper prompting via inline vocal tags and a `prompt` field, and streaming output (`PCM`/`ALAW`/`MULAW`/`OGG_OPUS`). `gemini-3.1-flash-tts-preview` exists but all its voices are still Preview. The newer `gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts` models are Preview-only and, notably, **only reachable through the Gemini Enterprise API, not yet through Cloud TTS** — a real gap if the team wants the newest TTS tier specifically. None of the TTS models showed any allowlist friction in this research pass, unlike Live — this is I5's "lowest-risk voice feature" finding, reconfirmed. Confidence: high.

**STT for push-to-talk**: Chirp 3 (`chirp_3`) on Cloud Speech-to-Text v2 is GA in `us`/`eu` multi-region, streaming and batch, auto language detection, diarization, custom-vocabulary biasing, a built-in denoiser, and adjustable endpointing sensitivity for low-latency voice-bot tuning — no allowlist issue reported. `gemini-3.5-transcribe-live-preview` is the Gemini-model alternative on Vertex (Preview, text-only Live model) but its allowlist status specifically was not tested in this pass (open question). Confidence: high for Chirp 3's clean GA status.

### 6. Gemini 2.5 retirement dates — critical for KPI-4

On Vertex/Agent Platform, `gemini-2.5-pro`, `gemini-2.5-flash`, and `gemini-2.5-flash-lite` are all scheduled to retire in the **October 16-20, 2026** window — GDK's own lifecycle page says Oct 20; its own release-notes entry (dated April 2, 2026) says the dates were "updated to October 16, 2026"; web sources (gcpstudyhub.com, a Google developer forum reply) corroborate the inconsistency and note the date was extended once already from an original June 2026 target, with "no earlier than Oct 16, 2026" as the operative floor. **This is 8-12 days from today and before the Nov 2, 2026 deadline.** On the Gemini Developer API side, the same three model IDs are merely "deprecated, access limited to users who've used them before, no shutdown date announced" — a materially looser regime, but one the owner's Vertex-only constraint forecloses using as a workaround.

This sharpens batch-1 X3's KPI-4 concern considerably: `thinking_budget=0` (true zero-thinking) exists only for `gemini-2.5-flash` and `gemini-2.5-flash-lite` (Pro cannot disable thinking at all), and that entire lever is retiring on Vertex before the build ships. Every Gemini 3.x model (3.1 through 3.8) replaces `thinking_budget` with `thinking_level` (MINIMAL/LOW/MEDIUM/HIGH) and **"thinking cannot be disabled"** — stated verbatim in both the Vertex thinking-config doc and Firebase's AI Logic thinking doc, and `thinking_budget` now 400s if combined with `thinking_level` on a 3.x model. The best available lever going forward is `thinking_level=MINIMAL` on `gemini-3.5-flash-lite` (whose own default is already MINIMAL) or `gemini-3.1-flash-lite` — not a true zero. `gemini-3.7-flash`/`gemini-3.8-flash` don't even expose a MINIMAL tier (their floor is LOW, default MEDIUM). Confidence: high for all factual claims; the retirement-date exact day (16 vs 20) remains unresolved between Google's own pages.

### Note on naming

"Vertex AI" is being retired as a brand in favor of "Gemini Enterprise Agent Platform" (announced at Google Cloud Next, April 2026); Google states Vertex AI as a standalone product ceases to exist, with all future Vertex capability shipping under the new name. The python-genai SDK's README itself now describes its `v1` API version as serving "Gemini Enterprise Agent Platform." This is a rename of the same project/billing/ADC surface D-001/D-003 already target — not a new service — but it explains why some GDK/doc URLs say `vertex-ai` and others say `gemini-enterprise-agent-platform` for what is the same underlying corpus mid-migration. Treat both URL patterns as in-scope when researching further.

---

### Query log

**Google Developer Knowledge MCP (`search_documents`), 11 queries, 2026-10-08:**
1. Gemini Live API Vertex AI model IDs gemini-live-2.5-flash native audio
2. Vertex AI Live API WebSocket connect ephemeral tokens session resumption context window compression
3. Gemini 2.5 Flash Vertex AI model deprecation retirement date
4. Vertex AI pricing Gemini Live audio tokens per minute
5. Vertex AI Live API ephemeral token browser client authentication
6. Gemini TTS Vertex AI gemini-2.5-flash-tts gemini-2.5-pro-tts multi-speaker voices pricing
7. Chirp 3 speech-to-text Vertex AI push to talk transcription
8. Live API function calling affective dialog proactive audio configure Gemini capabilities
9. Vertex AI model versions lifecycle Gemini 2.5 Flash retirement date October 2026
10. Gemini thinking_budget 0 disable thinking Gemini 3 models support
11. Vertex AI generative AI pricing Live API audio input output per minute Agent Platform pricing

**Google web search (`WebSearch`, mode standard), 4 queries, 2026-10-08:**
1. Gemini 2.5 Flash Pro retirement October 20 2026 Vertex AI Agent Platform
2. Vertex AI Gemini Live API general availability allowlist 2026 gemini-3.8-live
3. "Vertex AI" rebrand "Gemini Enterprise Agent Platform" name change 2026
4. "gemini-live-2.5-flash-native-audio" Vertex AI allowlist OR 404 OR access 2026

**Context7 (CLI via Bash, MCP server down this session), 4 invocations, 2026-10-08:**
1. `npx ctx7@latest library "google-genai" "Live API vertexai=True ADC connect LiveConnectConfig"` → resolved `/googleapis/js-genai` (wrong language, kept for completeness)
2. `npx ctx7@latest library "python-genai" "Live API vertexai=True ADC connect LiveConnectConfig session_resumption"` → resolved `/googleapis/python-genai`
3. `npx ctx7@latest docs /googleapis/python-genai "client.aio.live.connect vertexai=True ADC application default credentials Live API session; differences between vertexai=True and api_key mode"`
4. `npx ctx7@latest docs /googleapis/python-genai "live.py connect websocket url BidiGenerateContent Vertex endpoint vs generativelanguage.googleapis.com endpoint differences"`

No Context7 quota errors encountered; CLI worked throughout (MCP server itself was down per the session's tool-failure notice, CLI fallback used as instructed).

**Files read (not counted toward web/GDK/Context7 quotas):** `docs/research/BRIEF.md`, `docs/challenge/REQUIREMENTS.md`, `docs/handoff/DECISIONS.md`, `docs/research/internal/I5-gokbase-cloudforce-delta.md` (grepped + partially read), `docs/research/external/X3-gemini-vertex-delta-latency-cost.md` (grepped), `gokbase-org/backend/app/rag/live/session.py` (grepped, lines 1395-1410 read), `cloudforce/backend/agents/live/session_manager.py` (lines 1-40, 100-160 read). No `.env*` or credential files were opened.
