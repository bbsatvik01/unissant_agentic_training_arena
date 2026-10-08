<!-- Batch 2 research route X10; run wf_70bb0865-2f7; agent aa7b9a86517ecfd3d; 2026-10-08; Sonnet. Counts: {"google_web": 5, "gdk_mcp": 9, "context7": 5, "files_read": 5} -->

## X10 — Hosting for judges: Phoenix, Supabase, Cloud Run

Batch 2, external route. Read first: `docs/research/BRIEF.md`, `docs/challenge/REQUIREMENTS.md`, `docs/handoff/DECISIONS.md` (D-001..D-008), `docs/research/internal/I2-technomile-corpus-stack.md`, `docs/research/internal/I4-pangea-adapi-av2-observability.md`. No files written or modified.

---

### Q1. Phoenix for a hosted demo: Phoenix Cloud free tier vs self-hosting on Cloud Run + Supabase

**Phoenix Cloud (Arize AX) free tier, 2026:** 25,000 spans/month, 1 GB ingestion/month, **15-day retention**, 10 Signal issues/month, unlimited users, unlimited evaluations — permanent (no trial expiry), cloud-hosted SaaS. Paid "Pro" is $50/mo for 50,000 spans, 10 GB ingestion, 30-day retention, 25 Signal issues. *(Source: [Arize Phoenix Free Plan 2026](https://costbench.com/software/ai-observability/arize-phoenix/free-plan/), accessed 2026-10-08; also [markaicode.com Phoenix pricing](https://markaicode.com/pricing/arize-phoenix-pricing). Confidence: medium — both are third-party pricing-aggregator sites, not Arize's own pricing page, which did not surface directly in search; cross-check Arize's own phoenix docs/arize.com before locking a build decision.)*

**Phoenix Cloud auth / data residency:** no primary-source detail surfaced on Phoenix Cloud's auth model (SSO vs email) or data-residency region choice in this session's searches — **open question**, flagged below.

**Self-hosted Phoenix on Cloud Run + Supabase (per internal corpus, I2/I4, high confidence, validated against source code in a prior round):**
- Phoenix v20.x self-hosts as a single container + Postgres (asyncpg driver); **must use Supabase's session pooler or a direct connection — transaction-mode pooling (port 6543) breaks Phoenix with prepared-statement errors.** (`I2-technomile-corpus-stack.md:24`, `:29`)
- **Scale-to-zero risk, unmeasured:** OTLP spans batch into an in-memory deque flushed by a background loop every 0.1 s; under Cloud Run's request-based CPU throttling, that background flush may never run between requests, risking span loss right before an idle shutdown. The internal corpus flags this as "needs a 15-min hands-on test," never actually measured live. (`I2:25`, `I2:88`) Confidence: medium (mechanism verified in source, not measured).
- Phoenix is Elastic License 2.0 (source-available, not OSI) — fine to self-host, cannot be resold as a managed service to others. (`I2:26`)
- Auth: `PHOENIX_ENABLE_AUTH=true` + `PHOENIX_SECRET` env var; app calls use `Authorization: Bearer <PHOENIX_API_KEY>`. Confirmed directly against Context7 Phoenix docs (`arize-ai/phoenix` MIGRATION.md): `PHOENIX_ENABLE_AUTH=True` + `PHOENIX_SECRET=<secret>` protects the scaffold and admin login; all API calls then need the bearer key. High confidence (primary source).
- **Real-world precedent (I4, high confidence, full code read):** PangeaChat's `adapi-av2` wires Phoenix via OTLP-HTTP to a **self-hosted, LOCAL-ONLY** instance (`docker-compose.observability.yml` literally says "for LOCAL E2E only — never a deploy artifact"). Neither its staging nor production Cloud Run task definitions set `PHOENIX_OTLP_ENDPOINT`/`PHOENIX_API_KEY` — tracing is a no-op in the only place that has ever actually been deployed. This is a direct warning against assuming "we wired OpenInference" means "Phoenix is live in the hosted judge demo."

**Billing/ops comparison for the judge link:**
| | Phoenix Cloud free | Self-hosted on Cloud Run |
|---|---|---|
| Ops burden | Zero — managed | Own container, own Postgres wiring, own auth secret, own scale-to-zero span-loss risk |
| Cost | $0 (within 25k spans/15-day retention) | Cloud Run instance-based billing while any process is "alive" + Supabase compute |
| Risk for a one-shot demo window (2026-11-02) | Retention window (15 days) is plenty for a demo; span cap (25k) plausible for 1-2 users over weeks of dev + a tournament, but tournament itself may be 2,160 trials x multiple spans/turn — likely **exceeds 25k spans** if every coaching turn is traced | Unlimited (your own Supabase storage), but the span-loss-at-idle risk is unmeasured and the auth/env wiring has to be done correctly (I4's own team got this wrong in production) |

**Which gives the least ops for a working judge link:** Phoenix Cloud free tier is the lower-ops choice for the *judge-facing link specifically* — no self-managed container, no pooler-mode gotcha, no span-loss-at-idle unknown — **provided the span volume for the demo window fits inside 25k spans/15-day retention**. For the bake-off's own internal 2,160-trial run (which needs "maximum Phoenix coverage" per the owner constraint and will almost certainly exceed 25k spans), self-hosting on Cloud Run + Supabase (session pooler) is likely still necessary, with the untested idle-flush risk run down explicitly as a 15-minute spike before relying on it. Confidence: medium — the free-tier numeric limits are third-party-sourced, not Arize's own page.

---

### Q2. Supabase for a judged demo on 2026-11-02

**Free-tier pause rule, confirmed from two independent sources (high confidence):** a free-tier project **auto-pauses after 7 days (1 week) with no database request** (not "no activity" generically — specifically a DB request). Pausing does not delete data and does not count against the 2-active-project cap, but the project is **unreachable until manually restored from the dashboard** — there is no automatic wake-on-request for a paused free project. *(Source: [jetadmin.io Supabase Pricing 2026 Guide](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/), 2026; [automationatlas.io Supabase free tier limits 2026](https://automationatlas.io/answers/supabase-free-tier-limits-2026/), 2026. Confirms the internal corpus's identical finding at `I2:28`.)*

**Build implication, high confidence:** since judging is a single date (2026-11-02) but D-008 requires a hosted link judges can return to and a repo review window around it, free-tier Supabase risks presenting judges with a **dead, paused database** if more than 7 days pass without a query between build-freeze and demo day, or if judges check the link late. A keepalive cron hitting the DB, or upgrading to Pro for the judging window, closes this gap.

**Pro plan, 2026 (medium confidence, third-party pricing aggregator, not Supabase's own pricing page):** $25/mo per organization, never pauses. Bundles Auth (50,000 MAU), Storage (100 GB), Edge Functions (2M invocations), **Realtime 200 concurrent connections included, up to 500 with no per-connection overage**, 8 GB DB storage, 100 GB file storage, 250 GB uncached + 250 GB cached egress, plus a $10/project compute credit covering one micro instance. *(Source: [jetadmin.io 2026 guide](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/); [swyftstack.com Supabase Pricing 2026](https://swyftstack.com/blog/supabase-pricing-explained).)* **This directly matches the internal corpus's independently-sourced numbers** (`I2:28`: Free 200/500 concurrent Realtime connections Free/Pro, 100 msg/s Free, Broadcast 72h replay / 25 msgs per request) — no contradiction found between the two batches. For 1-2 concurrent users (owner's stated scale), Free-tier limits (500 MB DB, 2 active projects, 200 Realtime connections) are not remotely a binding constraint — **the pause behavior, not the size limits, is the real risk for this project.**

**RLS pattern for a sealed schema (SCN-5, SCN-9 — scoring keys and evaluator packets must never leak), confirmed primary-source via Context7 `/supabase/supabase`, high confidence:**
1. **Don't expose the schema to PostgREST at all** — Supabase's "Exposed schemas" API setting controls which schemas PostgREST serves; a schema simply left off that list is unreachable over the Data API regardless of grants.
2. For any `SECURITY DEFINER` RPC that touches sealed data, **explicitly `REVOKE EXECUTE ... FROM anon, authenticated`** so it's only reachable indirectly through an RLS policy, never directly via `/rest/v1/rpc/`.
3. Pin `search_path = ''` on every `SECURITY DEFINER` function and schema-qualify every name inside it — the official docs call out this exact trap: "Without a pinned `search_path`, a caller can point an unqualified name at their own object and run it with the function owner's privileges."
4. Canonical warning from the docs: *"A `security definer` function in an exposed schema is callable over the Data API with the creator's privileges. Never create one in a schema listed under 'Exposed schemas.'"*
5. A `SECURITY DEFINER` function used **only inside** an RLS policy (never called directly) does **not** need to be in the exposed-schemas list or PostgREST's extra search path at all — PostgREST never needs to know it exists.

This maps directly onto SCN-9 (evaluator-only packet: canonical facts, scoring rubric) — put it in a schema never listed in "Exposed schemas," reached only by `SECURITY DEFINER` functions called from server-side code with the service-role key, never the anon/authenticated roles.

**Supabase Auth options for judges (Context7, high confidence):** magic link and OTP both default to 1-hour validity (`packages/shared-data/config.ts`). Anonymous sign-in exists and supports later linking to a real identity, including Google OAuth, via `linkIdentity({ provider: 'google' })` (JS) / `link_identity({'provider': 'google'})` (Python) — i.e., a judge could start anonymous (fastest path, no account friction for a live demo) and optionally upgrade to Google OAuth without losing their session state. This is a strong fit for a judge-facing link: anonymous-by-default, Google OAuth optional for a persistent identity, magic link as a fallback for non-Google judges.

**Realtime vs SSE for live UI updates (high confidence, Context7 + internal corpus agreement):** Supabase "Postgres Changes" re-authorizes every event against every subscriber (so throughput scales with subscriber count, not write rate, and is single-threaded — compute tier upgrades don't help past ~3,000 concurrent subscribers). Supabase's own docs recommend switching to **Broadcast** above ~3,000 concurrent subscribers on the same change stream — irrelevant at 1-2 users, but the architectural lesson (Broadcast fans out once vs per-subscriber auth checks) is the same reasoning the internal corpus already used to pick plain typed **SSE over a durable Postgres event table as the primary transport**, reserving Supabase Realtime Broadcast only as a considered-and-rejected alternative (cold-tenant message loss, 25-message-per-request replay cap, Data API exposure risk) (`I2:49`). No contradiction between batches — both converge on SSE off a durable log as primary, Realtime as non-primary.

---

### Q3. Cloud Run for the backend

**WebSockets (primary source, GDK `docs.cloud.google.com/run`, high confidence):**
- Supported with no special config; a WebSocket is just a long-running HTTP request.
- **Timeout**: defaults to 5 minutes, configurable up to **60 minutes** — matches the brief's ask ("timeouts up to 60 min") exactly; the client must handle reconnect beyond that (e.g. `reconnecting-websocket`).
- **Session affinity**: best-effort only — a 30-day cookie routes repeat requests from the same client to the same revision instance, but termination, max-concurrency, or max-CPU on that instance still breaks it; state that must survive must live in Supabase/Redis, not instance memory.
- **Concurrency**: up to 1,000 concurrent connections per container instance (Cloud Run default networking limit), separate from the 80-per-instance "concurrent requests" limit documented in the general quotas page — Google recommends raising the container's concurrency setting above default for WebSocket-heavy services.
- **Billing**: "A Cloud Run instance that has any open WebSocket connection is considered active, so CPU is allocated and billed as instance-based" — i.e., **while a Gemini Live voice session is open, that instance is billed continuously, not just per request**; this is the real cost driver for D-006's voice feature, not a per-message cost.
- **Scale to zero after**: once the last WebSocket on an instance closes, the instance can scale back toward zero as with any Cloud Run service (min-instances still must be 0 explicitly — "the default is autoscale-from-zero" per the owner's gate).
- Don't enable end-to-end HTTP/2 for WebSocket services (explicit doc warning).
- Multi-instance fan-out requires an external pub/sub (Memorystore Redis or Firestore listeners) if voice sessions must coordinate across instances — not needed at 1-2 users, but documented so a future scale-up doesn't silently break.

**SSE streaming:** not WebSocket-specific in the docs retrieved, but inherits the same request-timeout and instance-based-billing-while-streaming behavior; the internal corpus's SSE-over-durable-event-table pattern (`run_events` + `Last-Event-ID` resume, `I2:49`) is the concrete implementation already validated against this exact Cloud Run behavior.

**Startup CPU boost / cold-start mitigation without min-instances (GDK, high confidence):** `--cpu-boost` temporarily doubles (up to 8 vCPU cap) the allocated CPU during container startup plus 10 seconds after start, billed for that boosted amount only during the (possibly shortened) startup window — this is the correct, scale-to-zero-compliant lever for the owner's "no min-instances ≥ 1" gate, as opposed to pinning an instance warm.

**Cloud Run Jobs for tournament runs (GDK, high confidence):**
- **Parallelism**: configurable 0 to a quota max; tasks run concurrently up to that cap, useful for fanning out the bake-off's 2,160 interactive trials.
- **Task timeout**: default 10 minutes, configurable up to **168 hours (7 days)** per task (GPUs cap at 1 hour) — ample for even a worst-case long interview trial.
- Jobs are billed only while executing (instance-based, same as services), matching the internal corpus's framing that "Cloud Run Jobs are always instance-billed" and don't carry the services' idle/min-instances exposure (`I2:30`).
- A **"delayed execution"** mode exists (up to 12 h deferral) at a discounted rate for non-urgent batch work — plausibly useful to spread the $100 bake-off spend cap (D-007) across off-peak windows, though not verified against actual pricing deltas in this session.

**Service-to-service auth (GDK, high confidence, primary source):** Cloud Run's built-in `roles/run.invoker` IAM check validates a Google-signed ID token; the calling service fetches a token scoped to the target's URL as `audience` from the metadata server, and sends it as `Authorization: Bearer <token>`. Google has a newer agent-specific doc (`docs.cloud.google.com/run/docs/ai/authenticate-agents`) describing the same mechanism explicitly framed for A2A agent-to-agent calls, plus an optional **mTLS-bound token** variant to restrict `ingress=internal` services without a VPC — directly relevant if the scorer/coach/subject are split into separate Cloud Run services that must not be reachable from the public internet.

**Secret Manager (GDK, high confidence):** two integration modes — mount as a volume (always re-fetches latest version at read time, rotation-friendly) or inject as an env var (resolved once at instance startup; Google recommends pinning to a specific version, not `latest`, when using env vars, since a startup-time secret rotation won't be picked up until the next cold start).

**Workload Identity Federation from GitHub Actions (GDK, high confidence, primary source):** standard pattern — `permissions: id-token: write` in the workflow, `google-github-actions/auth@v1` (or newer) with `workload_identity_provider` + `service_account`, no long-lived JSON key ever stored as a GitHub secret. This is the correct mechanism for the deploy pipeline and satisfies the owner's "no committed service-account keys" posture implicitly (keys were never mentioned as forbidden in DECISIONS.md, but WIF is strictly safer and is Google's documented recommended path).

**Billing budget alerts (GDK, high confidence):** standard console/API budget alerts are **email-only and estimate-based with multi-hour lag** — not enforcement. For an actual stop, connect the budget to a **Pub/Sub topic** for programmatic notifications (delivered multiple times/day, at-least-once, can arrive out of order or be delayed/dropped on misconfiguration) and build a consumer (e.g., a Cloud Function) that reacts — this is the mechanism a kill switch would subscribe to. The internal corpus (`I2:31`) separately notes a newer **"budget spend caps"** preview feature that can hard-block new usage at 100% directly on Cloud Run / Gemini Enterprise Agent Platform — this is a real automated backstop but was flagged in the prior batch as still "never a substitute for an in-app reservation ledger," i.e., it should be a second line of defense behind the project's own cost-ledger hard stop (D-007), not the sole control.

**Audit that fails on min-instances ≥ 1:** no new web/GDK/Context7 search needed — the internal corpus already specifies the exact pattern (`audit_cloud_run_cost.sh` gate that exits 1 on any min≥1, `--no-cpu-throttling`, or a stray always-on tag, lifted from the TechnoMile corpus, `I2:48`) and this is the user's own standing global hard gate (serverless-scale-to-zero). Confidence: high (already validated in a prior Codex-reviewed round per the corpus's own account, not independently re-verified by this route).

---

### Q4. Frontend hosting on GCP that scales to zero

| Option | Scale-to-zero | WebSocket support | SSE support | Notes |
|---|---|---|---|---|
| **Next.js on Cloud Run** | Yes (explicit min=0) | Full (it's just a container) | Full | Most control; you own the Dockerfile, concurrency, and CPU-boost config directly |
| **Firebase App Hosting** | Implied — it deploys onto Cloud Run under the hood with "automatic scaling," but the min/max-instances knob is set by App Hosting's buildpack layer, not hand-authored | Inherits Cloud Run's WebSocket support since it *is* Cloud Run underneath, but App Hosting's docs emphasize SSR/streaming for AI apps, not raw WebSocket proxying — unverified whether its default config exposes the 60-min timeout knob directly | "Streaming support helps ensure fast initial load times... as you add generative AI features" — framed around RSC/SSR streaming, not necessarily a durable SSE channel | **Zero-config** detection and build for Next.js 13.5+ and Angular 18.2+; git-push deploy; built-in Secret Manager integration; (Source: GDK `firebase.google.com/docs/app-hosting`, high confidence for the architecture, medium for whether min-instances defaults to 0 since this wasn't explicitly stated) |
| **Static export → Firebase Hosting or Cloud Storage + CDN** | Trivially yes — no compute at all for static assets | **None** — a static host cannot terminate a WebSocket or hold an SSE connection | **None**, same reason | Firebase Hosting's own serverless comparison doc is explicit: Firebase **Hosting** itself imposes a 60-second request timeout even when backed by Cloud Functions/Cloud Run, which **cannot** hold a 60-minute voice WebSocket or a long SSE coaching stream (GDK `firebase.google.com/docs/hosting/serverless-overview`, high confidence) |

**Implication:** given D-006 (Gemini Live voice) and the SSE coaching-turn stream (KPI-4: ≤3s for 95% of turns), the frontend's live-feature calls (voice proxy, coaching SSE) **cannot** go through a static-export + CDN deployment or through Firebase Hosting's 60-second-timeout layer. Either (a) Next.js served directly on Cloud Run (full control, matches the owner's existing scale-to-zero gate and audit script), or (b) a static/SSG frontend that calls a *separate* Cloud Run backend service directly for WebSocket/SSE (bypassing Firebase Hosting's 60s cap entirely) would work; Firebase App Hosting is architecturally closest to "Next.js on Cloud Run with less config," but its exact min-instances default and whether its request path imposes Firebase Hosting's 60-second cap on the live-voice path specifically was **not confirmed** in this session — flagged as an open question.

---

### Q5. Abuse and spend guards for a public judge link

No GDK/Context7 coverage exists for this (not library/API docs, it's an architecture pattern), and web search returned low-confidence, non-authoritative results (`agentdeals.dev`, `fast.io`, `laozhang.ai` — none are Google or Anthropic primary sources) for Gemini-specific rate limits; **those three sources are explicitly flagged low confidence and are about the Gemini **Developer API** tier system, not Vertex AI, which is the owner's locked provider (D-001) — the tier/spend-cap numbers found do not directly apply to a Vertex AI Vertex AI deployment and must not be treated as the real ceiling.**

What **is** directly actionable, synthesized from the GDK findings above plus the internal corpus:
- **Per-user rate limits**: must be enforced in a datastore all instances share (Supabase), not in-process memory — Cloud Run's own global rule against per-process in-memory limiter state applies here exactly as the user's own global hard gate on worker-count/rate-limit coupling describes (a lesson from a different, unrelated incident already encoded in the user's standing rules) — i.e., do **not** build a per-instance in-memory token bucket, since Cloud Run can and will run multiple instances of the frontend and backend simultaneously under any real judge load.
- **Daily spend caps / kill switch**: the only verified enforcement primitive from this session is the Pub/Sub-connected budget notification (GDK, confirmed above) feeding a consumer that can flip a flag the backend checks before issuing any new Gemini call — functionally identical to the "cost ledger with reservations and a hard stop" already locked in D-007; the GCP budget alert is a slow, approximate backstop (multi-hour lag) layered behind it, never the primary mechanism.
- **Cloud Armor**: Standard tier is pay-as-you-go — **$5/security-policy/month + $1/rule/month + $0.75/million requests (global scope) or $0.60/million (regional scope)**, no data-processing fee, no commitment. (Source: [Google Cloud Armor pricing via tutorialsdojo.com summary](https://cloud.google.com/armor/pricing), 2026 figures reported; medium confidence — the search surfaced the number through secondary summarizer pages citing `cloud.google.com/armor/pricing`, the primary page itself wasn't directly fetched in this session.) At 1-2 judge users this is a few dollars a month at most — cheap enough to be a reasonable WAF layer if the link is genuinely public, but likely overkill versus a simpler invite-code + Supabase Auth gate given the project's "no over-engineering" constraint (BRIEF.md).
- **Invite codes**: not a GCP/Supabase product feature per se — simplest implementation is a Supabase table of single-use or judge-scoped codes checked at sign-in before issuing a session, composable with the anonymous-sign-in + optional Google-OAuth pattern confirmed in Q2.

---

## Contradictions

1. **Phoenix free-tier numbers** (25k spans, 15-day retention) came only from third-party pricing-aggregator sites (costbench.com, markaicode.com); **no primary arize.com/phoenix pricing page surfaced in search**, so these figures should be treated as plausible but unverified until cross-checked against Arize's own page before being used to size the demo.
2. **Supabase Pro connection/egress numbers** from this batch's web search (500 Realtime connections, 250 GB egress) **agree closely** with the internal corpus's independently-sourced numbers (200/500 connections Free/Pro) — no real contradiction, but both ultimately trace to secondary sources rather than Supabase's own pricing page, so the agreement increases confidence without eliminating the "verify against the primary page" caveat.
3. The internal corpus (I2) flags Phoenix's scale-to-zero span-loss risk as **unmeasured** (reasoned from source, not tested); this route found nothing in Context7 or GDK that resolves it either way — it remains an open risk, not a contradiction, but is worth stating plainly: **no source in either batch has actually run Phoenix on Cloud Run against Supabase at min-instances=0 and confirmed spans survive an idle shutdown.**
4. Gemini **Developer API** spend-cap/tier figures found by web search ($250/$2,000/$20K+ tiers, April 2026 enforcement) are a **different product** from Gemini on **Vertex AI** (D-001's locked provider) — citing them as if they constrain the Arena's own spend behavior would be a contradiction-by-conflation; flagged explicitly, not treated as applicable.

## Open questions

1. Does Phoenix Cloud (Arize AX) support a fixed-region / data-residency choice, and what's its actual auth model (SSO, email/password, SAML) for a small external judge audience? Not found this session.
2. Does Firebase App Hosting default to min-instances=0, and does its request path for a WebSocket/SSE route still respect Cloud Run's 60-minute timeout, or does an intermediate Firebase Hosting/CDN layer impose the 60-second cap documented generically for Firebase Hosting + Cloud Functions/Cloud Run? Not confirmed for App Hosting specifically.
3. Google Cloud Armor's exact current per-request pricing was sourced through a secondary aggregator rather than a direct fetch of `cloud.google.com/armor/pricing` — worth a direct primary-source confirmation before budgeting.
4. Has anyone actually run the 15-minute Phoenix-idle-span-loss spike the prior corpus called for? Not found in either internal doc for this route.
5. What is Vertex AI's own (not Developer API's) rate-limiting/spend-cap behavior relevant to a public judge-facing proxy — this needs a Vertex-specific query in a future batch, since this route's web search only surfaced Developer API tier data.

## Implications for the build

- A **Phoenix Cloud free-tier account** is the lowest-ops path to "a working Phoenix link judges can open," conditional on verifying the real demo-window span count stays under 25k — likely true for the live judge demo itself (1-2 users, one sitting), likely **false** for the full internal bake-off tournament trace volume, which argues for **two separate Phoenix destinations**: Phoenix Cloud (or a lighter sampling) for the judge-facing demo link, self-hosted Phoenix-on-Cloud-Run-plus-Supabase-session-pooler for the tournament's "maximum coverage" internal observability — with the untested idle-span-loss risk run down as a real 15-minute spike before committing to the self-hosted path for anything judges rely on live.
- Supabase: **budget for Pro ($25/mo) for the judging window specifically**, or build an explicit keepalive, to avoid presenting judges a paused free-tier project on demo day; the RLS pattern (unexposed schema + `REVOKE EXECUTE` + pinned `search_path`) is directly actionable now for SCN-5/SCN-9's sealed evaluator packet.
- Cloud Run: the 60-minute WebSocket timeout and instance-based billing while any voice socket is open are the two load-bearing facts for D-006's cost and architecture; `--cpu-boost` (not min-instances) is the compliant cold-start lever under the owner's scale-to-zero hard gate; Cloud Run Jobs (7-day task timeout, configurable parallelism) is a strong fit for running the bake-off's interactive trials in parallel.
- Frontend: Next.js directly on Cloud Run is the safest choice for guaranteeing the live-voice/SSE paths aren't silently capped by an intermediate hosting layer's shorter request timeout; a static/CDN frontend is viable only if its live-feature calls go straight to a separate Cloud Run backend.
- Abuse guards: the kill switch must be Pub/Sub-notification-driven against the project's own cost ledger (consistent with D-007's already-locked design), not reliant on GCP's slow native budget-alert email; per-user rate limiting must live in Supabase, not in-process memory, given Cloud Run's multi-instance autoscaling; Cloud Armor is affordable at this scale but likely unnecessary complexity versus an invite-code + Supabase-Auth gate given the "no over-engineering" constraint.

---

## Query log

**Internal files read (before any external search):**
- `docs/research/BRIEF.md` (full)
- `docs/challenge/REQUIREMENTS.md` (full)
- `docs/handoff/DECISIONS.md` (full, D-001..D-008)
- `docs/research/internal/I2-technomile-corpus-stack.md` (full cat + targeted grep for Phoenix/Supabase/Cloud Run/min-instances/pooler/CPU-throttle lines)
- `docs/research/internal/I4-pangea-adapi-av2-observability.md` (targeted grep for Phoenix/Supabase/Cloud Run/WebSocket/SSE/voice/Live-API lines)

**Google Developer Knowledge MCP (`search_documents`), 9 queries:**
1. "Cloud Run WebSocket support timeout session affinity concurrency billing"
2. "Cloud Run startup CPU boost cold start mitigation without minimum instances"
3. "Cloud Run Jobs parallelism task timeout pricing"
4. "Workload Identity Federation GitHub Actions deploy Cloud Run"
5. "Firebase App Hosting scale to zero Next.js versus Cloud Run"
6. "Cloud Run Secret Manager mount environment variable best practice"
7. "billing budget alert programmatic notifications pub/sub disable billing"
8. "Cloud Run service to service authentication ID token invoker role"
9. "Cloud Run functions WebSocket support limitation streaming responses"

**Context7 (CLI, `npx ctx7@latest`), 5 calls:**
1. `library "Arize Phoenix" "self-hosted auth RBAC session pooler Postgres CPU throttling span loss"` → resolved `/arize-ai/phoenix`
2. `docs /arize-ai/phoenix "self-hosting Phoenix authentication API keys environment variables Postgres database URL"`
3. `library "Supabase" "RLS revoke schema from PostgREST exposed schemas SECURITY DEFINER anon authenticated"` → resolved `/supabase/supabase`
4. `docs /supabase/supabase "RLS schema not exposed to PostgREST exposed_schemas revoke privileges anon authenticated role SECURITY DEFINER functions sealed schema"`
5. `docs /supabase/supabase "Realtime Broadcast vs Postgres changes vs SSE message rate limits anonymous sign-in magic link Google OAuth"`

No Context7 failures or quota errors this session.

**Google web search (`WebSearch`, mode "standard"), 5 queries:**
1. "Arize Phoenix Cloud hosted free tier 2026 limits retention"
2. "Supabase free plan project pause inactivity rule 2026"
3. "Cloud Armor pricing 2026 standard tier security policy cost"
4. "Supabase Pro plan $25 2026 pricing compute egress Realtime connections limit"
5. "Gemini Live API WebSocket proxy backend rate limiting per user spend cap 2026"

Quota met: ≥4 GDK (9 run), ≥3 Context7 (5 calls, 2 resolves + 3 docs), ≥3 Google web (5 run). No files written or modified; no secrets opened.
