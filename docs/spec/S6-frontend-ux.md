# S6: Frontend and UX

Part S6 of the build specification for the Investigative AI Training Arena. **Version 2.4, 2026-10-09: Codex round 2 fixes; D-016 simplifications.** Version 2.1 (same date) reconciled S1, resolved cross-check X-01..X-17 and applied D-013; version 1 was written against direction v10 (hosted, 20 cases).

Governing inputs: `docs/spec/README.md` (baseline facts; it wins over this part), `docs/research/synthesis/02-direction.md` v10.4 (cited as "direction") with D-011 local-first, `docs/research/synthesis/03-ui-direction.md` v2.1 (cited as "UI direction"), `docs/challenge/REQUIREMENTS.md` (requirement IDs), `docs/handoff/DECISIONS.md` (D-001 to D-014; D-007 superseded by D-009; D-013 one global spend ceiling; D-014 case families authored offline), `docs/handoff/PATTERNS.md`, S8 section 2 (owner decisions OD-0 to OD-14) and section 9 (C-01 to C-48), research routes X5, I6, I7 and U1-U5. Lift sources were read directly on 2026-10-08 and are cited by path and line range. Dollar figures come from `docs/research/synthesis/cost_model.py` and statistical bounds from `docs/research/synthesis/stats_contracts.py`; each names the function that printed it.

Scope: the browser application only. Server routes, SQL functions, the voice relay and the scorer are specified elsewhere; where this document needs something from them, it says so in section 15 and designs so the frontend works with the stated contract.

Run mode (D-011): local-first. The browser talks to one local `arena-api` process; `arena-subject` and `arena-referee` run as separate local processes, each with its own database role (`arena_public`, `arena_subject`, `arena_referee`; S5 10); Phoenix runs locally; Vertex AI is the only billed service. The hosted design (Cloud Run, IAP, hosted judge link) is kept in 1.4 as a deferred variant (WP-33, owner decision OD-10).

The owner's DESIGN.md has not arrived. This spec makes no visual decisions: no colors, type, spacing values, illustration style or layout aesthetics. It fixes structure, behavior, contracts, accessibility, performance and tests, and exposes design token hooks (section 11) that DESIGN.md fills. PATTERNS.md says "until DESIGN.md lands, no UI implementation"; everything here that does not depend on visual design (contracts, reducers, state machines, SSE client, voice machine, tests, the plain unstyled slice UI) can be built before it, and that is the intended order. **Nothing presentational starts before the 2026-10-18 slice gate:** no DESIGN.md styling pass, character art, signature motion or motion-library spike (direction 3.1; UI direction 1.2 and 2; section 14).

Conventions: requirement IDs in parentheses; acceptance criteria are numbered `FE-<area>-<n>` and each is testable; "OWNER DECISION PENDING" marks a point the owner decides, with a design that works for either answer.

---

## 0. Requirement coverage

| Requirement | Where in the UI | Section |
| --- | --- | --- |
| CH-1, SOL-1, SOL-2, SOL-6 | Interview room, text and voice, practice and assessment; text transcript is the scored artifact; voice is unscored practice (D7) | 4.3, 5, 6.2 |
| CH-2, AST-1..AST-3, AST-6..AST-8, EX-1..EX-3 | Coach card (S2 card.v1): question assessment, answer category, cited flags, neutral follow-up, running finding | 4.5 |
| AST-7 | Citation chips resolve to an exact turn and quoted span; a quote not found is shown as such | 4.5 |
| AST-10, PRB-3, PRB-4 | No stress or nervousness meters; equal visual weight for the three findings; companion never rewards accusations | 6.3, 7 |
| SCN-4, SCN-7, SCN-10 | Evidence board (court record), released records with turn, trigger and whole content (body and table) | 4.4 |
| SCN-5, SCN-12, BKO-9 | One server-authorized projection for every surface; hidden-case material never reaches the browser before reveal | 5.4 |
| SCN-3, SCN-11 | Persona and voice assigned per family, independent of role | 6.4, 7 |
| EVL-1, EVL-2, EVL-7, KPI-1 | Debrief: five 0-4 cards, three scorecards, annotated transcript, progress | 4.7, 4.8 |
| CH-4, BKO-1..BKO-7, BKO-10 | Arena: tournament matrix, pipeline rail, replay and interactive tracks | 4.9, 6.5 |
| EVL-3..EVL-6, EVL-9..EVL-11, KPI-2, KPI-3, KPI-5 | Leaderboards: gates before rank, intervals, provisional flags, manifest hash | 4.10 |
| EVL-12, EX-4 | Trust center, methodology, EX-4 placements | 4.11, 8 |
| BKO-3, EVL-7 | Trainer console, blinded review | 4.12 |
| KPI-4 | Client acknowledgement of the validated card; render budget | 5.6, 10 |
| Security (local HTTP boundary) | Host, Origin and CSRF rules for every state-changing request (D10) | 1.3 |
| SUB-7 | Untrusted subject text rendered as text only, never HTML or markdown | 4.3 |

---

## 1. Technology decision

### 1.1 Framework: Vite + React (single-page app), not Next.js static export

Both run modes serve one static build same-origin from `arena-api`: locally from the `arena-api` process (D-011, S5 10), and in the hosted variant from Cloud Run behind IAP (direction DM-6, 1.4). Both candidates can produce a static build; Vite fits better.

| Factor | Next.js `output: 'export'` | Vite + React + React Router | Weight |
| --- | --- | --- | --- |
| Runtime-ID routes (`/sessions/:id`, `/arena/:tournamentId/trials/:trialId`) | Not supported: static export rejects dynamic routes without `generateStaticParams()` and with `dynamicParams: true` (Next.js docs, `static-exports.mdx`, "Unsupported Features", Context7 `/vercel/next.js`, 2026-10-08). IDs are created at runtime, so every such page would become a query-string page or a catch-all client router, which is Vite's model with more config. | Native (`createBrowserRouter`, path params) | High |
| Server features we would give up anyway | Route handlers, cookies, rewrites, headers, proxy, server actions, image optimization: all unsupported in export (same source). SSR has no value: no SEO need, and every page reads typed API projections. | Not present, nothing to disable | Medium |
| Lift fit | TechnoMile web is Next 16.3.6 (`web/package.json`), but the lifted pieces (`ticketed-stream.ts`, `office.ts`, `lib/pipeline/*`) are client code (`"use client"`), portable as-is | gokbase `recruiter-frontend` (voice, kin, worklets) is already Vite + React 19 + Tailwind 4 + Vitest + Playwright (`recruiter-frontend/package.json` lines 7-17, 95-148); its bundle gate reads the Vite manifest (`scripts/check_pet_bundle.mjs` lines 6-7) | Medium |
| Worklet assets | `public/` works | `public/worklets/*.js` same-origin, exactly as gokbase (`audioController.ts` lines 15-16, 31-32) | Low |
| Moving parts | Next build pipeline plus export constraints | One bundler, one router | Medium |

**Decision: Vite + React 19 + React Router (data mode) + Tailwind CSS 4, TypeScript strict.** (H)

### 1.2 Versions (checked 2026-10-08)

Pins are the newest stable release published on or before 2026-09-24 (two weeks old), read from the npm registry (`npm view <pkg> time`), with APIs checked in Context7. Re-verify at scaffold; pin exact versions, no ranges.

| Package | Pin | Published | API checked |
| --- | --- | --- | --- |
| `react`, `react-dom` | 19.3.0 | 2026-09-09 | Same version as TechnoMile web |
| `vite` | 8.3.1 | 2026-09-24 | Context7 `/vitejs/vite` (v8 line present); Node `^20.19.0 \|\| >=22.12.0` |
| `@vitejs/plugin-react` | 6.1.1 | 2026-08-28 | |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.3 | 2026-07-16 | Context7 `/tailwindlabs/tailwindcss.com`: first-party Vite plugin, `@import "tailwindcss"`, `@theme` variables generate utilities |
| `react-router` | 8.4.0 | 2026-09-15 | Context7 `/websites/reactrouter`: data mode `createBrowserRouter(routes, opts)` + `RouterProvider`, `lazy` route modules; peer `react >=19.2.7`, Node `>=22.22.0` |
| `typescript` | 6.0.3 | | TechnoMile-proven. 7.0.2 (native port, 2026-07-08) exists; adopt only if typescript-eslint supports it at scaffold |
| `vitest`, `@vitest/coverage-v8` | 5.0.1 | 2026-09-15 | |
| `@testing-library/react` | 16.3.3 | 2026-08-27 | |
| `@playwright/test` | 1.63.0 | 2026-09-04 | |
| `@axe-core/playwright` | 4.13.0 | 2026-08-11 | |
| `radix-ui` | 1.6.7 | 2026-07-24 | Same as TechnoMile; accessible primitives only (dialog, tabs, popover, tooltip), unstyled |
| `ajv` | verify at scaffold | | Runtime validation of SSE and REST payloads against the shared JSON Schema (section 5.2) |
| `motion` | verify at scaffold (same two-week rule) | | Context7 at scaffold; state-driven UI motion and signature moments (UI direction 2, C-38a) |
| `gsap` | not installed | | Added only if the post-slice spike wins (6.6); pinned from npm at that time (UI direction 6: sources disagree on the current version) |

Motion stack (UI direction TL;DR 5 and section 2; C-38a): Motion for state-driven UI and the signature moments; plain CSS transitions and keyframes for everyday transitions; per-frame character rigs ride CSS custom properties set outside React (gokbase `kin/KinLayer.tsx` lines 669-670), never a library. GSAP only if the post-slice spike shows it does better (6.6). No 3D runtime, no state library, no data-fetching library. Hot-path animation uses `transform` and `opacity` only (TechnoMile `docs/design/motion.md` lines 5, 38). Icons and fonts are DESIGN.md decisions.

### 1.3 Serving, origin and identity (local default)

| Concern | Rule | Requirement |
| --- | --- | --- |
| Origin | One origin per process. The local `arena-api` process (`arena_public`, port 8080, S5 10) serves `dist/` and `/api/*`; snapshot at `GET /api/trials/{id}/snapshot`, SSE at `/api/trials/{id}/events`, voice WebSocket at `/api/voice/ws`. The admin and trainer consoles are the same bundle served by `arena-referee` on port 8082 (4.12, 4.13). No CORS headers anywhere. In development the Vite dev server proxies `/api` (with `ws: true`) to 8080, so the browser still sees one origin. | D-011 |
| SPA fallback | `GET` requests for non-`/api`, non-asset paths with `Accept: text/html` return `index.html` | |
| Caching | Hashed assets `Cache-Control: public, max-age=31536000, immutable`; `index.html` `no-cache` | |
| CSP (set by `arena-api`) | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <same-host ws origin>; worker-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. The WebSocket origin is the same host (`ws:` locally, `wss:` hosted). No inline scripts, no third-party origins, no analytics. Worklets are same-origin static files (gokbase `audioController.ts` lines 15-16). | SUB-7, security |
| Identity | Locally the S5 10.3 dev identity middleware (`ARENA_ENV=local`, bound to 127.0.0.1) supplies the user; the browser holds no login credential. **No Supabase Auth in the browser** (C-03): the browser never talks to Supabase or PostgREST; every read and write goes through typed routes of the process that served the page (direction 4.1: "Served only through explicit typed projections"). `GET /api/me` returns `{user_id, display_name, roles[], quotas, ex4_acknowledged, study, csrf_token}` (S5 5.5); `study` is the KPI-1 status (3.2). | SCN-5 |
| Request protection (D10, S5 10.3) | Loopback binding and the absence of CORS headers do not stop another site from posting to `127.0.0.1` as the acting user, so both processes check every browser request: the `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (else 421); every POST to a browser route must carry an allowed `Origin` (else 403) and an `X-Arena-CSRF` header equal to the `arena_csrf` cookie (`SameSite=Strict`, `HttpOnly`) that `GET /api/me` sets, else 403. The client's one fetch wrapper in `src/lib/api/` calls `GET /api/me` first, keeps `csrf_token` in memory, and adds `X-Arena-CSRF` to every POST, bodyless ones included (stream and voice tickets, debrief, acknowledgements); on a 403 it re-reads `/api/me` once and retries once. The header also makes every POST a non-simple request. Service-to-service routes under `/internal/` take S5 10.3's internal policy instead (caller token, no browser credentials) and the browser never calls them (SG4-22). | security |
| Kill switch and quotas | `arena-api` answers `503` with `{"code":"paused"}` when the kill switch is on (S5 4.8) and `429` on a per-user quota (S5 5.5); open streams get a `notice` frame; the app shows a plain banner stating why (direction 8.3, D-009) | D-009 |

Acceptance:
- FE-TECH-1: `vite build` emits only static files; a test serves `dist/` from a plain static handler and every route in section 2.2 loads by direct URL (SPA fallback).
- FE-TECH-3: a source lint fails the build on any `fetch(` outside `src/lib/api/` and on any import of `@supabase/*`.
- FE-TECH-4: the built `index.html` and JS contain no absolute `http(s)://` origin other than documentation links in the trust center.
- FE-TECH-5: unit test of the fetch wrapper: every POST it sends carries `X-Arena-CSRF` with the token from `/api/me`, a 403 triggers one `/api/me` re-read and one retry, and no request is sent before the token is known. The server-side refusals (foreign Origin, missing or wrong token, foreign Host) are S5 10.4's tests; E2E-14 runs them from the browser against both origins.

### 1.4 Hosted variant (deferred, WP-33, owner decision OD-10)

Applies only if the owner approves a hosted judge link (OD-10; default is local only, demo by screen share). Same bundle, same routes, same contracts; what changes:

| Concern | Hosted rule |
| --- | --- |
| Origin | `arena-api` on Cloud Run behind IAP serves `dist/` and `/api/*` same-origin; no CORS (IAP rejects cross-origin preflights, DM-6). CSP `connect-src 'self' wss://<host>`. |
| Identity | IAP cookie on every request; `arena-api` verifies the IAP JWT assertion and maps it to an allowlisted app user; `arena.actor_id` is set from the mapped user. Still no Supabase Auth in the browser (C-03). Final shape decided in WP-33. |
| IAP session expiry | Every `fetch` sends `credentials: 'same-origin'`, `X-Requested-With: XMLHttpRequest` and, on POST, `X-Arena-CSRF` (1.3), so IAP answers an expired session with `401` instead of a `302` (GDK, `docs.cloud.google.com/iap/docs/sessions-howto`, 2026-10-08). On `401` the app shows a non-blocking "Session expired" banner with a "Sign in again" button that opens `<origin>/?gcp-iap-mode=DO_SESSION_REFRESH` in a new window and polls `GET /api/me` with the same header until `200`, then closes it and resumes. `EventSource` cannot set headers; its ticket mint is a `fetch`, so expiry surfaces there and triggers the same flow. |
| Stream cost | An open SSE request keeps an `arena-api` instance billed for its whole duration (GDK `run/docs/triggering/websockets`, 2026-10-08); the 60 s hidden-tab close and terminal `finish()` of 5.1 carry this reason, and `stream_max_s` bounds every response (S5 6.4). |
| Cold start | Data regions show skeletons during a Cloud Run cold start; the shell is static and unaffected (section 10). |
| Admin console | Path decided in WP-33 (candidate: `gcloud run services proxy arena-referee`; C-39). |
| Probes before enabling | WebSocket upgrade through IAP on Cloud Run is unconfirmed (no source read states it); add it to the day-1 probe matrix, and if it fails, voice stays local-only. IAP adds per-request latency (GDK `iap/docs/enabling-cloud-run`, known limitations); the hosted KPI-4 benchmark runs through IAP. |

Acceptance (hosted only):
- FE-TECH-2: a Playwright test with a mocked `401` on `/api/me` shows the expiry banner, and the "Sign in again" button opens a URL ending `?gcp-iap-mode=DO_SESSION_REFRESH`.

---

## 2. Information architecture

### 2.1 Roles (from `GET /api/me` on the origin that served the page)

| Role | Who | Sees |
| --- | --- | --- |
| `investigator` | Team, volunteers (KPI-1); the demo presenter in the local default | Case library, own sessions, debrief, progress, arena (projected), leaderboards, trust center |
| `judge` | Allowlisted judges (D-008), hosted variant only (OD-10) | Everything `investigator` sees; same per-user quotas |
| `trainer` | Blinded human raters (EVL-7 and EVL-8 calibration, KPI-1 scoring) | Trainer console only, served by the local `arena-referee` process (4.12); each task shows only what its task kind allows (S3 7.3); never participant or candidate identity, phase or dates |
| `admin` | Team leads | Admin console, served by the local `arena-referee` process on its own port (4.13) |

Locally one acting user per run (S5 10.3): switching users restarts the processes, so KPI-1 participants and raters work one at a time at the operator's machine unless OD-10 approves hosting. On the referee origin the shell boots from that process's own `GET /api/me` and `GET /api/config` (S5 5.5), which answer only users with role `admin` or `trainer`.

### 2.2 Routes and screens

| Route | Screen | Roles | Requirements |
| --- | --- | --- | --- |
| `/onboarding` | EX-4 acknowledgement, how coaching works, recording notice, voice disclosure | all | EX-4 |
| `/` | Case library | investigator, judge | PRB-1, PRB-2 |
| `/cases/:caseId` | Case brief and session start (mode, channel) | investigator, judge | SCN-7, SOL-6 |
| `/sessions/:sessionId` | Interview room (text or voice; practice or assessment) | owner of session | CH-1, SOL-1, SOL-6 |
| `/sessions/:sessionId/debrief` | Debrief | owner of session | EVL-1, EVL-2, EVL-7 |
| `/progress` | Progress and KPI-1 study status | investigator | KPI-1 |
| `/arena` | Tournament list | all | CH-4 |
| `/arena/:tournamentId` | Tournament matrix and pipeline rail | all | BKO-1, BKO-7 |
| `/arena/:tournamentId/trials/:trialId` | Trial replay | all (projected) | BKO-6, BKO-9 |
| `/leaderboards/:tournamentId?` | Assistant, subject and investigator scorecards | all | EVL-1, EVL-3..EVL-6, EVL-9..EVL-11 |
| `/trust`, `/trust/:section` | Trust center: isolation, commitments, fairness, methodology, budget | all | EVL-12, EX-4, SCN-5 |
| `/review`, `/review/:itemId` | Trainer console (only on the `arena-referee` process origin) | trainer | BKO-3, EVL-7 |
| `/admin` | Admin console (only on the `arena-referee` process origin) | admin | BKO-9 |

Route modules are lazy (`lazy: () => import(...)`), so the room, arena, voice and character art load only when used. "Interview room" is the name in all judge-facing copy (C-38f); "interrogation room" survives only as an internal code name.

---

## 3. User flows

### 3.1 Practice, text (the slice flow; CH-1, SOL-6 Practice)
1. First visit: `/onboarding`; the EX-4 statement must be acknowledged (server-stored) before any session starts.
2. Case library: pick a development case (the server lists one variant per family, 4.2); choose Practice; channel Text.
3. `POST /api/sessions {case_id, mode, voice, idem_key}` returns the session with its `trial_id` and the phase the server derived; the room reads `GET /api/trials/{id}/snapshot` and then opens the trial stream after the snapshot's `last_seq` (section 5).
4. Loop, up to 12 exchanges (BKO-8): the investigator types one question, optionally using "Present" to insert a record's title and a selected excerpt into the question text (4.4), and sends; the subject panel shows "Answering"; the answer appears as turn `T{n}`; the coach card for that turn appears once complete and validated, with cited flags, a neutral follow-up and the running finding (AST-1..AST-3). Between turns the investigator may request a record from the requestable list; a release appears on the evidence board with its turn (SCN-4).
5. The investigator commits a finding (the shared `Finding`, 4.6): label, ICD 203 likelihood, confidence, cited turns or records, rationale, and for "insufficient evidence" the corroboration to seek (EX-3). At exchange 12 the composer locks and commit is required.
6. `finalize_trial()` runs server-side; the room shows the commitment hash from `trial.finalized`, then links to the debrief. The stream stays open for catch-up until the debrief is published (5.1).

### 3.2 Assessment, text (SOL-6 Assessment; KPI-1 pre and post tests)
Same as 3.1 except: no coach card, no coach activity, no running finding, and the companion sleeps for the whole session (6.3). Coaching is computed and stored server-side; the debrief reveals it. The room header states "Assessment: coaching is saved for your debrief."

KPI-1 study (SG4-10): the request never carries a phase. The server derives it from committed state (`training.start_session`, S4) and enforces the order: two pre-tests, three practice sessions (Practice mode, text, finalized; an assessment-mode or voice free session does not count, SG3-31), two post-tests; tests run in assessment mode, in text, once per test variant. The client reads the participant's status from `GET /api/me` (`study`: counterbalance, ended sessions per phase, the next allowed phase) and shows it as the step label ("Pre-test 1 of 2", "Practice 2 of 3", "Post-test 1 of 2"). While the next phase is `pre` or `post`, `GET /api/cases` lists only that set's variants, and the case brief offers Assessment in Text only; a refused start (422) shows the server's step message. After each session the client re-reads `/api/me`.

### 3.3 Practice, voice (D-006; development cases only, direction section 9; unscored, D7)
Voice sessions are unscored development practice: their turns enter the transcript with channel `voice`, are coached like text turns, and never enter a score, a KPI or a leaderboard (S5 7). The room header and the debrief say "Voice practice: not scored".
1. Channel Voice is offered only in Practice mode, on a case the library listed (development cases only), when `config.voice_available = true` and the user's voice quota is non-zero. Test sessions are text only.
2. Disclosure and consent screen (gokbase pattern: disclosure plays before the mic opens, `audioController.ts` lines 22-24); then `POST /api/voice/tickets {trial_id}` and a same-origin WebSocket to `/api/voice/ws` with subprotocol `[ticket]` (S5 7.2; gokbase `useVoiceSession.ts` lines 10-11, 308-328).
3. The investigator speaks; the subject answers in audio; live transcript fragments render as one caption line; each server-finalized turn (`turn_committed {turn_no, version}` on the socket) is followed by its text on the SSE stream, which enters the transcript as `T{n}` and triggers the same coach card as text (S5 7.3, C-29); a card on a voice turn is labeled provisional (S5 7.7).
4. Records are requested through the same evidence board and route as in text (4.4); the server refreshes the subject's context after every release (S5 7.4). Nothing about evidence crosses the voice socket from the browser.
5. Interrupted subject utterances are marked partial ("interrupted: may include words you did not hear") and are not citable (direction 9, F10).
6. The session ends at 12 exchanges (close 4410), 480 s, idle (4408), cost shutoff (4413), kill switch (4423) or user stop; the investigator then commits a finding in text.

**OWNER DECISION PENDING (OD-6, direction 3.2 decision points, Oct 15 and Oct 18):** voice may become Live on Vertex (default), push-to-talk STT-LLM-TTS (D-006 exception), Developer API Live (D-001 exception) or dropped. The voice machine (6.2) has a `mode: 'live' | 'push_to_talk'` input; push-to-talk replaces `listening` with `recording` held by an explicit control. If voice is dropped, `config.voice_available = false` hides the channel and nothing else changes.

### 3.4 Debrief and progress (EVL-1, EVL-2, EVL-7, KPI-1)
Debrief opens after the trial ends and calls `POST /api/sessions/{id}/debrief` (S5 5.4: runs R3 in resumable stages, idempotent), then reads `GET /api/sessions/{id}/debrief`. Both return the same published `debrief.v1` document (S3 5.7), read from `training.v_my_debrief`; the GET answers `scoring` until it is published. Rubric cards show "Scoring" until the document arrives (the POST returns, the GET returns it, or `debrief.ready` arrives); the annotated transcript, read from the ended trial's snapshot, is available at once. Progress shows the participant's score series and, for study participants, pre and post results with absolute change and relative change (undefined when pre = 0, EVL-7/KPI-1 contract in direction 7.2).

### 3.5 Judge path (D-008; matches S7 section 2)
Local default (OD-10 unanswered): the presenter runs onboarding, one practice session, debrief, `/arena`, `/leaderboards` and `/trust` on the local stack by screen share; judges receive video, deck and repo. Hosted variant: judges sign in through IAP and walk the same path themselves (1.4). Quota messages state the reason plainly.

### 3.6 Trainer review (BKO-3, EVL-7, EVL-8)
`/review`, on the referee process origin (S5 10.1), lists the items assigned to this rater. Each item is one task of S3 7.3's three kinds (T-RUB, T-LAB, T-FLAG); `GET /api/review/items/{id}` returns only the fields that kind allows, and the rater submits the proxy's own binary fields (checks, labels, verdicts), never a 0-4 dimension score; the server derives dimension scores with S3 2.8's mapping. One submission per item and rater.

### 3.7 Admin (BKO-9)
Admin uses the console served by the local `arena-referee` process (4.13): tournament lifecycle, budget ledger, subject validity review queue, reveal with precondition checklist, kill-switch status (read-only; the owner runs `scripts/kill_switch.sh`).

---

## 4. Screens and components

Each component lists its data source and acceptance criteria. Layout and visual treatment come from DESIGN.md; region names below are structural.

### 4.1 Onboarding (EX-4)
- Regions: EX-4 statement (the sponsor's exact text, section 8), what the coach does and does not do, what is recorded, the voice disclosure, a link to methodology.
- Acknowledge button calls `POST /api/me/ack-ex4` (stored once per user by `training.acknowledge`, S4; X-15); `GET /api/me` returns `ex4_acknowledged` as the stored time or null.
- FE-ONB-1: no session-start control in the app is enabled while `ex4_acknowledged = false` (Playwright).
- FE-ONB-2: `EX4_TEXT` equals, character for character, the sponsor's sentence after the "Ground rule:" label on slide 8 (`docs/challenge/unissant-use-case.txt` line 99; REQUIREMENTS EX-4); the unit test reads that file.

### 4.2 Case library (PRB-1, PRB-2)
- Data: `GET /api/cases` (development cases only; hidden cases are never listed, SCN-12). The server lists **one case per family per user**, the variant chosen by a seeded per-user draw; once a family's debrief has been shown to a user, its sibling variant is never offered to that user; KPI-1 case-set families are never listed for practice, and a participant receives their assigned set whole for the pre-test and post-test (C-37, X-08; enforced in S5 and S4). The client renders the list it receives and has no control that chooses or switches a variant.
- Card fields: case ID, domain, investigation objective (one line), difficulty, completion status for this user, available channels. **Not shown: communication style, role, family ID, matched-variant relationships** (style shown before an interview primes demeanor reasoning, PRB-4; family ID lets a user pair matched variants).
- Study participants see their assigned step ("Pre-test", "Practice", "Post-test") from `GET /api/me` `study`, with the server-assigned case set (counterbalanced, direction 7.2 KPI-1 protocol; 3.2).
- FE-LIB-1: a contract test asserts the case-list schema has no `style`, `role`, `family_id` or `variant` fields; the client schema rejects a payload containing them. (Server side, S5 adds a route test that no investigator or assistant route returns style before reveal, C-26.)
- FE-LIB-2: the case brief (`/cases/:caseId`, `GET /api/cases/{id}`) renders the full public packet (SCN-7: case ID, objective, known timeline, initial documents, interview context).
- FE-LIB-3: a direct URL to a case the server did not list for this user renders "Not available" (server `404`), and no screen offers a sibling or variant switch.

### 4.3 Interview room (CH-1, SOL-1, SOL-6)

Regions:

| Region | Content | Practice | Assessment |
| --- | --- | --- | --- |
| Case header | Case ID, objective, exchanges used `n/12`, mode badge, channel | yes | yes |
| Subject panel | Subject portrait (6.4), persona display name, status word ("Listening", "Answering", "Session ended") | yes | yes |
| Transcript | Turns `T1..Tn` with speaker, text, release markers; partial voice turns marked "interrupted" | yes | yes |
| Composer | Editable question input (receives "Use this question" and "Present" insertions), Send | yes | yes |
| Voice bar | Pill-shaped bar docked at the bottom (6.2), voice sessions only; transcript, evidence board and coach card stay visible | yes (unscored, D7) | no (voice is offered in practice only, 3.3) |
| Evidence board | Section 4.4 | yes | yes |
| Coach card | Section 4.5 | yes | hidden (placeholder text "Coaching is saved for your debrief") |
| Companion | Section 6.3 | practice states | `sleeping` |
| Finding commit | Section 4.6 | yes | yes |
| EX-4 footer | `EX4_TEXT`, persistent (section 8) | yes | yes |

Behavior:
- One open turn at a time (S4 5.3, S5 5.1). Send is disabled from `question.accepted` until the turn closes: in practice, until `coach.card` or `coach.failed` for that turn; in assessment, the client cannot see coaching events, so Send re-enables on `subject.answer`, and a `409 turn_in_progress` keeps the draft and shows "One moment: the previous turn is still being saved." (section 16, item 1).
- Question length limit from `GET /api/config` (`question_max_chars`, 600; D11), displayed as a counter. A `422 context_full` on a turn means the interview can take no more context (S5 5.2): the composer locks with "This interview has reached its length limit; commit your finding." and the finding commit becomes the primary action.
- Subject and coach text are untrusted (SUB-7): rendered as plain text nodes, never `dangerouslySetInnerHTML`, never markdown. Quoted spans are highlighted by offset, not by HTML injection.
- Transcript region is `role="log"` with `aria-live="polite"`, mounted from the start and never unmounted (gokbase `Transcript.tsx` lines 15-18, 472-473); voice captions batch announcements at clause boundaries or every 400 ms (same file, lines 310-325). Transcript text never types out character by character.
- Mobile (< 768 px): regions become tabs (Transcript, Evidence, Coach); composer, voice bar and EX-4 footer stay pinned and do not obscure focused content (WCAG 2.4.11).
- Terminal statuses other than `completed` show a neutral message: `subject_quarantined` -> "The session was stopped for a platform check. It is not counted." (never names the subject's behavior); `infra_failed` -> "The session stopped because of a technical fault."; `budget_skipped` / `budget_truncated` -> "The session stopped because the spend limit was reached."

Acceptance:
- FE-ROOM-1: a component test with a fixture event sequence renders turns in seq order regardless of arrival order and ignores duplicate seqs.
- FE-ROOM-2: an XSS fixture (`<img src=x onerror=...>` and markdown links in subject text) renders as literal text; no new elements in the DOM.
- FE-ROOM-3: in assessment mode the coach card region contains no coach text after a full fixture session (and the client logs a contract violation if any `coach.*` event arrives, section 5.4).
- FE-ROOM-4: after 12 exchanges, or after a `422 context_full`, the composer is disabled and the finding commit is the only primary action.
- FE-ROOM-5: each terminal status renders its neutral message; the `subject_quarantined` message contains none of the words "attack", "injection", "deceptive", "lying".
- FE-ROOM-6: practice fixture: Send stays disabled between `subject.answer` and `coach.card`; assessment fixture: a mocked `409 turn_in_progress` keeps the draft text unchanged and shows the fixed message.

### 4.4 Evidence board, court-record pattern (SCN-4, SCN-7, SCN-10)

The pattern follows Ace Attorney's always-visible court record (X5 section 1): an inventory the investigator can consult and present. One change from the game pattern: records are **never tagged with the statements they contradict**, because contradictions are evaluator-only (SCN-9). The investigator draws those links.

- Sections: Initial documents (`doc-NN`, from the public packet), Released records (`rec-NN`, each with "released at turn n", trigger `scheduled` or `requested`, the record `date` when it carries one (C-21) and the document kind when `doc_kind` is set (C-24)), Requestable records (from the public list; a Request button calls `POST /api/trials/{id}/evidence-requests {record_ids: [id], idem_key}`, allowed only between turns: `409` during an open turn; S5 5.4, C-18). Identifiers follow C-16.
- Content is rendered whole (S1 6.1, AC-S1-30): the record's `content` object arrives in `evidence.released` and the snapshot; the board shows its `body` as text and its `table`, when present, as a table with its header row, every cell as a text node. No surface shows `body` alone.
- The request returns `200 {released, already_released, denied, transcript_version}` (S5 5.4). An id in `denied` (requested too early) shows "Not available at this point in the interview" without the predicate (predicates are evaluator-only, SCN-9) and the record stays requestable; a scheduled record released by the same call appears through its `evidence.released` delta like any other. The client only sends ids from the requestable list, so the `422` for an unknown id is a contract violation, reported as such.
- **Present (C-19):** opens the document or record as a list of lines: the sentences of its body, then one line per table row as S1 6.1's `content_text()` renders it (`cell | cell | ...`); the investigator selects one or more (checkboxes, keyboard-operable) and chooses "Insert into question", which inserts `Record "<title>": "<excerpt>"` at the composer cursor. The excerpt is trimmed so the question stays within the configured length limit, and the investigator can edit the result before sending. No record ID travels with the question: the subject and the J2 judge open disclosure gates from what the question text presents (S2 6.4; Strategic Use of Evidence, direction 6.1).
- Personal pins: the investigator can pin a record to a transcript turn ("relates to T4"). Pins are page state only (S5 5.4, SG4-18): they are not stored, disappear on reload, never leave the browser and never reach the coach or subject.
- FE-EVD-1: a released record appears within one render of its `evidence.released` event, in release order, with turn and trigger.
- FE-EVD-2: a record in the response's `denied` list shows the fixed generic string and stays requestable; nothing else from the response is displayed.
- FE-EVD-3: Present is keyboard-operable without drag (WCAG 2.5.7); only documents and records visible on the board can be presented; the inserted text appears in the composer and is editable; the turn request schema has no `presented_record_ids` or other record-ID field (contract test).
- FE-EVD-4 (AC-S1-30): with the F01 fixture, `rec-02`'s radio-log table renders cell for cell on the board, each row is a selectable Present line, and the same rows appear in the debrief's released-record view.
- FE-EVD-5: no request body, URL or header carries a pin (network capture over a fixture session with pins).

### 4.5 Coach card with citation chips (AST-1..AST-8, EX-2, EX-3)

One card per subject turn (direction 6.1). The card on a training frame is the **training wire card**: S2's stored card.v1 (C-04) without candidate identifiers (`candidate_sha256`, the candidate id; S5 5.2, SG4-05). `contracts/` exports three separate schemas, the stored card, the training wire card and the tournament wire card (which keeps the identifiers, after reveal or on a dev tournament), and the frontend's validators are generated from the two wire schemas only; the client renders S2's field names and nothing else. The newest card is expanded; earlier cards collapse into a per-turn list.

**Complete-card reveal (UI direction 2):** a card is accepted only when its `coach.card` frame passes schema validation and is transcript-current: its envelope `transcript_version` equals the client's context version for that turn, which is the version of the last frame applied for the turn, the `subject.answer` or a release that followed it before any next question (in voice a scheduled release commits with the answer, so the card reads the release's version; SG4-23). The same rule applies to deltas, snapshots and replay, so a card overtaken by a later question or release is dropped and a card after a scheduled release is kept. Until a card is accepted the region shows a neutral loading state ("Coach is reading T5", only between `coach.working` and the card). After acceptance the fields may stagger in for polish; nothing from an unaccepted card ever reaches the screen. A card that fails acceptance is dropped, counted and acknowledged as `client_invalid` (5.6).

| Card field (S2 card.v1) | Display |
| --- | --- |
| `question.question_type`, `question.neutrality_issues`, `question.assessment` | Question type and each neutrality issue as plain words; the one-sentence assessment |
| `answer_category` | Responsive, non-responsive, contradiction, explicit uncertainty, possible evasion (AST-8) |
| `flags[]` (`kind`: `gap`, `non_responsive`, `possible_evasion`, `contradiction`, `evidence_conflict`; code-filled `flag_ref`) | Rendered through the S2 4.5 flag template: chip for `turn_id` + `quote`; a second chip for `conflict_turn_id` + `conflict_quote`, or a record chip for `conflict_record_id` + `conflict_record_quote`; `missing_fact` as text |
| `follow_up.question`, `tactic`, `purpose`, `record_request` | One neutral question, its tactic and purpose as words, a "Use this question" button that copies the question into the composer (the investigator may edit); when `record_request` is set, the line "Suggests presenting <record title>" pointing at that record on the board |
| `finding` (`label`, `likelihood`, `confidence`, `basis_flag_refs`, `corroboration_needed`, `rationale`; code-filled `last_revised_turn`, `cited_turns`, `cited_records`) | Rendered client-side through the S2 4.5 finding templates: the ICD 203 phrase from `likelihood` with its range (S2 4.2 table) about S2's proposition, then the confidence sentence, then "Last revised at turn n"; followed by `EX4_TEXT` (S2 4.5, section 8) |
| Demeanor callout | When `question.neutrality_issues` contains `demeanor_reference`, the card says the question relied on how the subject seems (PRB-4) |
| `coach.update` (S2 deep.v1, candidate A1 only) | Its `finding` supersedes the card's for display; evidence coverage per record as words |
| `boundary_notice`, `commit_requested`, `validation`, `latency_ms`, `card_seq` | Not displayed, except that a flag whose `validation` entry has `citation_ok: false` renders the "quote not found" state |

Citation chip behavior (AST-7):
- Label `T{n}` derived from S2's `tNN` (C-16), accessible name "Turn n: <first 60 characters of the quote>".
- Activation scrolls the transcript to that turn, moves focus to it, and highlights the quoted span.
- The client checks the quote with `quoteOk(quote, text)`, the TypeScript port of S2's one shared predicate `quote_ok` (S2 1 and 4.4.1; D6), tested against the same fixture file as the Python module. Normalization: Unicode NFKC; curly quotes and apostrophes to straight; every dash U+2010 to U+2015 and U+2212 to `-`; whitespace runs to one space; trimmed; case kept. A quote matches when its normalized form is a substring of the normalized text and has at least 3 words, or equals the whole normalized text when that text is shorter. The text is the cited turn's committed answer, or the cited record's `content_text()` (S1 6.1). On no match the chip renders a "quote not found in T{n}" state and is excluded from highlight. The UI never presents an unverifiable citation as verified (X5 section 1, Obra Dinn principle); scoring of unsupported flags remains server-side (EVL-5).
- Partial (interrupted) voice turns are never valid citation targets; a chip pointing at one renders the "not citable: interrupted" state.

Failure states: `coach.failed` shows "Coaching for this turn was not available" and counts as a KPI-4 miss server-side; the room continues.

Acceptance:
- FE-COACH-1: EX-1/EX-2 fixture ("Why did you enter?" / "It was a busy shift.") renders answer category "Non-responsive", a flag of kind `non_responsive` naming the missing fact "purpose of entry" with chip `T1`, and follow-up "What task required entry?".
- FE-COACH-2: EX-3 fixture with `finding.label = insufficient_evidence` and `corroboration_needed` ["the work order", "the timeline"] renders the S2 4.5 insufficient template beginning "More evidence is needed." and naming both items.
- FE-COACH-3: a flag whose quote does not match renders the "quote not found" state: `quoteOk` passes or fails every case of S2's shared quote fixture file exactly as the Python `quote_ok` does, including an em dash against a hyphen (match), a two-word substring of a long answer (no match), the whole of a two-word answer (match) and a substring of a record's table row (match); no fuzzy match.
- FE-COACH-4: chip activation moves focus to the turn element and the turn's quoted span has `data-highlighted="true"`.
- FE-COACH-5: the three finding labels render with the same component and token family; no label maps to a different size, weight or motion (snapshot of computed classes per value).
- FE-COACH-6: a fixture card with `question.neutrality_issues` containing `demeanor_reference` renders the demeanor callout text (PRB-4).
- FE-COACH-7: complete-card reveal: a card whose `transcript_version` differs from its turn's context version, or that fails schema validation, renders nothing and is acknowledged `client_invalid`; a voice fixture with answer version 7, a scheduled release at 8 and a card at 8 renders the card, and a card at 7 in the same fixture is dropped (SG4-23), through delta, snapshot and replay alike; `renderFinding()` output equals the S2 4.5 templates for each label (table test).
- FE-COACH-8 (SG4-05): a valid stored card fixture, projected by the server fixture, validates against the training wire schema; the same card with `candidate_sha256` or a candidate id is rejected by the client validator on the delta, snapshot and debrief paths.

### 4.6 Finding commit (SOL-5, EX-3, BKO-9; C-27)

The dialog produces the one stored finding object used by assistants and investigators alike (S2 4.8: `$defs.Finding` plus `cited_turns`, `cited_records` and optional `alternative_explanations`), filled as S2 4.8's investigator column states.

| `Finding` field | Control | Rule |
| --- | --- | --- |
| `label` | Three options (deceptive, truthful, insufficient evidence), none preselected, equal weight | Required |
| `likelihood` | The seven ICD 203 terms with ranges (S2 4.2), offering only the terms S2 4.2 allows for the chosen label | Required |
| `confidence` | Low, moderate, high | Required |
| `cited_turns`, `cited_records` | Pick turns (`T{n}`, sent as `turn_no` integers) from the transcript and released records (`rec-NN`) from the board | At least one for deceptive and truthful (form rule; S3 dimension 5 scores the support) |
| `corroboration_needed` | 1-3 entries, each 3-120 characters | Required for insufficient evidence (EX-3) |
| `rationale` | Text, 1-600 characters (D5) | Required |
| `alternative_explanations` | Up to 3 entries, each 3-160 characters | Optional |
| `basis_flag_refs` | Not shown | Always empty for investigator findings (S2 4.8) |

- The dialog also shows the EX-4 statement and a Confirm button.
- Confirm calls `POST /api/trials/{id}/finding {finding, idem_key}` (S5 5.4, C-18); any field outside `Finding` is refused (`422`), as is a citation of a turn that is not an answered, non-partial turn or of a record not on the board. The turn picker therefore offers only answered, non-partial turns, and the record picker only initial documents and released records. A `409` (a turn is still open) keeps the draft and reloads the room state.
- After `trial.finalized` arrives, the room shows its commitment hash (copyable, signature moment in 6.6) and "Open debrief".
- FE-FIND-1: Confirm is disabled until the required fields for the chosen label are present; the likelihood list per label equals S2 4.2 (table test over the three labels).
- FE-FIND-2: a `409` keeps the draft and shows "The interview changed; review and confirm again."
- FE-FIND-3: the dialog contains the EX-4 text.
- FE-FIND-4: the request body validates against the shared `Finding` schema in `contracts/` (contract test).

### 4.7 Debrief (EVL-1, EVL-2, EVL-7, EX-4)

Data (D8, SG4-07): one published document per session, `debrief.v1` (S3 5.7 owns the payload; S4 `training.debriefs` stores it, written only by the referee's `training.publish_debrief`). `POST /api/sessions/{id}/debrief` and `GET /api/sessions/{id}/debrief` return that same document (S5 5.4); the GET answers `scoring` until it is published. The client validates it against `contracts/debrief.v1.schema.json` and renders it; it computes nothing but formatting. The annotated transcript comes from the ended trial's snapshot (`GET /api/trials/{id}/snapshot`), which after the trial ends includes the coaching the mode withheld (S5 6.2).

Regions:
1. Header: case, mode, date, EX-4 statement; for a voice session, "Voice practice: not scored" (D7).
2. Outcome: `outcome.role`, `outcome.correct_finding`, the investigator's `outcome.committed_label` beside it, and `outcome.resolution` (the case's resolution summary). This is the one place a development case's role appears, and only because the session has ended (the explicit exception in 5.4's visibility matrix). Hidden-split material never appears (SCN-12; a hidden case has no debrief). After this debrief the family's sibling variant is never offered to this user (C-37, server-enforced).
3. Five rubric cards (EVL-7), from `rubric.dimensions` (D1 clarity and neutrality; D2 response relevance; D3 evidence-based follow-up; D4 testing alternative explanations; D5 supported closure). Each card: the 0-4 `score`, the dimension's anchor text for that score from the rubric bundled with the build (S3 2), and its `checks` (pass, fail or n/a, each with the turns that decided it). Total = `rubric.total` (0-100), shown as the server value; when `rubric.scorable` is false the cards are replaced by `unscorable_reason`. Provenance line: rubric and prompt hashes and referee model ids from `provenance`, plus a link to the methodology page's calibration status (4.11). When the document arrives the scores count up to the server values (signature moment, 6.6); the final displayed number is always the server value.
4. Three scorecards for this session (EVL-1), from `scorecards`: learning (`evidence_coverage` as "n of m key facts asked about" and each key question's intent with the turns that addressed it, EVL-2); detection (the session coach's flags scored against R3's independent evasion labels through R3's J3 verdicts on those flags, S3 5.7: strict and broad true positives, flags and events, unique flags, unsupported flags by reason, and the coach's last running label beside the case outcome); subject realism (compliant turns of all turns, failures by check). Numbers come from the server; the client formats only.
5. Annotated transcript: per turn, question type, answer category, flags with chips (with the EX-4 evasion sentence beside them, section 8), the coach's suggested follow-up next to the question actually asked next, released-record markers with whole content (4.4), and demeanor-driven question callouts (PRB-4). In assessment mode this is where coaching first appears. Pins are page state and do not appear here (4.4).
6. Export: JSON (the `debrief.v1` document plus `EX4_TEXT`) and print view; both carry EX-4.

A voice session's document has `scored: false` (S5 5.4): the debrief shows the header, outcome and transcript with the "not scored" label, and no rubric cards or scorecards.

- FE-DEB-1: until the document is published, rubric cards show "Scoring" and no number; reopening a debrief calls the idempotent `POST` again and shows the same stored document (equal `sha256`).
- FE-DEB-2: the total displayed equals `rubric.total` (no client arithmetic; a fixture with an inconsistent total still shows the server value, the test asserts the client never sums, and the count-up ends on the server value).
- FE-DEB-3: the detection scorecard renders every field of `scorecards.detection` from a fixture, including zero denominators as "undefined", and the coach's last label next to `outcome.correct_finding`.
- FE-DEB-4: assessment-mode debrief shows the coach cards that were withheld during the session.
- FE-DEB-5 (visibility): the outcome region renders only from `debrief.v1`; the snapshot and delta schemas of a running trial have no `role`, `correct_finding` or `resolution` key (contract test), and a fixture running session renders none of those words' values.
- FE-DEB-6: a `scored: false` fixture renders the "not scored" label, the outcome and the transcript, and no rubric card or scorecard.

### 4.8 Progress (KPI-1)
- Score series per session with dimension breakdown (`GET /api/progress`); study participants see pre, post, absolute change and relative change, or "relative change undefined (baseline 0)", once both post-tests are scored.
- KPI-1 is reported only from participants who completed the protocol (two pre-tests, three practice sessions, two post-tests, 3.2). With none, the investigator scorecard (4.10) and every KPI-1 surface read "KPI-1 not measured"; no other data stands in for it (S7 1.10).
- No streaks, no reminders, no loss framing, no "catch" counts (X5 section 4: Duo and Tamagotchi retention mechanics rejected).
- FE-PRG-1: with pre = 0 the relative change cell reads "undefined" and absolute change is shown; with no completed participant the KPI-1 cells read "KPI-1 not measured".
- FE-PRG-2: a text search of the rendered page finds none of: "streak", "don't lose", "caught", "liars".

### 4.9 Arena: tournament matrix and pipeline rail (CH-4, BKO-1..BKO-7, BKO-10)

- Tournament list: state (draft, frozen, running, sealed, scoring, revealed), split (dev or hidden), seed, roster manifest hash, reserved and settled spend against the one `global` ceiling (server values from the `ops` projection; D-013).
- Matrix (dev and revealed tournaments): rows assistants A1-A3, columns subjects S1-S3 (BKO-4). Each cell: planned trials, counts by execution state (`completed`, `subject_quarantined`, `assistant_failed`, `infra_failed`, `budget_skipped`, `budget_truncated`, and `source_unavailable` for the replay assistant, C-35), the current trial's progress `turn n/12` on a running dev tournament, and a caption line. Selecting a cell makes the pipeline rail (6.5) follow that pairing's current trial.
- Progress table (hidden tournament before reveal; D9): per track and block, planned trials and counts by execution state, from `arena.v_tournament_progress` through the poll. No pairing cell, trial, text, card, record or flag count exists on this view.
- Track tabs: Replay track (BKO-6) and Interactive track (BKO-7), shown in the sponsor's order (BKO-2).
- Data (C-17, D9): no tournament stream and no merged cursor. The view reads `GET /api/tournaments/{id}` (states and counts) and polls `GET /api/tournaments/{id}/events?after=<N>`, where `N` is the global ledger sequence of the last tournament frame received (5.3), every 2 s while the tournament is running, sealed or scoring and the tab is visible, stopping after the response that reports `revealed` (S5 6.2, SG4-29); draft, frozen and revealed tournaments are read once. A response with `visibility: "counts"` carries only the progress counts; when a response switches to `visibility: "events"` (the tournament was revealed), the client discards its tournament state and restarts at `after=0`.
- Before reveal on a hidden tournament the view is the progress table above (section 5.4): no text, no findings, no case identity, no coaching beats, no pipeline rail.
- Trial detail and replay `/arena/:t/trials/:trial` (dev tournaments at once, hidden tournaments only after reveal): the followed or selected trial's own frames from `GET /api/trials/{id}/replay?after=<seq>`, paged by that trial's own `seq` (polled every 2 s for a running dev trial the rail follows); transcript, coach cards, releases and finalize, played on the replay clock (6.5).
- FE-ARENA-1: given a hidden-tournament pre-reveal fixture, no element in the DOM contains any transcript string from the post-reveal fixture of the same trials (leak test).
- FE-ARENA-2: matrix counts equal the server's counts by execution state for every cell; on a hidden pre-reveal fixture the progress table equals the server's per-track, per-block counts and no matrix cell renders.
- FE-ARENA-4: on an open hidden-tournament page driven through running, sealed, scoring and revealed, polling continues until the revealed response and then stops (SG4-29); a poll response that switches from `counts` to `events` resets the tournament state and the next request carries `after=0`; trial replay requests carry the trial's own `seq`, never the ledger sequence (fake transport test).
- FE-ARENA-3: replay controls (play, pause, scrub, 1x/2x/4x) are keyboard-operable and the scrubber has `aria-valuetext` "n of m events" (TechnoMile `agent-office.tsx` lines 212-218).

### 4.10 Leaderboards (EVL-1, EVL-3..EVL-6, EVL-9..EVL-11, BKO-9, BKO-10, KPI-2, KPI-3, KPI-5)

All numbers are read from `arena.leaderboards` through `arena-api` after reveal; the client computes nothing but formatting. Three separate scorecards (EVL-1): Assistants, Subjects, Investigators.

**Assistant leaderboard, in this order on the page:**
1. Header: tournament, track, "bound to inclusion manifest `<hash>`" (copyable full hash), roster manifest hash, reveal time, EX-4 statement, EVL-10 sentence "A tournament rank is not certification for real investigations.", and a "Corrected leaderboard" label with a link to the original when the manifest is a later one (direction 7.1).
2. Eligibility gate panel per candidate, shown before any rank (EVL-6, KPI-5, PRB-3): FPR point estimate with its interval and the sponsor gate (`<= 5%`, pass or fail); for zero events, the complete-family one-sided bound and its family count as provided by the server (for example, at the 30-case baseline's 15 truthful families: "0 of 15 truthful families; one-sided 95% upper bound 18.1%", from `stats_contracts.zero_event_upper_bound(15)`; the page prints the server's value for the actual count); isolation gate pass or fail with a link to `/trust/isolation`; "insufficient" when the candidate has no included truthful trials.
3. Ranked eligible candidates: rank interval (best to worst from the bootstrap, X5 LMArena rank-spread pattern), deceptive-role recall with interval, questioning quality with interval, provisional marker with the server's reason (attrition sensitivity, own deceptive coverage below 90%).
4. Ineligible candidates listed below, unranked, each with the failing gate stated.
5. Detail per candidate: PPV, the 2x3 count matrix with raw counts, unresolved rate by role (EVL-9), evasion-event precision and recall ("undefined" for zero denominators), unsupported-flag rate, cost per trial, p95 coaching latency with interval (KPI-4), coverage and attrition per role, exclusions by execution state.
6. Role prevalence in the included set (BKO-10).

Reveal moment (UI direction 2, 6.6): when a revealed leaderboard first loads, the official rank, eligibility and provisional status appear unchanged and at once; rank intervals draw in at their actual endpoints, and overlap is labeled as uncertainty, never as a tie rule.

**Subject leaderboard (EVL-4, EVL-11, KPI-3):** all-turn fidelity (primary) with interval, valid-session fidelity (secondary), invalid-session rate, deceptive success split into misleading clearance and unresolved, truthful consistency and appropriate uncertainty, correct recognition as an interaction outcome; the shared-checkpoint disclosure (referee labels on the same model as S1, direction 7.2).

**Investigator scorecard (EVL-2, EVL-7, KPI-1):** participant-level relative and absolute change with intervals, n, and the note that it is "a demonstration of the instrument, not a causal claim" (direction 7.2); "KPI-1 not measured" when no participant completed the protocol (4.8).

**Exhibition section:** OWNER DECISION PENDING (OD-11, A2A exhibition track). Rendered only when `config.exhibition_enabled = true`, under its own heading with the label "exhibition: model, prompt and budget unverified", never merged with the official table.

Acceptance:
- FE-LB-1: a fixture where candidate X has FPR 6% and the highest recall renders X in the ineligible list, unranked, with "FPR gate failed".
- FE-LB-2: every metric cell with an interval renders both bounds; a fixture missing an interval renders "interval unavailable", never a bare point.
- FE-LB-3: the manifest hash shown equals the leaderboard record's `inclusion_manifest_hash`.
- FE-LB-4: the EVL-10 sentence and EX-4 are present (text assertion).
- FE-LB-5: before reveal the route shows "Results are sealed until reveal" and no numbers.

### 4.11 Trust center (EVL-12, EX-4, SCN-5, BKO-9, P2, P3, P8)

| Section | Content | Source |
| --- | --- | --- |
| Isolation | The capability matrix (direction 4.3) rendered from the same JSON fixture the tests use (bundled at build), plus the latest gate run per check: pgTAP privilege tests, route tests including direct calls to the subject and referee processes (locally each on its own port with its own credential; IAM-private services in the hosted variant), assistant-context type test, hidden-split seal, commitment verification, canary audit hits; run time and commit SHA | `arena.isolation_checks` |
| Commitments | For a revealed tournament: per trial, commitment hash, transcript and evidence hashes, and after reveal the nonce; a "Verify in browser" button recomputes the commitment with WebCrypto SHA-256 using the ledger spec's construction and shows match or mismatch | ledger projections |
| Fairness audit | FPR and flag rates by communication style with intervals, unsupported style-based flags per assistant, the permutation test result, and the demeanor-driven negative-control fixtures with their detection result (PRB-4, SCN-3) | server |
| Methodology | Every metric's estimand, unit and interval method (direction 7.2), attrition rules, the zero-event bound explanation, judge calibration results, the NIST AI RMF MEASURE mapping, and the EVL-12 statement that NIST has not validated these thresholds | static content plus server values |
| Budget | D-009 cap ($75, `cost_model.CAP`) and target ($50, D-009); the applied `global` ceiling and spend to date from the reservation ledger, grouped by purpose label (D-013); the planned case count n printed from the server (30 baseline, 34 only if OD-8 approves after the dev pilot). The ceiling is whatever the operator applied from `cost_model.budget_plan()` (D-012); before the plan is applied it reads $0 and the section states "Budget plan not applied: no model spend is possible." The client never holds a ceiling of its own. | `ops.*` projection |
| Observability | Local default: Phoenix runs locally (D-011); the section shows a dated static p95 latency panel image captured from local Phoenix and says so; operators get the local Phoenix link from `config.phoenix_url`. Hosted Phoenix belongs to the hosted variant (S5 D-P3, OD-10). | config |

- FE-TRUST-1: commitment verification test: a fixture with known inputs shows "match"; one altered byte shows "mismatch".
- FE-TRUST-2: the methodology page contains the EVL-12 non-validation statement and EX-4.
- FE-TRUST-3: the capability-matrix table renders every row of the fixture file (count equality).
- FE-TRUST-4: budget fixture with all ceilings at $0 renders the "Budget plan not applied" statement; a fixture with applied ceilings renders the server values unchanged (no client arithmetic).

### 4.12 Trainer console, blinded review (BKO-3, EVL-7, EVL-8, KPI-1)
- Served like the admin console by the referee process from the same bundle (S5 5.5, 10.1), because ratings land in rows only `arena_referee` may write (C-34); `arena-api` serves no `/api/review/*` route. The shell boots from the referee's own `GET /api/me` and `GET /api/config` (2.1).
- Item list (`GET /api/review/items`): opaque item IDs and their task kind only, shuffled server-side, assigned to this rater.
- Item screen (`GET /api/review/items/{id}`): one task of S3 7.3, rendered from a per-kind response schema; the screen shows exactly the fields that kind returns:

| Task kind | Shown | Submitted (`POST /api/review/items/{id}`) |
| --- | --- | --- |
| T-RUB (EVL-7: investigator sessions, assistant proposals) | Public case file, released records with release turns, the transcript with speaker labels "Investigator" and "Subject", the question sequence being scored, the committed finding, the code-built trigger entries (turn IDs only) | Per question: question type and the five per-question checks; per other sub-check: pass, fail or n/a with deciding turns; per finding citation: supports or not |
| T-LAB (EVL-8 labels and fidelity; calibration raters on development cases, and the post-reveal audit on hidden trials of a revealed tournament, S3 7.3, SG4-27) | Transcript, released records with release turns, the private ledger (facts, uncertainty, gates with precondition records), permitted behaviors and canonical facts; the role is therefore implied (S3 7.3 item 3) | Per turn: label with `eva_subtype` or `pfq_reason`, and the F1-F6 checks |
| T-FLAG (flag support) | Transcript, released records, the flags with their claims | Per flag: the four J3 answers |

- Never shown on any task: participant or candidate identity, phase (pre or post), session dates and times, case-set label, mode badge, proxy outputs and verdicts, any other item's rating. No rater enters a 0-4 dimension score (S3 7.3 item 4).
- FE-REV-1: each per-kind response schema contains none of `participant`, `user`, `candidate`, `phase`, `pre`, `post`, `date`, `created_at`, `mode`, and the T-RUB and T-FLAG schemas none of `role`, `private`, `ledger`; the client schemas reject a payload containing them (contract test).
- FE-REV-2: the screen renders no timestamps (text and attribute scan).
- FE-REV-3: Submit requires every field the task kind requires; the request body has no 0-4 dimension field (contract test); a second submit for the same item is answered idempotently by the server and shown as "already submitted".
- FE-REV-4: on the `arena-api` origin, `/review` renders "Not available here" and the bundle makes no `/api/review/*` request.
- FE-REV-5 (server, SG4-27): a T-LAB audit item on a hidden trial is refused (404) while its tournament is not `revealed` and served after reveal, without candidate identity.

### 4.13 Admin console (served by `arena-referee`; C-39)

The capability matrix routes admin operations through `arena-referee` (direction 4.3). Locally the referee process serves the same static bundle on its own local port (S5 10: 8082) next to its `/api/me`, `/api/config` and `/api/admin/*` routes (S5 5.5); an admin opens that origin directly, and the app, being origin-relative, boots from the referee's `/api/me` (with its own CSRF token, 1.3) and talks to the referee's admin routes. `arena-api` serves no admin routes and its build shows no admin entry point (`/api/me` never returns `admin` on the `arena-api` origin). The hosted path is decided in WP-33 (1.4).

- Screens: tournament lifecycle with allowed transitions; budget ledger (reservations, settled spend, the applied `global` ceiling, cap); kill-switch state, read-only, with the owner's command `scripts/kill_switch.sh on|off` printed beside it (`ops.set_kill_switch` is owner-only and the console runs on the `arena_referee` credential, X-14); subject validity review queue (blinded: candidate IDs hidden) recording `valid` or `subject_invalid` with reason; reveal page listing each precondition (roster frozen, one execution record per planned trial, every subject review resolved, replay corpus sealed, commitments verified) as computed by the server, with Reveal enabled only when all pass; inclusion manifest view.
- No infra controls (workers, instances, timeouts, health checks) and no bucket-ceiling editor appear in any UI (global owner-approval gate; ceilings are applied by the operator from `budget_plan()`, D-012).
- FE-ADM-1: on the `arena-api` origin, `/admin` renders "Not available here" and the bundle makes no `/api/admin/*` request.
- FE-ADM-2: Reveal is disabled while any precondition is false (fixture).
- FE-ADM-3: E2E-15 opens `http://127.0.0.1:8082/admin` and `/review` directly on the local stack: each shell boots from the referee's own `/api/me` and `/api/config`, a trainer opens one item of each task kind, and an admin performs one idempotent POST with the referee's CSRF token.

---

## 5. Live event contract

### 5.1 Transport

- **Snapshot, then deltas** (D9, SG4-03). On opening the room the client reads the trial's absolute state from `GET /api/trials/{id}/snapshot` (REST, no size cap; S5 5.5, 6.2), folds it into the reducer, and opens the stream with `after=<snapshot.last_seq>`. The stream carries deltas only. On a reconnect the client resumes with `after=<lastSeq>` and needs no new snapshot; on a fresh page load it reads the snapshot again.
- **Server-sent events**, one stream per trial: `GET /api/trials/{id}/events?ticket=..&after=<lastSeq>` (S5 6.3), where `seq` is the trial's own sequence. Client: TechnoMile `web/src/lib/sse/ticketed-stream.ts` (lines 1-206), lifted. Each connection mints a single-use ticket by `fetch` (`POST /api/trials/{id}/stream-tickets`, with the CSRF header of 1.3), then opens the `EventSource`. The server replays `seq > after` through the projection and continues live, with `id: <seq>` per persisted frame and `: ping` after 15 s of silence (S5 6.4; TechnoMile `frames.ts` lines 15-31: resume from `?after=` or `Last-Event-ID`, larger wins), and ends every response at `stream_max_s` (S5 6.4); the client reconnects transparently.
- **Backoff for the trial stream** is changed from the donor's `2 s x attempt` (`ticketed-stream.ts` line 69) to `[250, 1000, 2000, 4000, 8000]` ms, because a 2 s first retry alone would break the 3 s KPI-4 budget on any reconnect (I7 implications).
- **Catch-up check:** every `POST` that produces events returns `last_seq` (S5 5.2); if the stream's last accepted seq is below it 1 s later, the client reconnects with `after=<lastSeq>`.
- **Stream lifetime:** the client opens a trial stream while the trial is running and, after it ends, until its debrief is published: stream tickets are issued for an ended trial for catch-up until then (S5 6.3, SG3-18), so frames emitted around the end (`trial.status`, `trial.finalized`, `debrief.ready`) are never lost to an early close. The client calls `finish()` when `debrief.ready` arrives or the debrief GET returns the document, and thereafter reads the debrief over REST. When publication commits but `debrief.ready` is lost with the connection, the replacement ticket is answered 409 `stream_closed` (S5 6.3): the client then reloads the snapshot and the debrief and finishes without reconnecting; a fresh visit to an ended session does the same and never opens a stream (SG4-21); it closes the stream after 60 s with the tab hidden (`visibilitychange`) and resumes with `after=` when visible (in the hosted variant this also stops instance billing, 1.4).
- **Tournaments:** no stream and no merged cursor; the arena polls its own ledger cursor, and trial replay pages each trial by its own `seq` (4.9, 5.3, D9).
- **Voice** uses its own WebSocket (section 6.2); its transcript turns also enter the trial event log, so the trial stream is the single source for transcript and coaching.

### 5.2 Envelope

One JSON Schema file per viewer-facing shape, exported from the backend's pydantic models into the repo (`contracts/events.schema.json` for frames, plus the snapshot, wire-card, `debrief.v1` and review-task schemas; WP-02), is the single source of truth. Stored records and wire shapes are separate schemas: the frontend generates TypeScript types and compiled `ajv` validators from the wire schemas only (SG4-05). Every frame, snapshot and REST payload is validated at runtime. Frames failing validation, or with unknown `type`, are dropped and counted, never rendered (gokbase `voiceMachine.ts` lines 125-163: unknown frames are ignored as defense in depth). Deltas carry absolute values so re-applying an event is idempotent (TechnoMile `lib/contracts/run-events.ts` lines 1-10). Every SSE delta is at most 16 KB serialized, which S4's 14,336-byte payload limit guarantees with room for the envelope (S5 6.2); there is no oversize fallback and no other frame type. Snapshots travel over REST and have no SSE size limit.

```json
{
  "v": 1,
  "seq": 42,
  "scope": "trial",
  "scope_id": "trl_...",
  "type": "coach.card",
  "ts": "2026-10-20T15:04:05.123Z",
  "transcript_version": 7,
  "data": {}
}
```

`seq` is the persisted row's per-trial sequence and the SSE `id`. Synthesized frames (5.3) are sent without an SSE `id` and carry `seq: null`; they never advance the cursor and are idempotent hints (S5 6.2). The snapshot (REST) carries `last_seq`.

### 5.3 Event types

S4's persisted kinds stay as they are; `arena_core/events/projections.py` (S5 6.2, which owns the mapping) turns rows into wire frames and synthesizes the frames marked below (C-17). Turns are keyed by `turn_no` (C-16); S2's `tNN` appears only inside card payloads, and the UI label `T{n}` is display only.

Trial scope:

| Wire type | Source | `data` | Emitted when |
| --- | --- | --- | --- |
| (snapshot, REST) | `GET /api/trials/{id}/snapshot`, folded by the projection from the same frames | `{status, mode, channel, split, exchanges_used, exchanges_cap, turns[], released[], requestable[], cards[], finding?, commitment_hash?, last_seq}` (absolute state, projected; released records with their whole `content`) | Before the stream opens; not an SSE frame |
| `question.accepted` | `question_recorded` | `{turn_no, text, source, channel}` | Question committed |
| `subject.thinking` | synthesized after `question_recorded` | `{turn_no}` | Subject work started |
| `evidence.released` | `evidence_released`, `clarification` | `{record_id, title, kind, doc_kind?, date?, content, released_at_turn, trigger: scheduled \| requested}`; `content` is S1's whole Content object (`body` plus optional `table`), never flattened | `release_evidence()` committed |
| `subject.answer` | `subject_turn` | `{turn_no, text, channel: text \| voice, partial, committed_at}` | `record_subject_turn()` committed |
| `coach.working` | synthesized after a text `subject_turn`, practice only | `{turn_no}` | Coach call started |
| `coach.card` | `coach_card` | `{turn_no, card}`: the training wire card (4.5): S2 card.v1 with its code-filled fields, without candidate identifiers | Card validated server-side |
| `coach.update` | `coach_deep` | `{turn_no, update}`: S2 deep.v1 | Candidate A1 deeper update |
| `coach.failed` | `coach_unavailable` | `{turn_no, reason: timeout \| repair_failed}` | Card missed (X-11) |
| `finding.committed` | `finding_committed` | `{by: investigator \| assistant, finding, committed_at}`; `finding` is the shared `Finding` (C-27) | Finding submitted |
| `trial.status` | synthesized on `trial_ended` (the snapshot carries the same `status` field); derived from trial status and the terminal record (C-45) | `{status, reason_code?}`; `status` in `running, completed, subject_quarantined, assistant_failed, infra_failed, budget_skipped, budget_truncated` | Trial ends |
| `trial.finalized` | `trial_ended` with `completed` | `{commitment_hash}` | `finalize_trial()` committed |
| `debrief.ready` | `debrief_ready` (appended by `training.publish_debrief` in the transaction that stores the debrief; D8) | `{session_id}` | Debrief published |
| `notice` | synthesized | `{kind: paused \| quota, text}` | Kill switch, quota (the voice time warning arrives on the voice socket as `warning`, 6.2) |

Completion frames (SG4-02): one `trial_ended` row yields `trial.status` first and, when the trial completed, `trial.finalized` second. The row's `seq` (SSE `id`) rides on the last frame of the pair: on `trial.finalized` when the trial completed, on `trial.status` otherwise; the other frame has no `id` (S5 6.2, X-15). The cursor therefore advances only after both frames arrived, and a disconnect between them replays the row as both frames again (idempotent). Exchanges used are counted from turns. `finalizing` is not a wire status: the client shows it between its own finding submit and the terminal `trial.status` (C-45, 6.1).

Tournament scope (polled; D9, S5 6.2). Two sources, two cursors, never merged:

| Source | Cursor | Response | Frames |
| --- | --- | --- | --- |
| `GET /api/tournaments/{id}/events?after=N` | `N`: the global `ledger.v_events` sequence | `{visibility: "events", frames[], last}` for a dev or revealed tournament; `{visibility: "counts", progress[]}` for a hidden tournament before reveal | `tournament.status {state}`, `trial.started {trial_ref, trial_id, pairing, track, block}`, `replay.turn {trial_ref, turn_no}` (a corpus turn copied into a replay trial), `trial.finalized {trial_ref, commitment_hash}`, `trial.execution {trial_ref, state}` (including `budget_skipped`). `progress[]` rows: `{track, block, planned, counts_by_state}` |
| `GET /api/trials/{id}/replay?after=S` | `S`: that trial's own `seq` | The visible trial's frames, as the trial scope above (`question.accepted` with its `source`, `evidence.released`, `subject.answer`, `coach.card` as the tournament wire card, `coach.update`, `coach.failed`, `finding.committed`, `trial.status`, `trial.finalized`) | Same shapes as the trial scope |

`trial_ref` is an opaque per-tournament ordinal, not a case ID; `trial_id` appears only on visible tournaments, so the replay route can be called. `latency_ms` (from the card's code-filled field and the subject turn) drives motion (6.5) where the frame provides it. There is no block-start frame (X-15) and no `referee.labeled` or `budget.*` frame; budget figures come from the tournament `GET` (server values). When a poll response switches from `counts` to `events`, older rows have just become visible, so the client restarts at `after=0` (4.9).

### 5.4 One visibility rule (UI direction 2a)

Every animation, caption, connector, highlight, pipeline detail and replay consumes the same server-authorized event projection, filtered by viewer, mode (practice or assessment), split (development or hidden), session end and reveal state before events leave the server, including on reconnect and replay. The client has no second data path for motion: animated components take projected reducer state as their only input (FE-SSE-7). The client re-checks as defense in depth and reports violations to `POST /api/telemetry/contract-violation` (which writes a log line; it never alters state).

| Field or event | Practice (running) | Assessment (running) | Owner's ended development session (debrief) | Hidden tournament before reveal | Revealed or dev tournament | Trainer review |
| --- | --- | --- | --- | --- | --- | --- |
| Role label, correct finding, resolution summary | never | never | **shown** in the debrief outcome only, from `debrief.v1` (the one exception, D8) | never | never (role prevalence only as leaderboard aggregates) | T-LAB implies the role (S3 7.3); never stated |
| Tag proposals, guard results, referee labels, release predicates, evaluator packet, nonces before reveal | never | never | never (R3 results only as `debrief.v1` scores and counts) | never | never (labels appear only as leaderboard aggregates) | never |
| Private packet (ledger, permitted behaviors, canonical facts) | never | never | never | never | never | T-LAB only |
| Subject and coach candidate IDs (including `candidate_sha256`) | withheld | withheld | withheld | roster only (frozen and public), never per trial | shown | withheld |
| Communication style, family ID | withheld | withheld | withheld | withheld | shown in fairness audit only | withheld |
| `coach.working`, `coach.card`, `coach.update`, `coach.failed` | sent | **withheld until the session ends** | full (annotated transcript) | none | full, through trial replay | flags only in T-FLAG; otherwise withheld |
| Coaching-derived motion: contradiction connectors, evidence highlights tied to coaching, companion `noticing` and `encouraging` | shown | never during the session | none (still debrief) | never | replay only | never |
| Running finding, `finding.committed.finding` | sent | investigator's own only | full | withheld | full | committed finding in T-RUB |
| Question and answer `text`, `evidence.released.content` | sent | sent | sent | withheld | full | sent, without dates |
| `ts`, dates | sent | sent | sent | withheld (counts carry none) | sent | withheld |
| Trials, `trial_id`, `trial.execution` states | own trial | own trial | own trial | block-level counts only (`progress[]`) | sent | n/a |

Acceptance:
- FE-SSE-1: `ticketed-stream` lift passes its 13 donor tests (`ticketed-stream.test.ts`) plus: first retry at 250 ms on the trial stream; the first connection uses the snapshot's `last_seq` and later ones the last accepted seq; a rejected (invalid) frame or a synthesized frame (`seq: null`) does not advance the cursor.
- FE-SSE-2: the trial reducer is order-independent and duplicate-safe: property test over random permutations and duplications of a fixture log yields the same state.
- FE-SSE-3: in assessment mode, a fixture stream containing a `coach.card` causes no render, no acknowledgement and one contract-violation report.
- FE-SSE-4: hidden pre-reveal fixture: the tournament state holds only `progress[]` rows after folding: no `trial_ref`, `trial_id`, `text`, `card`, `record` or flag count key.
- FE-SSE-5: the trial stream closes within 61 s of the tab becoming hidden and reconnects with `after=<lastSeq>` on visibility; after a terminal `trial.status` it stays open (and reconnects with a catch-up ticket if dropped) until `debrief.ready` or a published debrief GET, then calls `finish()` with no reconnect; the tournament poll stops while the tab is hidden. SG4-21 cases: publication committed and the connection dropped before `debrief.ready`; the publication response lost; a direct visit after publication: each ends in the debrief view from snapshot and debrief GET, with no stream opened after the 409.
- FE-SSE-6: a delta over 16 KB or failing schema validation is dropped and counted; a snapshot over 16 KB (the maximal session of S5 6.5) is accepted over REST.
- FE-SSE-8 (SG4-02): a fixture with a `running` status in the snapshot and a non-terminal reconnect stays out of `ended`; a disconnect after `trial.status completed` and before `trial.finalized` resumes, receives both frames again, and shows the commitment hash once.
- FE-SSE-9: the visibility matrix above is a table test: each row's fixture frames, folded for each column's viewer, render or withhold exactly as the table says (the server enforces it first, S5 6.5; this is the client's re-check).
- FE-SSE-7: a lint rule forbids imports from `src/lib/api/` in `src/components/{companion,avatar,arena,motion}/**`; those components read reducer state only.

### 5.5 REST routes (S5 5.5 is canonical; C-18)

This section no longer defines routes. The frontend consumes S5 5.5's route table as generated into `contracts/openapi.json` (WP-02); where this summary and that file differ, the file wins. The client never invents turn numbers or work items; it sends a fresh idempotency key per action (`idem_key`; direction 4.2, S5 5.1). No request carries `presented_record_ids` (C-19).

| Route (S5 5.5) | Used by |
| --- | --- |
| `GET /api/me` (returns `csrf_token` and sets the cookie; 1.3), `POST /api/me/ack-ex4`, `GET /api/config` | Shell, onboarding, study status (4.1, 3.2) |
| `GET /api/cases`, `GET /api/cases/{id}` | Case library and brief (4.2; one variant per family, C-37; test sets for study participants) |
| `POST /api/sessions {case_id, mode, voice, idem_key}` (no phase; the server derives it), `GET /api/sessions/{id}` | Session start and room |
| `GET /api/trials/{id}/snapshot` | Room state before the stream opens; ended trial for the annotated transcript (5.1, 4.7) |
| `POST /api/trials/{id}/turns {question, release_ids[], expected_version, idem_key}` | Composer (the room sends `release_ids: []`; records are requested through the next route) |
| `POST /api/trials/{id}/evidence-requests {record_ids[], idem_key}` | Evidence board (4.4) |
| `POST /api/trials/{id}/finding {finding, idem_key}` | Finding commit (4.6) |
| `POST /api/trials/{id}/stream-tickets`, `GET /api/trials/{id}/events?ticket=&after=` | Trial SSE (5.1) |
| `POST /api/voice/tickets {trial_id}`, `GET /api/voice/ws` (WebSocket; subprotocol `[ticket]`) | Voice (6.2) |
| `POST /api/telemetry/kpi4 {trial_id, turn_no, client_valid}` | Card acknowledgement (5.6) |
| `POST /api/telemetry/contract-violation` | Projection re-check (5.4) |
| `POST /api/sessions/{id}/debrief`, `GET /api/sessions/{id}/debrief`, `GET /api/progress` | Debrief and progress (4.7, 4.8) |
| `GET /api/tournaments`, `GET /api/tournaments/{id}`, `GET /api/tournaments/{id}/events?after=` | Arena, polled on the ledger cursor (4.9) |
| `GET /api/trials/{id}/replay?after=` | Trial detail and replay on the trial's own `seq` (4.9, 6.5) |
| `GET /api/leaderboards/{tournament_id}`, `GET /api/trust/{section}` | Leaderboards and trust center (4.10, 4.11) |
| `arena-referee` origin: `GET /api/me`, `GET /api/config`, `GET /api/review/items`, `GET /api/review/items/{id}`, `POST /api/review/items/{id}`, `/api/admin/*` | Console bootstrap, trainer console, admin console (2.1, 4.12, 4.13) |

Every POST in this table carries `X-Arena-CSRF` (1.3).

### 5.6 KPI-4 acknowledgement (C-28; S3 6.4 is canonical)

KPI-4 is measured on the server clock: start = `subject_commit_at` (`clock_timestamp()` inside `record_subject_turn()`), end = `client_ack_at` (`clock_timestamp()` when `ops.ack_card(trial, turn_no, client_valid)` records the client's acknowledgement; X-11). The measure includes one uplink transit, so it is conservative. The client's only job is to acknowledge promptly and honestly:

- On a `coach.card` frame (practice mode, the only population that receives live cards, S3 6.4), the client runs the acceptance check of 4.5 and immediately, before rendering, posts `{trial_id, turn_no, client_valid: true | false}` to `POST /api/telemetry/kpi4` (S5 8.7) with `keepalive: true`. One acknowledgement per turn; the server keeps the first and ignores later ones, so a retry is safe.
- No client clock value, duration or round trip is sent. The v1 `GET /api/ping` RTT measurement and `card_minus_answer_ms` arithmetic are removed.
- Only cards on text turns are acknowledged: a voice turn opens no KPI-4 sample (S5 7.4), so the client skips cards whose turn's `subject.answer` has channel `voice`.
- A card that fails acceptance is acknowledged `client_invalid` and counts as a miss. A sample still pending when the next question is recorded or the trial finalizes becomes `unmeasured_timeout` server-side (tab closed, acknowledgement lost) and counts as both a miss and unmeasured (D4, S3 6.4). `coach.failed` is a server-side miss with nothing to acknowledge.
- FE-KPI4-1: unit test with a fake transport: a valid card posts exactly one acknowledgement with `client_valid: true` before the card's render effect runs; an invalid or stale card posts `client_valid: false` (stored as `client_invalid`) and renders nothing; a duplicate frame posts nothing new; a card on a voice turn posts nothing; the body is exactly `{trial_id, turn_no, client_valid}`.
- FE-KPI4-2: render budget (outside the KPI-4 measure): the card renders within 100 ms of frame receipt at the 95th percentile in the Playwright fixture run (performance marks around the reducer dispatch and the card's commit effect).

---

## 6. State machines

All machines are pure TypeScript modules (no React, no I/O), unit-tested as tables, in the style of gokbase `voiceMachine.ts` (lines 1-18: "the PURE core") and `kin/fsm.ts` (lines 1-21).

### 6.1 Trial lifecycle reducer (room)

`trialReducer(state, envelope) -> state`: initialized from the REST snapshot (5.1), then monotonic on `seq`, duplicate-safe with a seen-set, persisted events sorted by `seq` before folding (TechnoMile `lib/war-room/office.ts` lines 76-111, `foldOffice`); synthesized frames apply as hints. Derived UI status (C-45: server statuses come from the projection; `finalizing` is client-side):

| Derived status | Entered on | Composer | Subject status word | Companion (practice) |
| --- | --- | --- | --- | --- |
| `connecting` | snapshot not yet read | disabled | none | `idle` |
| `awaiting_question` | snapshot with status `running` and no open turn; practice: `coach.card` or `coach.failed` closes the turn; assessment: `subject.answer` | enabled | "Listening" | `idle` or `listening` |
| `subject_answering` | `question.accepted`, `subject.thinking` | disabled | "Answering" | `idle` |
| `coach_working` (practice) | `coach.working` | disabled until `coach.card` or `coach.failed` | "Listening" | `thinking` |
| `cap_reached` | 12 exchanges | disabled; commit required | "Listening" | `idle` |
| `finalizing` (client-side) | the client's finding submit, until `trial.status` | disabled | none | `idle` |
| `ended` | a terminal status: `trial.status` or a snapshot `status` other than `running` (SG4-02); the commitment hash shows when `trial.finalized` (or a snapshot `commitment_hash`) arrives | disabled | "Session ended" | `sleeping` |
| `reconnecting` | stream retry scheduled | unchanged | unchanged | unchanged (the room status line says "Reconnecting") |

In assessment mode the companion is `sleeping` for the whole session (6.3).

### 6.2 Voice machine and voice bar (lifted from gokbase `voiceMachine.ts`, lines 1-234; protocol per S5 7.3 and 7.5, C-29)

Kept verbatim: the pure reducer shape, the terminal `ended` absorbing state (line 193), `frameToEvent` whitelist with unknown frames ignored (lines 125-163), the terminal-versus-transient close-code split (lines 73-110), transcript fragment merging by role (lines 165-182), and the no-cost-on-the-wire rule (lines 112-114: the frame union has no cost variant).

Arena changes:

| Change | Reason |
| --- | --- |
| States: `idle, consent, connecting, listening, thinking, speaking, draining, ended`; gokbase `tool-lookup` becomes `thinking` (the subject preparing an answer); `draining` follows a 4410 close and plays the already-received audio to its end, with capture stopped, before `ended` (SG4-28) | Arena vocabulary; consent gate before mic (gokbase disclosure-before-mic pattern); a normal final answer is heard whole |
| `mode: 'live' \| 'push_to_talk'`; under push-to-talk `listening` becomes `recording` while the talk control is held | OD-6 voice branch (3.3) |
| Frames accepted (S5 7.3): `utterance_start`, `utterance_end`, `transcription {role, text, partial, utterance}` (an investigator caption's `utterance` is the number of the subject utterance that answers it, so the room pairs question k with answer k), `interrupted {utterance}`, `turn_committed {turn_no, version}`, `exchange_count {used, cap}` (S5 adds it, C-29), `timer_tick`, `warning`, `ended`; turn text arrives on SSE, so the transcript shows committed turns plus at most one live caption line | Text is the scored artifact (SOL-1) and voice is unscored (D7); live fragments are captions only (I6 section 4: one answer arrives as many fragments) |
| Controls sent (S5 7.3): binary PCM16 audio (16 kHz mono, at most 3,200 bytes per frame, at most 15 per second), `stop`, `interrupt`. Nothing else: there is no playback control on the wire (D7, SG4-06; S5 closes 4400 on a `played` frame), and evidence requests go through the REST route (3.3) | Playback progress stays in the browser and drives only the UI: the arena playback worklet posts `{type:'drained'}` when its queue empties and `{type:'cleared', dropped}` on `clear` (the gokbase worklet, `public/worklets/playback-processor.js` lines 21-77, reports neither); the voice bar's "Subject is speaking" state and the barge-in flush read them |
| Close codes (S5 7.5, canonical, plus 4410 from C-29): terminal `1000` normal, `4400` protocol violation, `4401` ticket or binding, `4403` origin, `4404` not found, `4408` idle, `4409` subject guard hit (the session is invalid; S2 9.4, X-15), `4410` exchange cap reached (enters `draining`, never flushes), `4413` cost shutoff or reservation refused (replaces v1's `4429`), `4423` kill switch. A transport drop (`1006`, `1011`) also ends that voice session; the bar offers "Reconnect", which mints a new ticket and opens a new voice session on the same trial (S5 7.2 step 4: no resume credential, D-016) | One protocol, owned by S5 |
| Timer and `warning` kept (lines 214-224); the room shows "Voice ends in 60 s; you can continue in text" | WCAG 2.2.1 (time limit with warning and an untimed alternative) |

**Voice bar state (UI direction 3).** A pill-shaped bar docked at the bottom of the room, never a full-screen takeover. Its state combines four inputs: connection (the machine and its close-code taxonomy), microphone capture (the capture tap's level against a silence floor), server activity (S5's `utterance_start`, `utterance_end`, `interrupted`, investigator `transcription`) and actual playback (queued audio can keep playing after `utterance_end`).

| Bar state (machine state) | Connection | Capture | Server activity | Playback |
| --- | --- | --- | --- | --- |
| "Connecting" (`connecting`) | opening | any | any | any |
| "Finishing the answer" (`draining`) | closed by 4410 | stopped | none | playing until `drained` |
| "Listening" (`listening`) | open | below floor | no open utterance | idle |
| "You are speaking" (`listening`) | open | above floor, or investigator `transcription` partial | no open utterance | idle |
| "Subject is preparing an answer" (`thinking`) | open | below floor | investigator turn ended, no `utterance_start` yet | idle |
| "Subject is speaking" (`speaking`) | open | any | utterance open, or ended with audio still queued (until `drained`) | playing |
| "Voice ended" (`ended`) | closed | closed | none | stopped |

One analyser on the playback node gives one amplitude value per frame; the subject avatar's mouth (`--arena-talk`, 6.4) and the bar's ring read that same value, so on `interrupted` or barge-in the queue flush drops it to 0 and playback, ring and mouth stop together. The investigator's own input level shows as a small meter on the bar while capture is above the floor (`--arena-input-level`). Under reduced motion or the pause control, ring and mouth stay still and the bar's words carry the state.

Audio layer lifted from gokbase `audioController.ts` (lines 1-338): two contexts (16 kHz capture, 24 kHz playback), same-origin worklets, Chrome auto-suspend guard (lines 18-21), barge-in flush (lines 234-240), RMS taps (`sampleLevels`, lines 243-270); the subject's value is read from the playback path only.

Acceptance:
- FE-VOICE-1: reducer table test covers every (state, event) pair; `ended` absorbs every later event.
- FE-VOICE-2: close-code table: every terminal code in S5 7.5 plus `4410` maps to its ended copy key; `4429` and `4503` are not recognized; `1006` and `1011` end the session and show the reconnect offer, which opens a new voice session.
- FE-VOICE-7 (SG4-28): a 4410 close while a nonempty final utterance is queued enters `draining`, plays the queue to `drained`, then `ended`; an `interrupted` frame or a 4409 or 4423 close flushes at once.
- FE-VOICE-8: investigator captions carrying `utterance` k render beside answer k in a two-exchange fixture, including when the answer's first caption arrives before the question's last one.
- FE-VOICE-3: fragments for one subject utterance merge into one caption line; only a committed turn arriving on SSE adds a transcript turn.
- FE-VOICE-4: worklet test (AudioWorklet processor run in Node with a stub `AudioWorkletProcessor`): a 1.1 s buffer (26,400 samples at 24 kHz) posts `drained` exactly once, after its last sample is output; `clear` posts `cleared` with the dropped count; the socket client's outbound frame union contains only audio, `stop` and `interrupt` (type test).
- FE-VOICE-5: the voice channel control is absent when `split != 'dev'` or `voice_available = false`.
- FE-VOICE-6: voice-bar table test over (connection, capture, server activity, playback); after `utterance_end` with audio still queued the bar stays "Subject is speaking" until the queue drains; after `interrupted` the shared amplitude reads 0 within one animation frame.

### 6.3 Companion pet (lifted from gokbase `kin/fsm.ts`, lines 25-122; states per UI direction 1.1 with C-38d)

Kept: pure `petStateFor(input)`, the precedence ladder without dragging (one-shot windows over the status table, lines 77-121), `SLEEP_AFTER_MS = 45000`, `ONE_SHOT_MS = 1600` (lines 42-47), reduced-motion and mobile collapse of bursts to still poses (lines 84, 95-100, 119), the lazy per-character registry (`kin/registry.ts` lines 108-137), and per-frame CSS variables outside React (`KinLayer.tsx` lines 657-670). Dropped for this product: roaming, cursor lean and drag (`KinLayer.tsx` cursor and drag machinery; I7 lift map: fixed placement in the coach region instead), `approach`, `talk-sync` (the companion does not speak), `farewell` and `error` (transport faults show in the room's status line, not on the pet).

| State | Trigger (practice mode only, except `sleeping`) | Motion | Reduced motion, mobile or paused |
| --- | --- | --- | --- |
| `idle` | Nothing pending | Slow breathing loop, blink | Still pose |
| `listening` | Investigator typing (composer focused and draft changed within `ONE_SHOT_MS`) or voice capture above the floor | Ears and eyes toward the input | Still pose |
| `thinking` | Between `coach.working` and `coach.card` or `coach.failed` | Small looped gesture, no spinner | Still pose and caption "Coach is reading T{n}" |
| `noticing` | A `coach.card` with at least one flag | One-shot point toward the newest flag's chip, 1600 ms | Still pose and caption |
| `encouraging` | A `coach.card` whose `question.neutrality_issues` is empty and whose `question.question_type` is `open` or `probing` | One-shot nod, 1600 ms | Still pose and caption |
| `celebrating` | Session ready (first snapshot of a new running session), at most once per session | One-shot | Still pose |
| `sleeping` | Assessment mode (whole session); 45 s idle; session ended | Still pose | Still pose |

Precedence: assessment or ended gives `sleeping`; otherwise an active one-shot (`noticing` over `encouraging` over `celebrating`; a newer one-shot replaces an older one) over `thinking` over `listening` over `idle`, which becomes `sleeping` after 45 s.

Rules (PRB-4, AST-10, X5 section 4, C-38d): `encouraging` reads only the card's `question` block, through the pure function `encourages(question)`; no state reads the finding, flags beyond "at least one", the answer category, role, style or any rubric score; there is no `celebrating` on findings; no sad, disappointed or impatient pose; no notifications, streaks or idle reminders. In assessment mode the companion receives no coaching-derived input. The pet appears in the room and, as a still pose, in the debrief; it is small and the viewer can hide it (UI direction 6); the pause control (6.6) stops its loops.

Input: `{mode, status, coachWorking, investigatorActive, flagSignal, encourageSignal, sessionReady, reducedMotion, isMobile, paused, idleMs}`, where `flagSignal` and `encourageSignal` are counters bumped by accepted cards in practice mode.

Acceptance:
- FE-PET-1: `petStateFor` table test over every status, mode and signal combination; under `reducedMotion`, `isMobile` or `paused` no looping or burst pose is animated.
- FE-PET-2: type test: `CompanionInput` has no field typed from the finding, flag content, answer category, role, style or rubric score; `encourages()` accepts only card.v1's `question` object (`@ts-expect-error` fixtures).
- FE-PET-3: assessment fixture: the pose is `sleeping` for the whole session and equals the sequence produced with all `coach.*` events removed.
- FE-PET-4: the companion root is `aria-hidden="true"`, not focusable, and `pointer-events: none` except where it is a control (gokbase `KinLayer.tsx` line 741 and the pointer-events contract).
- FE-PET-5: bundle gate (lifted `scripts/check_pet_bundle.mjs`): character art reachable only through dynamic imports; active-set gzip ceiling pinned at the first green measured value (section 10).
- FE-PET-6: `encourages()` table test: `open` or `probing` with no neutrality issues gives true; any issue (including `demeanor_reference`) or any other type gives false; two cards identical in `question` but different in finding, flags and answer category give the same result.

### 6.4 Subject avatar (PRB-4, SCN-3, SCN-11)

Assignment: the public packet carries `presentation {persona_id, display_name, voice_id}` assigned **per case family** (S1 schema v1.2, C-21), so both matched variants of a family share one persona and one voice. Role cannot correlate with presentation inside a family by construction. There is no `baseline_demeanor` field (C-22): the portrait is neutral, and no style-like attribute appears on any pre-interview surface (PRB-4).

Portrait: one character sheet per persona (neutral, speaking mouth shapes, pausing; UI direction 1.2), vectorized to SVG with a CSS-variable rig. No per-turn expressions; no nervous, defensive or stressed state; voice, accent and portrait are drawn independently of role.

States (UI direction 1.2):

| State | When |
| --- | --- |
| `speaking` | Voice: playback amplitude above the silence floor |
| `pausing` | Voice: an utterance is open or audio is queued, amplitude below the floor |
| `idle` | Otherwise, and always in text sessions (the subject panel's status word carries the lifecycle, 6.1) |

| Input (complete list) | Source |
| --- | --- |
| Derived trial status (status word only) | 6.1 |
| Voice playback state | 6.2 |
| `--arena-talk` level 0-1 from the playback analyser, set per frame on the DOM node | gokbase `audioController.ts` `sampleLevels`, `KinLayer.tsx` line 670 technique |
| `presentation` | public packet |
| `reducedMotion`, `paused` | media query; pause control (6.6) |

Forbidden inputs (type-enforced): answer category, flags, running finding, committed finding, tag proposals, guard results, role, communication style, quarantine reason. The avatar's appearance never changes in response to what the subject said.

Art pipeline and budget (WP-21, after the slice gate):
- **Production test first:** one character goes through generate, vectorize (VTracer), clean up, rig and speak in the first build days after the 2026-10-18 gate. If it fails, portraits are hand-authored SVG with the same playback-driven rig; no new animation runtime (UI direction 1.2). The remaining portraits are generated only after the test passes.
- **Art sub-budget:** every portrait call runs through the agent port as call kind `portrait` and reserves its worst case against the one `global` ceiling (D-013); the hard limit is the count cap of 62 images (`PORTRAITS[0]`; C-46), enforced in code. For reading only: 62 images cost $6.20 high (`cost_model.demo_bucket(True)["portraits"]`) and $4.34 expected (`demo_bucket(False)["portraits"]`). When the cap is reached, approved assets are reused and nothing else is generated.
- Each original PNG is kept as the provenance record (Gemini 3 Pro Image supports C2PA content credentials; vectorizing strips them).

Gemini Live Avatar is out of scope (UI direction TL;DR 4; C-38b).

Acceptance:
- FE-AV-1: type test: `SubjectAvatarInput` rejects each forbidden field (`@ts-expect-error` fixtures).
- FE-AV-2: two fixture sessions with identical lifecycle and playback timing but opposite `answer_category` sequences produce identical avatar state sequences.
- FE-AV-3: contract test on the case fixtures: for every family, both variants' `presentation` objects are equal and contain no `baseline_demeanor` key.
- FE-AV-4: under reduced motion or the pause control `--arena-talk` stays 0 and the speaking state is shown by a static marker and the status word.
- FE-AV-5: with a fake analyser, `interrupted` drives `--arena-talk` to 0 within one animation frame.

### 6.5 Agents at work: pipeline rail and canvas (C-38c; UI direction 1.3)

The arena's working view is TechnoMile's pipeline rail plus canvas (`docs/design/pipeline-view/SPEC.md` sections 2-6; `web/src/lib/pipeline/rail.ts` lines 241-330: `deriveRail`, `rollupPhase`, `liveStep`, `followReducer`, `shownStep`; `steps.ts`; `keys.ts`; `components/pipeline/status-glyph.tsx`), adapted to read only the projected frames of 5.3 (a backing event is necessary but not sufficient, UI direction 1.3). The matrix (4.9) is the overview; the rail and canvas show the followed trial.

- **Rail:** the followed trial's steps grouped into collapsible phases: Setup (trial started, scheduled releases), Exchange 1 to 12 (Ask, Release when any, Answer, Coach), Close (finding and commitment). Each row: status glyph with its text label (not started, running, done, failed), step name, recorded duration where the projection provides it, and one count (flags, after reveal only). Auto-follow of the live step is on by default; selecting a row pins it and turns follow off; "Jump to live" (key `L`) turns it back on; the step lives in `?step=` for deep links (SPEC.md section 3, Behavior).
- **Canvas:** the selected step's own work.
- **Data:** the rail and canvas read the followed trial's frames from `GET /api/trials/{id}/replay?after=` (5.3), so they exist only for dev tournaments and for hidden tournaments after reveal; a hidden tournament before reveal shows the progress table of 4.9 and no rail (D9).

| Step | Frame | Canvas |
| --- | --- | --- |
| Ask | `question.accepted` (source harness) | Interviewer bubble with the first words |
| Release | `evidence.released` | Record slides into the court-record locker (signature moment, 6.6) |
| Answer | `subject.answer` | Subject writing during `[ts - latency_ms, ts]`, then the bubble |
| Coach | `coach.card` | Coach writing during its latency window, then the card |
| Close | `trial.finalized` | Commitment stamp with the hash |
| State | `trial.execution` (tournament poll) | State word (`budget_skipped` and the others) |

Kept from TechnoMile's office code: every movement is one recorded event (`office.ts` lines 1-15; `motion.md` lines 43-45); fold, schedule and frame as pure functions (`foldOffice` lines 76-111, `buildSchedule` lines 449-575, `frameAt` lines 661-729); the live clock 3.5 s behind the latest frame with measured skew (`liveClock` lines 376-388, `noteArrival` lines 749-756), which the 2 s polls (S5 6.2) never starve; history before the first fetched seq never animates (`motion.md` line 56); replay at 8x with quiet stretches capped at 6 s (`replayClock` lines 334-374); model-call motion bound to the recorded latency window, capped at 1.6 s live (`LIVE_TYPING_MS`, line 377; `motion.md` line 49); store updates batched at about 10 Hz (`agent-office.tsx` `TICK_MS = 100`, line 48); a caption line saying in words what is happening (`agent-office.tsx` `Caption`, lines 844-859).

The isometric office "theater" toggle is cut item 3 (S8 section 7): built only if time remains after the slice and every rail criterion is green. The interview room reuses the same rule at small scale: the companion's `thinking` state and the coach activity line ("Coach is reading T5") exist only between `coach.working` and `coach.card`.

Reduced motion and the pause control (`motion.md` lines 58-62): no walking or loops; the canvas swaps instantly; the caption carries the state in words. The reduced-motion rendering is also the cut-order fallback (direction 3.3 cuts the animation first): cutting animation means shipping this rendering.

Acceptance:
- FE-AW-1: `foldArena` is order-independent and duplicate-safe (property test, as `office.test.ts`).
- FE-AW-2: with a fixture whose `coach.card` has `latency_ms = 900`, the coach is in `typing` exactly during the mapped window on the replay clock (frame test at sample times).
- FE-AW-3: events at or before the first fetched seq produce no beats.
- FE-AW-7: on a hidden pre-reveal fixture no rail or canvas mounts and no replay request is made.
- FE-AW-4: reduced motion: zero running animations longer than 1 ms or looping on the page during a fixture replay (Playwright `document.getAnimations()`), matching TechnoMile's verification (`motion.md` lines 66, 74).
- FE-AW-5: the caption is present in every state and changes when the frame's activities change.
- FE-AW-6: follow behavior: `followReducer` and `shownStep` table tests lifted from `rail.test.ts` (pinning turns follow off; "live" turns it on; the shown step is the pinned step or the live step).

### 6.6 Motion system (UI direction 2; C-38a)

- **Quiet by default:** everyday transitions use the motion tokens (section 11; roughly 80-240 ms) on `transform` and `opacity`; expressive motion is reserved for the signature moments below.
- **Stack:** Motion for state-driven UI and the signature moments, CSS for everyday transitions and per-frame rigs. Immediately after the 2026-10-18 slice gate, the evidence-released sequence is built twice, with Motion + CSS and with GSAP, and compared on frame pacing (section 10), code size (bundle gate) and feel; GSAP is added only if it wins, and the result is recorded in `docs/design/motion.md`.
- **Signature moments** (each driven by one projected event; under reduced motion or the pause control each shows its still end state with a caption):

| Moment | Event | Motion | Modes |
| --- | --- | --- | --- |
| Evidence released | `evidence.released` | The record card slides into the board; its release marker in the transcript pulses once | Practice and assessment (not coaching-derived) |
| Contradiction noticed | Accepted `coach.card` with a `contradiction` flag | A thin connector draws between the two quoted turns | Practice only |
| Finding committed | `trial.finalized` (its `commitment_hash`) | Seal; the hash appears | Both |
| Leaderboard reveal | First load of a revealed leaderboard | Rank intervals draw in at their actual endpoints; rank, eligibility and provisional status appear unchanged and at once | Leaderboards |
| Debrief | `debrief.ready` | The five 0-4 scores count up to the server values | Both |

- **Coaching card reveal:** complete-card only (4.5): a neutral loading state until the card is accepted, an optional field stagger after; no typewriter effect for transcript text.
- **Pause control:** a visible control in the app header pauses or hides decorative and activity animation (pet loops, avatar head motion, voice ring, pipeline motion), independently of OS settings, while every status stays readable as text. Remembered per viewer in `localStorage` inside try/catch; default off.
- Keyboard focus never moves because of animation, and every animated state has a text equivalent.

Acceptance:
- FE-MOT-1: with the pause control on, `document.getAnimations()` returns no running looping animation during a fixture replay, and every status word is present.
- FE-MOT-2: a fixture replay that triggers every signature moment leaves `document.activeElement` unchanged.
- FE-MOT-3: in an assessment fixture no contradiction connector or coaching-tied highlight renders.

---

## 7. PRB-4 UI rules and copy rules

### 7.1 PRB-4 UI rules (enforced, not advisory)

| Rule | Enforcement |
| --- | --- |
| No stress, nervousness, voice-tone, pace or biometric meter anywhere; no acoustic feature of the subject is shown or sent to the coach (direction 9, N03). The playback amplitude drives only the mouth and the voice ring; the investigator's input meter shows only their own level | Lint: forbidden identifiers (`stress`, `nervous`, `arousal`, `pitch`, `tremor`, `heartRate`, `eyeContact`) fail the build in `src/`; e2e text scan of every route |
| Subject persona and voice assigned per family, independent of role; no baseline demeanor field; no per-turn expression | 6.4 types and FE-AV-1..3 |
| Avatar and companion never react to answer categories, flags or findings in a way tied to the subject's role or content; the companion's `encouraging` reads only the card's question block, in practice mode | FE-AV-2, FE-PET-2, FE-PET-3, FE-PET-6 |
| Confidence shown as the ICD 203 phrase and the coach's confidence level, both evidence-based; never as a gauge, needle or color ramp that reads as a lie detector | Component review checklist; snapshot test of the running-finding component (text only plus a static token) |
| The three findings carry equal visual weight; "deceptive" gets no alarm treatment, sound or motion | FE-COACH-5 |
| Every flag shows its citation; a flag without a verifiable quote is visibly marked | FE-COACH-3 |
| Communication style is never shown before or during an interview | FE-LIB-1; style appears only in the fairness audit |
| The coach's demeanor callout is shown when the investigator's question relies on demeanor | FE-COACH-6 |
| No accusation streaks, "catch" counts or rewards for "deceptive" findings; no `celebrating` on findings | FE-PRG-2, FE-PET-2 |

### 7.2 Copy rules (UI direction 4)

| Use | Not |
| --- | --- |
| coach | AI assistant, agent, copilot |
| subject | bot, persona, AI character |
| check, review | inference, model call, LLM |
| case file, evidence | context, prompt, retrieval |
| finding, confidence | prediction, probability score |
| practice, assessment | mode toggle names from the code |
| interview room | interrogation room (C-38f) |

Tournament vocabulary (candidate, manifest, replay track) appears only on the arena, leaderboard and trust-center screens, never in the trainee's room. "Interview room" is used in all judge-facing copy (C-38f).

- FE-COPY-1: a Playwright whole-word text scan of onboarding, library, case brief, room, debrief and progress finds none of "AI assistant", "agent", "copilot", "bot", "persona", "AI character", "inference", "model call", "LLM", "prompt", "retrieval", "prediction", "probability score", "interrogation". ("Context" stays a review-checklist item: "interview context" is a legitimate SCN-7 phrase.)
- Anti-slop checklist before each UI merge (UI direction 4, checked by the `impeccable` audit): no purple-to-blue gradient signature, no default glow shadows, no sparkle or "AI" badges, no robot or brain icons, no particle heroes, no stress-coded colors on avatars, no generic stock illustration.

---

## 8. EX-4 and EVL-12 placements (C-38e)

`EX4_TEXT` is the sponsor's exact text (slide 8, after the "Ground rule:" label; REQUIREMENTS EX-4): "All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person." No surface paraphrases it.

| Placement | Form |
| --- | --- |
| Onboarding | Full text; acknowledgement required (FE-ONB-1) |
| Case brief | Full text above the start control |
| Interview room | Persistent footer with the full text (UI direction 4) |
| Running finding (room) and findings (debrief) | Full text after each rendered finding (S2 4.5) |
| Flags (room and debrief) | The sentence "Evasive wording alone does not prove a violation", taken verbatim from `EX4_TEXT`, beside the flag list |
| Finding commit dialog | Full text (FE-FIND-3) |
| Debrief | Header (full text) and in exports |
| Leaderboards | Header caption, with the EVL-10 "not certification" sentence |
| Arena | Header line, full text |
| Trust center and methodology | Full text; EVL-12 NIST non-validation statement on every methodology page |
| JSON and print exports | Included as a field and in the printed header |

- FE-EX4-1: Playwright visits every route in 2.2 (with fixtures) and asserts `EX4_TEXT` is present in full in the accessible text (presence test named in S7 section 1).
- FE-EX4-2: every `/trust/methodology*` page contains the EVL-12 statement.
- FE-EX4-3: the flag-adjacent sentence is a substring of `EX4_TEXT` (unit test), and a source lint finds the words "synthetic" and "Evasive wording" only in the constant's module.

---

## 9. Accessibility (WCAG 2.2 AA)

| Criterion | How |
| --- | --- |
| 1.1.1 Non-text content | Portraits `alt` = persona display name; decorative companion and canvas figures `aria-hidden`; the pipeline canvas has `role="group"` with a summary label (TechnoMile `agent-office.tsx` line 231); rail glyphs carry text labels |
| 1.3.1 Info and relationships | Transcript is a list of turns with headings `T1..Tn`; flags reference turns by `aria-describedby` |
| 1.4.1 Use of color | Flag kind, finding, gate status and execution state each carry a text label and an icon slot, never color alone |
| 1.4.3, 1.4.11 Contrast | Token pairs from DESIGN.md must meet 4.5:1 text and 3:1 UI; axe checks every route in light and dark |
| 1.4.10 Reflow, 1.4.4 Resize | Works at 320 CSS px and 200% zoom; room collapses to tabs |
| 2.1.1 Keyboard | Every action, including Present, chip navigation, rail follow and pin, replay controls and voice start/stop, is keyboard-operable |
| 2.2.1 Timing adjustable | Voice session limit announced with 60 s warning; text mode has no time limit and is always available |
| 2.2.2 Pause, stop, hide; 2.3.3 Animation from interactions | The header pause control (6.6) stops decorative and activity animation independently of OS settings; `prefers-reduced-motion` honored everywhere; replays have pause |
| 2.4.3 Focus order, 2.4.7 Focus visible | Citation activation moves focus to the turn; animation never moves focus; focus ring token required |
| 2.4.11 Focus not obscured (minimum) | Pinned composer, voice bar and EX-4 footer never cover the focused element (`scroll-padding` set from their heights) |
| 2.5.7 Dragging movements | No drag-only interaction (companion drag removed; evidence presented by button and checkbox) |
| 2.5.8 Target size (minimum) | Interactive targets at least 24 x 24 CSS px, including citation chips |
| 3.2.6 Consistent help | Methodology and "How coaching works" links in the same place on every screen |
| 3.3.7 Redundant entry | Finding draft survives a `409` and a reconnect |
| 3.3.8 Accessible authentication | Locally the dev identity middleware needs no sign-in; hosted, Google sign-in through IAP; no app passwords or puzzles |
| 4.1.3 Status messages | One polite live region for coach-card arrival ("Coach: 1 flag on T4, follow-up suggested"), evidence releases and status changes; transcript `role="log"`; captions batched at clause boundaries or 400 ms (gokbase `Transcript.tsx` lines 310-325) |

Acceptance:
- FE-A11Y-1: `@axe-core/playwright` reports zero violations at WCAG 2.2 A and AA tags on every route, in light and dark themes, with fixture data.
- FE-A11Y-2: a keyboard-only Playwright run completes flow 3.1 (ask, request a record, present an excerpt, follow a chip, commit, open debrief) without a pointer.
- FE-A11Y-3: at 320 px viewport width no horizontal scroll on any route.
- FE-A11Y-4: the polite live region announces each accepted coach card once (count of mutations equals cards accepted).

---

## 10. Performance budgets

| Budget | Target | Method |
| --- | --- | --- |
| Frame pacing | p95 frame interval at most 16.8 ms and no interval over 50 ms over 8 s, on the demo laptop, on the arena's combined workload: voice playback, transcript streaming, characters and the pipeline rail at 4x replay at once (UI direction 2). TechnoMile's result (481 frames in 8 s, p50 16.7 ms, p95 16.8 ms, 0 over 50 ms; `motion.md` lines 64-75) is precedent, not an arena result | Release verification, recorded in `docs/design/motion.md` with the build and date: full frame-interval sampling (`requestAnimationFrame` deltas) injected by Playwright during a fixture replay, plus a browser performance trace; the Long Animation Frames observer only diagnoses stalls of 50 ms or more. Not a CI gate: headless CI frame timing does not represent a display (stated, not softened) |
| Animated properties | `transform` and `opacity` only on hot paths | CI: stylelint rule rejecting `transition`/`animation` on any other property, and a test scanning `document.getAnimations()` keyframes during a fixture replay |
| Layout shift | CLS 0.00 on the room and arena while streaming (TechnoMile measured 0.0000) | Playwright `PerformanceObserver('layout-shift')`; skeletons reserve final size |
| Reduced motion and pause | 0 looping or longer-than-1 ms animations | FE-AW-4, FE-MOT-1 (CI) |
| Card render | p95 at most 100 ms from frame receipt to card committed (outside the KPI-4 measure, which ends at the acknowledgement) | FE-KPI4-2 (CI, fixture) |
| Interaction | INP at most 200 ms for Send, Request, Present, chip activation | Playwright Event Timing |
| JavaScript | Entry chunk (shell, library route, router, React) and each lazy chunk under gzip ceilings pinned at the first green slice build's measured size plus 10%; voice, character art and the arena are separate lazy chunks; GSAP is absent unless the spike adds it, then in its own lazy chunk | CI: lifted `check_pet_bundle.mjs` (three checks: lazy-only, ceiling, presence; lines 6-30). A ceiling is raised only by a recorded owner decision with the measured number, never to make a failing build pass (same file, lines 29-40) |
| Main-thread work per frame | One shared rAF loop for all per-frame work (gokbase `raf.ts` lines 1-96), paused when the tab is hidden | Unit test of subscriber count; manual check |
| First paint | Shell visible within 1 s after `index.html`; data regions show skeletons while the API responds (hosted: also during a Cloud Run cold start) | Playwright with artificial API delay |

---

## 11. Design token hooks (pending DESIGN.md)

DESIGN.md supplies values; the code uses only these names. Tailwind 4 maps them through `@theme` so utilities exist for each (Context7 `/tailwindlabs/tailwindcss.com`, `@theme` generates utilities).

| Group | Token names |
| --- | --- |
| Surfaces and text | `--arena-canvas`, `--arena-surface`, `--arena-surface-2`, `--arena-ink`, `--arena-ink-2`, `--arena-muted`, `--arena-hairline`, `--arena-hairline-strong`, `--arena-focus-ring` |
| States | `--arena-signal`, `--arena-ok`, `--arena-warn`, `--arena-danger` (system errors only, never findings) |
| Findings | `--arena-finding-deceptive`, `--arena-finding-truthful`, `--arena-finding-insufficient` (constraint: same contrast band and visual weight, section 7) |
| Flags and categories | `--arena-flag-gap`, `--arena-flag-contradiction`, `--arena-cite`, `--arena-cite-missing` |
| Roles | `--arena-role-interviewer`, `--arena-role-subject`, `--arena-role-coach`, `--arena-role-referee`, `--arena-role-clerk`, `--arena-team-1..3` |
| Motion (UI direction 2) | `--arena-motion-instant` (about 80 ms), `--arena-motion-quick` (about 160 ms), `--arena-motion-base` (about 240 ms), `--arena-motion-signature` (about 600-900 ms, choreographed), `--arena-ease-standard` (one standard ease), `--arena-spring-layout` (one spring preset for layout changes); final values from DESIGN.md |
| Per-frame variables | `--arena-talk` (0-1, playback amplitude shared by the subject's mouth and the voice ring), `--arena-input-level` (0-1, the investigator's own capture level) |
| Typography and space | `--arena-font-sans`, `--arena-font-mono`, `--arena-font-display`, `--arena-space-*`, `--arena-radius-*` |

State hooks for styling: `data-state` (room status), `data-pose` (companion), `data-avatar-state`, `data-activity` (canvas figures, TechnoMile `office-avatars.tsx` contract), `data-finding`, `data-flag-kind`, `data-gate` (`pass`, `fail`, `insufficient`), `data-provisional`, `data-highlighted`, `data-paused`. Themes: light and dark token sets under `:root` and `[data-theme="dark"]`, plus `prefers-color-scheme`.

Design-to-code pipeline (UI direction 5): DESIGN.md through Stitch for static screens (onboarding, case library, debrief, leaderboard, trust center); components through shadcn over the pinned Radix primitives; `impeccable` for audit and polish; character, voice and pipeline surfaces hand-built; the anti-slop checklist (7.2) before every UI merge.

**OWNER DECISION PENDING (OD-4, OD-5):** DESIGN.md and its format; all values; character direction and portrait art style; companion character and name; icon set; fonts. Until DESIGN.md lands, development uses a neutral placeholder theme built on these token names. Release rule (one instruction, shared with S8 OD-4 and R-10): if DESIGN.md has not arrived by 2026-10-20, the release ships this placeholder theme with the status words and the coach activity line; it must pass FE-A11Y-1..4, FE-TOK-1 and the anti-slop checklist like any theme, and WP-21 shrinks to accessibility and REL-1. Nothing presentational starts before the 2026-10-18 slice gate either way.

- FE-TOK-1: a lint fails on raw color literals, raw durations or raw font stacks in `src/` outside `src/styles/tokens.css`.

---

## 12. Testing

| Layer | Tool | Scope |
| --- | --- | --- |
| Pure modules | Vitest 5, coverage gate 90% lines and branches on `src/lib/**` (TechnoMile gate level, direction P9) | Reducers (6.1), voice machine and voice-bar state (6.2), companion FSM and `encourages()` (6.3), avatar FSM (6.4), arena fold, rail, schedule and frame (6.5), SSE client, quote verifier, card acceptance and acknowledgement (5.6), finding templates, projections re-check |
| Components | Vitest + Testing Library (jsdom) | Coach card, citation chips, evidence board and Present, finding dialog, debrief cards, leaderboard gate panel, review form |
| Contract | ajv against `contracts/events.schema.json`, the training and tournament wire-card schemas, deep.v1, `Finding`, the snapshot, `debrief.v1`, the review-task schemas and the REST schemas (never the stored-card schema, 5.2) | Every fixture event validates; negative fixtures (forbidden fields such as `role`, `style`, `tag`, `presented_record_ids`, `baseline_demeanor`) fail validation |
| End to end | Playwright 1.63 against the local stack (`arena-api`, `arena-subject`, `arena-referee` as separate processes) in fake-model mode (`ARENA_MODEL_MODE=fake`, S5 10) with a seeded local Supabase; fixture streams for arena and leaderboards | Flows 3.1-3.7, leak tests, EX-4 presence, copy scan, axe, keyboard-only, reduced motion, pause control, CLS |
| Visual and motion verification | Playwright traces and recordings | Release verification (section 10), stored under `docs/design/` |

Fixtures: one canonical facility-access dev case (slide 8 case, EX-1..EX-3) with card.v1 cards, a full practice session log, an assessment session log, a voice session log with an interrupted utterance, a hidden-tournament pre-reveal and post-reveal pair, a leaderboard with one ineligible candidate and one zero-event FPR, a budget projection before and after the plan is applied, a commitment with known inputs, a scored and an unscored (voice) `debrief.v1` document, a maximal snapshot (S5 6.5), one review item per task kind, and S2's shared quote fixture file.

End-to-end acceptance list (all CI unless marked):
- E2E-1 Practice text session, 3 exchanges, one request, one Present (excerpt inserted into the question), commit "insufficient evidence", debrief shows five cards (FE-ROOM, FE-EVD, FE-COACH, FE-FIND, FE-DEB).
- E2E-2 Assessment session shows no coaching in the room and shows it in the debrief.
- E2E-3 Stream drop mid-session (server closes the connection): the room reconnects with `after=` and no turn is duplicated or lost.
- E2E-4 Voice session against the voice relay's fake Live backend: consent, connect, two committed turns, barge-in flush, `4410` at cap.
- E2E-5 Hidden pre-reveal arena: no transcript text in the DOM (FE-ARENA-1).
- E2E-6 Leaderboard gate ordering and intervals (FE-LB-1..5).
- E2E-7 Commitment verification in the trust center (FE-TRUST-1).
- E2E-8 Trainer review blinding (FE-REV-1..3).
- E2E-9 EX-4 presence on every route and the copy scan (FE-EX4-1, FE-COPY-1).
- E2E-10 Axe, keyboard-only, 320 px (FE-A11Y-1..3).
- E2E-11 (hosted variant only, 1.4) IAP expiry banner and refresh window (FE-TECH-2).
- E2E-12 Hidden tab closes the trial stream within 61 s (FE-SSE-5).
- E2E-13 Pause control and reduced motion on the room and arena (FE-MOT-1..3, FE-AW-4).
- E2E-14 Local HTTP boundary (D10): from a page served on another origin, a form POST and a `fetch` POST to an investigator route and to a referee admin route are refused with nothing written; the same POSTs from the app's own origin with the CSRF header succeed (FE-TECH-5; S5 10.4 owns the server assertions).
- E2E-15 Referee origin (FE-ADM-3): `/admin` and `/review` opened directly on port 8082 boot from the referee's own `/api/me` and `/api/config`; a trainer opens one item of each task kind and submits it.
- E2E-16 KPI-1 study flow (3.2): a participant runs two pre-tests, three practice sessions and two post-tests through the case library with the frontend's request body; the step label follows `/api/me` `study`, and an out-of-order start shows the server's step message.
- REL-1 (release verification, recorded) Frame pacing on the demo laptop on the combined workload (section 10).

---

## 13. Lift map

Effort: S up to 2 h, M 2-6 h, L over 6 h. All sources are read-only (D-002); code is copied with an attribution header naming the source path and commit.

| Source (read-only) | Lines | Target | Adaptation | Effort |
| --- | --- | --- | --- | --- |
| TechnoMile `web/src/lib/sse/ticketed-stream.ts` | 1-206 | `web/src/lib/sse/ticketed-stream.ts` | Verbatim; trial stream passes `backoffMs` `[250, 1000, 2000, 4000, 8000]`; S5 ticket route; `visibilitychange` close/resume wrapper outside the module | S |
| TechnoMile `web/src/lib/sse/ticketed-stream.test.ts` | all (13 tests) | same path | Verbatim plus FE-SSE-1 additions | S |
| TechnoMile `web/src/lib/sse/frames.ts` | 15-31 | Server reference for `arena-api` SSE framing (`id: seq`, ping, `resumeAfter`) | Port to Python in S5 | S |
| TechnoMile `web/src/lib/contracts/run-events.ts` | 1-10 | `contracts/events.schema.json` conventions | Absolute values, per-scope seq, 16 KB cap; arena wire types (5.3) | M |
| TechnoMile `docs/design/pipeline-view/SPEC.md` | sections 2-6 | Arena rail and canvas pattern (6.5) | Rail plus canvas, follow and pin, motion rules; TechnoMile's human gates (H1, H2) dropped | S |
| TechnoMile `web/src/lib/pipeline/rail.ts` | 241-330 | `web/src/lib/arena/rail.ts` | Arena steps and phases; keep `deriveRail`, `rollupPhase`, `liveStep`, `followReducer`, `shownStep` | M |
| TechnoMile `web/src/lib/pipeline/rail.test.ts` | all | same target folder | Re-target to arena steps (FE-AW-6) | S |
| TechnoMile `web/src/lib/pipeline/steps.ts`, `keys.ts` | 1-131, 1-88 | `web/src/lib/arena/steps.ts`, `keys.ts` | Phases: Setup, Exchange 1-12, Close; `L` for live, arrow keys | S |
| TechnoMile `web/src/components/pipeline/status-glyph.tsx` | 1-82 | `web/src/components/arena/status-glyph.tsx` | Arena statuses; glyph plus status word | S |
| TechnoMile `web/src/lib/war-room/office.ts` | 76-111, 323-399, 449-575, 661-729, 737-756 | `web/src/lib/arena/clock.ts` | Fold, clocks, schedule, frame and live sync only; no isometric floor | M |
| TechnoMile `web/src/components/war-room/agent-office.tsx` | 48, 120-230, 844-859 | `web/src/components/arena/pipeline-canvas.tsx` | Ticker, replay controls, `Caption`; the office floor is lifted only for the theater toggle (cut item 3) | M |
| TechnoMile `web/src/components/war-room/office-avatars.tsx` | `data-activity` contract (4, 237, 284) | `web/src/components/arena/figures.tsx` | Canvas figures per DESIGN.md; keep the activity attribute contract | M |
| TechnoMile `web/src/components/war-room/swarm-graph.tsx` | 45-51 | `web/src/lib/motion/use-reduced-motion.ts` | Verbatim `useSyncExternalStore` hook; also reads the pause control | S |
| TechnoMile `docs/design/motion.md` | 1-75 | `docs/design/motion.md` (arena) | Doctrine and verification method; arena event table; tokens per section 11; spike result (6.6) | S |
| gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/voiceMachine.ts` | 1-234 | `web/src/lib/voice/voiceMachine.ts` | Section 6.2 changes | M |
| gokbase `.../voice/useVoiceSession.ts` | 1-392 (ticket subprotocol 10-11, 308-328; the resume path is not lifted, D-016) | `web/src/lib/voice/useVoiceSession.ts` | S5 ticket route, frames and close codes (C-29); outbound frames only audio, `stop` and `interrupt` (D7); cost never on the wire | M |
| gokbase `.../voice/audioController.ts` | 1-338 | `web/src/lib/voice/audioController.ts` | Verbatim; add `drained` and `cleared` message handling (UI only); playback analyser feeds `--arena-talk` | S |
| gokbase `recruiter-frontend/public/worklets/capture-processor.js` | 1-56 | `web/public/worklets/capture-processor.js` | Verbatim | S |
| gokbase `recruiter-frontend/public/worklets/playback-processor.js` | 1-77 | `web/public/worklets/playback-processor.js` | Add a `drained` message when the queue empties and the `cleared` count (6.2); nothing is sent to the server | S |
| gokbase `.../voice/pcm.ts` | 1-62 | `web/src/lib/voice/pcm.ts` | Verbatim | S |
| gokbase `.../voice/raf.ts` | 1-96 | `web/src/lib/motion/raf.ts` | Verbatim | S |
| gokbase `.../voice/spring.ts` | 1-117 | `web/src/lib/motion/spring.ts` | Verbatim if any eased value remains outside Motion; else skip | S |
| gokbase `.../voice/companionContext.tsx` | 1-82 | `web/src/components/companion/companion-context.tsx` | Status type becomes `CompanionStatus`; `flagSignal` and `encourageSignal` live (practice only); levels getter feeds `--arena-talk` | S |
| gokbase `.../voice/kin/fsm.ts` | 25-122 | `web/src/lib/companion/fsm.ts` | Section 6.3 table; drop `approach`, `talk-sync`, `dragging`, `farewell`, `error` | S |
| gokbase `.../voice/kin/fsm.test.ts` | all | same | Re-target to the arena table | S |
| gokbase `.../voice/kin/registry.ts` | 17-26, 108-161 | `web/src/lib/companion/registry.ts` | Arena character set from DESIGN.md; keep lazy loader and `poseStyle` | S |
| gokbase `.../voice/kin/KinLayer.tsx` | 640-724 (per-frame CSS variable, reduced-motion static path), 735-760 (aria-hidden root, pointer-events) | `web/src/components/companion/companion.tsx` | Fixed placement; drop roaming, cursor lean, drag and keep-out | M |
| gokbase `.../voice/kin/pets/**` | art | none | Avoid: recruiting-brand art; new art per DESIGN.md | n/a |
| gokbase `.../voice/Transcript.tsx` | 15-18, 300-325, 472-473 | `web/src/components/room/transcript.tsx` | Pattern only: always-mounted `role="log"`, batched announcements; arena turn model | M |
| gokbase `recruiter-frontend/scripts/check_pet_bundle.mjs` | 1-251 | `web/scripts/check_bundle.mjs` | Arena chunk names; ceilings set from the first green build; honesty rules kept | M |
| gokbase `recruiter-frontend/playwright.config.ts` | all | `web/playwright.config.ts` | Base URL to the local `arena-api`; projects for light, dark, reduced motion, 320 px | S |

---

## 14. Delivery order and cut order

| Window (direction 3.2; S8 WP windows) | Frontend work | Exit |
| --- | --- | --- |
| Oct 8-12 (WP-18) | Scaffold (1.2 pins, lint, Vitest, Playwright, bundle gate); contracts types from WP-02; SSE lift; reducers and machines (6.1-6.5 as pure modules with tests) | `make check` green for `web/` |
| Oct 13-18 (WP-19, WP-22; slice, unstyled) | Plain room (text practice and assessment), evidence board with whole content and Present insertion, coach card with chips and complete-card reveal, finding commit producing the shared `Finding`, minimal unstyled debrief rendering `debrief.v1` (outcome, five rubric cards, three scorecards), case library with one variant per family, plain dev leaderboard; minimal voice session with consent and a placeholder bar if the Live probe passes | E2E-1, E2E-2, E2E-3, E2E-14; E2E-4 if voice |
| **2026-10-18 slice gate** | Nothing presentational before this line | |
| Oct 19-24 (WP-20a) | Full debrief (annotated transcript, export), progress and the KPI-1 flow, trainer console, admin console on the referee process; in the first days after the gate, the motion spike (6.6) and the one-character production test (6.4); DESIGN.md applied when it lands | E2E-8, E2E-15, E2E-16 |
| Oct 21-28 (WP-20b) | Arena matrix, hidden progress table and pipeline rail, trial replay, leaderboards in full, trust center | E2E-5, E2E-6, E2E-7 |
| Oct 24-30 (WP-21) | Design pass, companion, portraits within the 62-image cap, signature moments, voice pill bar, pause control | E2E-9, E2E-10, E2E-12, E2E-13 |
| Oct 31-Nov 2 | Accessibility pass, REL-1 frame pacing, recordings for S7 | All FE criteria green |

Cut order follows S8 section 7: the A2A exhibition section goes first (item 1); then the office theater toggle and extra motion (item 3; ship the pipeline rail with the reduced-motion rendering); then companion and portrait art (item 4; ship the status words and the coach activity line). Live Avatar is out of scope, not a cut item. Never cut: mode projections and leak tests, EX-4 placements, the gate-before-rank leaderboard, citation chips, the trust center's isolation and fairness sections.

---

## 15. Dependencies on other spec parts

| Needed from | Item |
| --- | --- |
| S5 (API) | The route table of S5 5.5 (`contracts/openapi.json`); the REST snapshot and SSE deltas of at most 16 KB with `?after=` replay, ping, `stream_max_s` and catch-up tickets until the debrief is published (D9); the projection of S5 6.2 that maps S4 kinds to the wire types in 5.3 and synthesizes `subject.thinking`, `coach.working`, `trial.status` and `notice`; the tournament poll on the ledger cursor with counts only for hidden tournaments before reveal, and trial replay on the trial's own `seq`; `config` values (`voice_available`, `exhibition_enabled`, `phoenix_url`, `question_max_chars`, `planned_n`, `paused`); `GET /api/me` with `study` and `csrf_token`; the Host, Origin and CSRF guard on both origins (D10); `409` on a stale `expected_version` and during an open turn; `422 context_full`; the acknowledgement route calling `ops.ack_card`; voice frames and close codes of S5 7.3 and 7.5 with `exchange_count` and `4410` (C-29); the local dev identity middleware (S5 10.3); the referee process serving the static bundle with its own `/api/me`, `/api/config` and review item routes; one variant per family and sibling hiding (C-37) |
| S4 (data) | `training.publish_debrief` and `training.v_my_debrief` (D8); `ops.ack_card` with `unmeasured_timeout` (C-28, D4); `training.v_my_study`; `arena.v_tournament_progress`; `arena.isolation_checks` rows; leaderboard rows with all fields in 4.10; the applied `global` ceiling and spend readable through the trust-center budget projection |
| S4 section 7 (ledger) | Exact commitment construction for in-browser verification (4.11) |
| S1 (scenario) | `presentation {persona_id, display_name, voice_id}` per family, no `baseline_demeanor`; optional record `date` (C-21); `doc_kind` (C-24); the Content object and `content_text()` (6.1) |
| S2 (agents) | card.v1, deep.v1 and the stored finding object (4.8); the 4.5 templates; the one quote predicate `quote_ok` and its fixture file (1, 4.4.1; D6) |
| S3 (metrics) | KPI-4 definition (6.4); `debrief.v1` (5.7); review task kinds (7.3) |
| `cost_model.py` | `budget_plan()` (the `global` ceiling), `demo_bucket()` (portrait figures), `PORTRAITS` |

---

## 16. Open questions (each with a proposed fix)

1. **Turn closure in assessment mode.** The turn stays open until the coaching event commits (S4 5.3, S5 5.1), but assessment withholds every coaching event, so the client cannot see when Send is allowed. Fix: the projection emits a content-free synthesized `turn.closed {turn_no}` in assessment mode (every turn has a card or a miss, so its existence reveals nothing). Until then the client handles the `409` as in 4.3.
2. **`GET /api/config` keys.** Resolved (X-15, D7): S5 5.5 returns `phoenix_url` (4.11) and `question_max_chars` (4.3) beside `voice_available`, `exhibition_enabled`, `paused`, `quotas` and `planned_n`; `voice_scored` no longer exists because voice is always unscored.
3. **Hosted only:** WebSocket through IAP and IAP latency (1.4, probes before enabling).

Resolved since version 1: browser Supabase session (C-03), admin path (C-39 locally; WP-33 hosted), the `playback_ack` control (C-29; then deleted with `played` in v2.3, D7), the KPI-4 composition (C-28: S3 6.4), the route list (C-18: S5 5.5). Resolved during this reconciliation by S2 and S5 version 2: investigator findings carry empty `basis_flag_refs` (S2 4.8); `expected_version` on the turn route (S5 5.2); per-person identity locally is one acting user per run (S5 10.3); the trainer console's process (S5 5.5).

## 17. Sources and query log

Files read (read-only): `docs/spec/README.md`; direction v10.3; UI direction v2.1; REQUIREMENTS.md; `docs/challenge/unissant-use-case.txt` (line 99, EX-4); DECISIONS.md (D-001 to D-012); PATTERNS.md; S8 sections 0-3, 7 and 9-11; S2 version 2 sections 1 and 4 (including 4.8); S3 6.4; S4 sections 4.1, 5, 8.8; S5 version 2 sections 4.8, 5-7, 8.7, 10; S7 (EX-4 and "interview room" rows); `sql/0003_tournament_ledger.sql` and `sql/0004_privileged_functions.sql` (ledger event types, `ledger.v_events`); X5; I6; I7. gokbase `recruiter-frontend`: `voice/voiceMachine.ts`, `voice/kin/fsm.ts`, `voice/kin/registry.ts`, `voice/kin/KinLayer.tsx` (640-760 and grep), `voice/companionContext.tsx`, `voice/raf.ts`, `voice/audioController.ts` (1-120, 225-300), `voice/useVoiceSession.ts` (grep), `voice/Transcript.tsx` (1-40, 300-325, grep), `public/worklets/playback-processor.js`, `scripts/check_pet_bundle.mjs` (1-40), `package.json`. TechnoMile: `docs/design/motion.md`, `docs/design/pipeline-view/SPEC.md` (sections 1-6), `web/src/lib/pipeline/rail.ts` (1-40, 241-330), `web/src/components/pipeline/pipeline-view.tsx` (1-60), `web/src/lib/sse/ticketed-stream.ts`, `web/src/lib/sse/frames.ts`, `web/src/lib/contracts/run-events.ts` (1-60), `web/src/lib/war-room/office.ts` (1-75, 320-400, 737-776, exports), `web/src/components/war-room/agent-office.tsx` (1-80, 120-200, 842-897, grep), `web/src/components/war-room/swarm-graph.tsx` (grep), `web/package.json`, `web/next.config.ts`.

Numbers: `python3 -I -B docs/research/synthesis/cost_model.py` and `--plan-json` (run 2026-10-08; `budget_plan()["art"]` = $6.20, `PORTRAITS` = (62, 0.07, 0.10)); `stats_contracts.zero_event_upper_bound(12)` = 22.1% (imported and run 2026-10-08).

Context7 (CLI, version 1): `library "Next.js"` -> `/vercel/next.js`; `docs /vercel/next.js` static export (2 calls); `library "Vite"`, `library "Tailwind CSS"`, `library "React Router"` (resolutions); `docs /tailwindlabs/tailwindcss.com` Vite plugin and `@theme`; `docs /remix-run/react-router` data mode; `library "React Router"` v8; `docs /websites/reactrouter` v8 upgrade and `createBrowserRouter`. No quota errors. Motion's API is checked at scaffold (1.2).

Google Developer Knowledge MCP (version 1): `answer_query` IAP session expiry for AJAX (`iap/docs/sessions-howto`); `answer_query` IAP with WebSockets and SSE on Cloud Run, request timeouts (`run/quotas`, `iap/docs/concepts-overview`); `search_documents` IAP on Cloud Run limitations and Cloud Run WebSockets (`iap/docs/enabling-cloud-run`, `run/docs/securing/identity-aware-proxy-cloud-run`, `run/docs/triggering/websockets`).

npm registry (read-only `npm view <pkg> time`, version 1): versions and publish dates in 1.2.

No GCP, Vertex or paid API calls were made.

Version 2.3 (2026-10-08) read: the Codex round 1 findings for S6-S8 (SG4-01 to SG4-19), S5 v2.3 sections 5-7 and 10.3-10.4, S3 v2.3 sections 5.7 and 7.3, S1 v2.3 section 12, and the shared decisions D1-D11. No reference repository was reopened; no model, GCP or paid call was made.

## 18. Changes in v2

| C-ID | What changed in S6 |
| --- | --- |
| C-01 | Trust-center budget shows the applied bucket tree and "planned n" from the server (24 baseline, 30 pilot-gated, OD-8); before `budget_plan()` is applied every bucket reads $0 with a fail-closed statement (D-012); the zero-event example uses 12 families (`zero_event_upper_bound(12)`). |
| C-02 | Local-first is the default throughout (1.3, 3.5, 4.11, 12); IAP, Cloud Run, session expiry, stream cost and hosted probes moved to 1.4, the hosted variant (WP-33, OD-10). |
| C-03 | No Supabase Auth in the browser; locally the S5 10 dev identity middleware, hosted the IAP JWT mapped to an allowlisted user; v1 open question 2 closed. |
| C-04 | The coach card renders S2 card.v1 field names (`question`, five flag kinds, `quote`, `conflict_*`, `follow_up.question`, `finding.likelihood`); the ICD 203 phrase is rendered client-side from S2 4.5 templates. |
| C-16 | Wire frames key turns by `turn_no`; `tNN` stays inside card payloads; `T{n}` is display only; documents `doc-NN`, records `rec-NN`. |
| C-17 | Section 5.3 maps S4's persisted kinds to wire types; `snapshot`, `subject.thinking`, `coach.working` and `notice` are synthesized; `debrief_ready` added; `trial.status` is synthesized and `trial.finalized` comes from `trial_ended` (S5 6.2); the voice time warning moves to the voice socket; the tournament stream is replaced by a 2 s poll of frames derived from `arena.v_trial_events` and `ledger.v_events` (v1's `referee.labeled` and `budget.*` frames dropped as not derivable). |
| C-18 | Section 5.5 no longer defines routes: it points to S5 5.5 (`contracts/openapi.json`) and lists which screen uses each S5 route (`/turns`, `/evidence-requests`, `/finding`, `/stream-tickets`, `/api/voice/tickets`, `/api/telemetry/kpi4`, the debrief `POST`); trainer and admin routes live on the referee origin. |
| C-19 | `presented_record_ids` dropped; Present inserts the record title and a selected excerpt into the editable question. |
| C-21 | `presentation {persona_id, display_name, voice_id}` from S1 schema v1.1; optional record `date` shown on the board. |
| C-22 | `baseline_demeanor` removed; the portrait is neutral; FE-AV-3 checks the key is absent. |
| C-24 | `evidence.released` carries `doc_kind` when set; the board shows the document kind. |
| C-26 | FE-LIB-1 notes S5's server-side route test for style before reveal. |
| C-27 | The finding dialog produces S2 4.8's stored finding object (label, likelihood, confidence, cited turns and released records, corroboration, rationale, optional alternatives; `basis_flag_refs` empty for investigators) and posts `{finding, idem_key}`; FE-FIND-4 added. |
| C-28 | The client posts an acknowledgement right after validating the card; KPI-4 is S3's server-clock measure; RTT arithmetic and `GET /api/ping` removed. |
| C-29 | Voice protocol follows S5: frames and close codes of S5 7.3 and 7.5 plus `exchange_count` and `4410`; `4429` becomes `4413`; the control is `played {utterance, samples}`; turn text arrives on SSE. |
| C-35 | `source_unavailable` added to the arena matrix's execution-state counts. |
| C-37 | The case library lists one server-drawn variant per family; siblings are never offered after a debrief; KPI-1 sets come from unseen families; FE-LIB-3 added. |
| C-38 | (a) Motion + CSS, GSAP only after the post-slice spike (1.2, 6.6). (b) Live Avatar out of scope. (c) Pipeline rail first (6.5); the office theater toggle is cut item 3. (d) Pet states per UI direction with `encouraging` only in practice and only from the card's question block, no `celebrating` on findings, `sleeping` in assessment; FE-PET-6 added. (e) The sponsor's exact EX-4 text everywhere, tested against slide 8. (f) "Interview room" in all judge-facing copy. |
| C-39 | The admin console is served by the local referee process on its own port (the trainer console too, per S5 5.5); the hosted path is decided in WP-33. |
| C-45 | Wire status derives from trial status and the terminal record (`trial.status` from `trial_ended`); `finalizing` is client-side. |
| C-46 | Portrait cap 62 images (`PORTRAITS[0]`) inside the $6.20 `art` leaf (`budget_plan()["art"]`). |

Also aligned with UI direction v2.1 (no C-ID): the 2a visibility rule (5.4, FE-SSE-7), complete-card reveal (4.5, FE-COACH-7), voice-bar state from four inputs with amplitude from the playback node (6.2, FE-VOICE-6), avatar states `idle`, `speaking`, `pausing` (6.4), signature moments, reduced motion and the pause control (6.6, FE-MOT-1..3), frame-interval measurement on the combined workload (section 10), art sub-budget and production-test fallback (6.4), copy rules and the anti-slop checklist (7.2), motion token names (section 11), and presentational work only after the 2026-10-18 slice gate (preamble, section 14).

## 19. Changes in v2.1

| ID | What changed in S6 |
| --- | --- |
| D-013 | One `global` ceiling: the trust-center budget (4.11), tournament list (4.9) and admin ledger (4.13) show the applied `global` ceiling and spend grouped by purpose, not a bucket tree; portraits reserve against `global` under the 62-image count cap, with the $6.20 high and $4.34 expected figures named from `demo_bucket()` (6.4, 14, 15). |
| D-014 | Planned n reads 30 baseline, 34 pilot-gated (4.11); governing decisions now D-001 to D-014. |
| X-08 | 4.2: KPI-1 case-set families are never listed for practice; a participant receives the assigned set whole for pre-test and post-test. |
| X-11 | 5.3, 5.6: `ops.ack_card(trial, turn_no, client_valid)`; the client posts `client_valid: true | false` (stored as `delivered` or `client_invalid`); `coach.failed` reasons `timeout` and `repair_failed`; FE-KPI4-1 restated. |
| X-14 | 3.7, 4.13: the admin console shows the kill-switch state read-only with the owner's `scripts/kill_switch.sh` command; no control. |
| X-15 | 4.1: EX-4 acknowledgement stored by `training.acknowledge` and read back through `GET /api/me`; 4.3, 16: `GET /api/config` keys `voice_scored`, `phoenix_url`, `question_max_chars`; 5.3: `block.started` dropped (no ledger event backs it; progress comes from `trial.started`), and the `trial_ended` seq rule stated; 6.2: close code 4409 for a subject guard hit; `played.samples` is cumulative. |

## 20. Changes in v2.3

| ID | What changed in S6 |
| --- | --- |
| SG4-01 (D10) | 1.3: every request on both origins passes the Host check; every POST, bodyless ones included, carries an allowed `Origin` and `X-Arena-CSRF` matching the `SameSite=Strict` cookie that `GET /api/me` sets; one fetch wrapper adds the header and retries once after a 403; FE-TECH-5 and E2E-14 added. |
| SG4-02 | 5.3 and 6.1: `ended` is entered only on a terminal status; the commitment hash comes from `trial.finalized`; the `trial_ended` row's `seq` rides on the last frame of the completion pair, so a disconnect between them replays both; the stream stays open for catch-up until the debrief is published; FE-SSE-8. |
| SG4-03 (D9) | 5.1-5.3: the absolute state comes from `GET /api/trials/{id}/snapshot` over REST; SSE carries deltas only, each at most 16 KB; the oversize fallback and the `CUSTOM` frame are deleted; FE-SSE-6 accepts a snapshot over 16 KB through REST. |
| SG4-04 (D9) | 4.9, 5.1, 5.3, 6.5: no tournament stream and no merged cursor; the arena polls the global ledger cursor, which returns counts only for a hidden tournament before reveal and resets to `after=0` when it switches to events; trial replay pages by the trial's own `seq`; hidden trials appear only as block-level counts; FE-ARENA-2, FE-ARENA-4, FE-SSE-4, FE-AW-7. |
| SG4-05 | 4.5, 5.2, 5.3: the training wire card is the stored card without candidate identifiers; stored, training and tournament cards are three schemas and the client validates only the wire schemas; FE-COACH-8. |
| SG4-06 (D7) | 6.2: the `played` control is deleted (voice is unscored, so nothing counts played audio); the playback worklet reports `drained` and `cleared` to the UI only; outbound frames are audio, `stop` and `interrupt`; FE-VOICE-4 and FE-VOICE-6 restated. |
| SG4-07 (D8) | 3.4, 4.7, 5.4: the debrief renders the published `debrief.v1` from `training.v_my_debrief`; POST and GET return the same document; the visibility matrix gains the owner's ended development session as the one place role and resolution appear; FE-DEB-5, FE-DEB-6. |
| SG4-08 (D8) | 4.7: the detection scorecard is R3's J3 verdicts on the session coach's flags (R3's investigator call now receives them, S2, S3 5.7), rendered from `scorecards.detection`. |
| SG4-09 | 3.6, 4.12: review items are S3 7.3's three task kinds (T-RUB, T-LAB, T-FLAG), each with its own response schema; raters submit binary checks, labels or verdicts and never a 0-4 dimension score; T-LAB shows the private ledger to calibration raters on development cases only; FE-REV-1, FE-REV-3. |
| SG4-10 | 3.2, 4.2, 5.5: the session request has no phase; the server derives it and enforces two pre-tests, three practice sessions, two post-tests; the client shows the step from `/api/me` `study`; E2E-16. |
| SG4-11 | 2.1, 4.12, 4.13, 5.5: the referee origin serves its own `GET /api/me`, `GET /api/config` and `GET /api/review/items/{id}`; FE-ADM-3 and E2E-15 open both consoles directly on port 8082. |
| SG4-13 | 4.8, 4.10: KPI-1 is reported only from participants who completed the protocol; otherwise every KPI-1 surface reads "KPI-1 not measured". |
| SG4-15 | 14: a minimal unstyled debrief rendering `debrief.v1` moves into the slice window (WP-19), so E2E-1 and E2E-2 are satisfiable at the slice gate. |
| SG4-16 | 5.5: the acknowledgement body is `{trial_id, turn_no, client_valid}`. |
| SG4-17 (D6) | 4.5: `quoteOk` is the TypeScript port of S2's one predicate, with dash normalization (U+2010 to U+2015, U+2212) and the 3-word or whole-answer rule, tested on S2's shared fixture file; FE-COACH-3. |
| SG4-18 | 4.4, 4.7: personal pins are page state only, never stored or sent; FE-EVD-5. |
| SG4-19 | 11: one release rule shared with S8 OD-4 and R-10: if DESIGN.md has not arrived by 2026-10-20, the release ships the placeholder theme, which must pass the accessibility, token and anti-slop checks. |
| D5, D11 | 4.3, 4.6: questions at most 600 characters (`question_max_chars`), `422 context_full` locks the composer; the finding carries `rationale` (1-600 characters). |
| D7 | 0, 3.3, 4.3, 4.7, 5.6: voice sessions are unscored practice, labeled so in the room and the debrief; voice turns open no KPI-4 sample; evidence in voice uses the same board and route. |
