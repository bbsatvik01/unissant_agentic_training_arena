# S6: Frontend and UX

Part S6 of the build specification for the Investigative AI Training Arena. **Version 1, 2026-10-08.** Governing inputs: `docs/research/synthesis/02-direction.md` v10 (cited as "direction"), `docs/challenge/REQUIREMENTS.md` (requirement IDs), `docs/handoff/DECISIONS.md` (D-001 to D-009; D-007 superseded by D-009), `docs/handoff/PATTERNS.md`, research routes X5, I6, I7. Lift sources were read directly on 2026-10-08 and are cited by path and line range.

Scope: the browser application only. Server routes, SQL functions, the voice relay and the scorer are specified elsewhere; where this document needs something from them, it says so in section 15 and designs so the frontend works with the stated contract.

The owner's DESIGN.md has not arrived. This spec makes no visual decisions: no colors, type, spacing values, illustration style or layout aesthetics. It fixes structure, behavior, contracts, accessibility, performance and tests, and exposes design token hooks (section 11) that DESIGN.md fills. PATTERNS.md says "until DESIGN.md lands, no UI implementation"; everything here that does not depend on visual design (contracts, reducers, state machines, SSE client, voice machine, tests) can be built before it, and that is the intended order.

Conventions: requirement IDs in parentheses; acceptance criteria are numbered `FE-<area>-<n>` and each is testable; "OWNER DECISION PENDING" marks a point the owner decides, with a design that works for either answer.

---

## 0. Requirement coverage

| Requirement | Where in the UI | Section |
| --- | --- | --- |
| CH-1, SOL-1, SOL-2, SOL-6 | Interrogation room, text and voice, practice and assessment; text transcript is the scored artifact | 4.3, 5, 6.2 |
| CH-2, AST-1..AST-3, AST-6..AST-8, EX-1..EX-3 | Coach companion card: question assessment, answer category, cited flags, neutral follow-up, running finding | 4.5 |
| AST-7 | Citation chips resolve to an exact turn and quoted span; a quote not found is shown as such | 4.5 |
| AST-10, PRB-3, PRB-4 | No stress or nervousness meters; equal visual weight for the three findings; companion never rewards accusations | 7 |
| SCN-4, SCN-7, SCN-10 | Evidence board (court record), released records with turn and trigger | 4.4 |
| SCN-5, SCN-12, BKO-9 | Mode projections; hidden-case material never reaches the browser before reveal | 5.4 |
| SCN-3, SCN-11 | Avatar persona and voice assigned per family, independent of role | 6.4, 7 |
| EVL-1, EVL-2, EVL-7, KPI-1 | Debrief: five 0-4 cards, three scorecards, annotated transcript, progress | 4.7, 4.8 |
| CH-4, BKO-1..BKO-7, BKO-10 | Arena: tournament matrix, agents at work, replay and interactive tracks | 4.9, 6.5 |
| EVL-3..EVL-6, EVL-9..EVL-11, KPI-2, KPI-3, KPI-5 | Leaderboards: gates before rank, intervals, provisional flags, manifest hash | 4.10 |
| EVL-12, EX-4 | Trust center, methodology, EX-4 placements | 4.11, 8 |
| BKO-3, EVL-7 | Trainer console, blinded review | 4.12 |
| KPI-4 | Client-side measurement of card arrival; render budget | 5.6, 10 |
| SUB-7 | Untrusted subject text rendered as text only, never HTML or markdown | 4.3 |

---

## 1. Technology decision

### 1.1 Framework: Vite + React (single-page app), not Next.js static export

Direction DM-6 fixes the hosting: a static build served same-origin by `arena-api` behind IAP. Both candidates can produce a static build; Vite fits better.

| Factor | Next.js `output: 'export'` | Vite + React + React Router | Weight |
| --- | --- | --- | --- |
| Runtime-ID routes (`/sessions/:id`, `/arena/:tournamentId/trials/:trialId`) | Not supported: static export rejects dynamic routes without `generateStaticParams()` and with `dynamicParams: true` (Next.js docs, `static-exports.mdx`, "Unsupported Features", Context7 `/vercel/next.js`, 2026-10-08). IDs are created at runtime, so every such page would become a query-string page or a catch-all client router, which is Vite's model with more config. | Native (`createBrowserRouter`, path params) | High |
| Server features we would give up anyway | Route handlers, cookies, rewrites, headers, proxy, server actions, image optimization: all unsupported in export (same source). SSR has no value behind IAP with no SEO need. | Not present, nothing to disable | Medium |
| Lift fit | TechnoMile web is Next 16.3.6 (`web/package.json`), but the lifted pieces (`ticketed-stream.ts`, `office.ts`, `agent-office.tsx`) are client code (`"use client"`), portable as-is | gokbase `recruiter-frontend` (voice, kin, worklets) is already Vite + React 19 + Tailwind 4 + Vitest + Playwright (`recruiter-frontend/package.json` lines 7-17, 95-148); its bundle gate reads the Vite manifest (`scripts/check_pet_bundle.mjs` lines 6-7) | Medium |
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

No animation library, no 3D runtime, no state library, no data-fetching library. Motion is CSS transitions and keyframes on `transform` and `opacity` (TechnoMile `docs/design/motion.md` lines 5, 38); per-frame values ride CSS custom properties set outside React (gokbase `kin/KinLayer.tsx` lines 669-670). Icons and fonts are DESIGN.md decisions.

### 1.3 Serving, origin and auth

| Concern | Rule | Requirement |
| --- | --- | --- |
| Origin | One origin. `arena-api` serves `dist/` and `/api/*`. SSE at `/api/.../events`, voice WebSocket at `/api/voice/ws`. No CORS anywhere (DM-6: IAP rejects cross-origin preflights). | DM-6 |
| SPA fallback | `GET` requests for non-`/api`, non-asset paths with `Accept: text/html` return `index.html` | |
| Caching | Hashed assets `Cache-Control: public, max-age=31536000, immutable`; `index.html` `no-cache` | |
| CSP (set by `arena-api`) | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://<host>; worker-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. No inline scripts, no third-party origins, no analytics. Worklets are same-origin static files (gokbase `audioController.ts` lines 15-16). | SUB-7, security |
| Identity | IAP cookie on every request. The browser never talks to Supabase or PostgREST directly; every read and write goes through typed `arena-api` routes (direction 4.1: "Served only through explicit typed projections"). `GET /api/me` returns `{user_id, display_name, roles[], quotas, ex4_acknowledged}`. | SCN-5 |
| IAP session expiry | Every `fetch` sends `credentials: 'same-origin'` and `X-Requested-With: XMLHttpRequest`, so IAP answers an expired session with `401` instead of a `302` (GDK, `docs.cloud.google.com/iap/docs/sessions-howto`, 2026-10-08). On `401` the app shows a non-blocking "Session expired" banner with a "Sign in again" button that opens `<origin>/?gcp-iap-mode=DO_SESSION_REFRESH` in a new window and polls `GET /api/me` with the same header until `200`, then closes it and resumes. `EventSource` cannot set headers; its ticket mint is a `fetch`, so expiry surfaces there and triggers the same flow. | D-008 |
| Local dev | Vite dev server proxies `/api` (with `ws: true`) to the local `arena-api`, so the browser still sees one origin | |
| Kill switch and quotas | `arena-api` answers `503` with `{"code":"paused"}` when the kill switch is on and `429` with `{"code":"quota"}` per user; the app shows a plain banner stating why (direction 8.3, D-009) | D-008, D-009 |

Acceptance:
- FE-TECH-1: `vite build` emits only static files; a test serves `dist/` from a plain static handler and every route in section 2.2 loads by direct URL (SPA fallback).
- FE-TECH-2: a Playwright test with a mocked `401` on `/api/me` shows the expiry banner, and the "Sign in again" button opens a URL ending `?gcp-iap-mode=DO_SESSION_REFRESH`.
- FE-TECH-3: a source lint fails the build on any `fetch(` outside `src/lib/api/` and on any import of `@supabase/*`.
- FE-TECH-4: the built `index.html` and JS contain no absolute `http(s)://` origin other than documentation links in the trust center.

---

## 2. Information architecture

### 2.1 Roles (from `GET /api/me`)

| Role | Who | Sees |
| --- | --- | --- |
| `investigator` | Team, volunteers (KPI-1), judges | Case library, own sessions, debrief, progress, arena (projected), leaderboards, trust center |
| `judge` | Allowlisted judges (D-008) | Everything `investigator` sees; same per-user quotas |
| `trainer` | Blinded human raters (EVL-7 calibration, KPI-1 scoring) | Trainer console only for review items; never participant identity, pre/post label or dates |
| `admin` | Team leads | Admin console, served from `arena-referee` (section 4.13) |

### 2.2 Routes and screens

| Route | Screen | Roles | Requirements |
| --- | --- | --- | --- |
| `/onboarding` | EX-4 acknowledgement, how coaching works, recording notice, voice disclosure | all | EX-4 |
| `/` | Case library | investigator, judge | PRB-1, PRB-2 |
| `/cases/:caseId` | Case brief and session start (mode, channel) | investigator, judge | SCN-7, SOL-6 |
| `/sessions/:sessionId` | Interrogation room (text or voice; practice or assessment) | owner of session | CH-1, SOL-1, SOL-6 |
| `/sessions/:sessionId/debrief` | Debrief | owner of session | EVL-1, EVL-2, EVL-7 |
| `/progress` | Progress and KPI-1 study status | investigator | KPI-1 |
| `/arena` | Tournament list | all | CH-4 |
| `/arena/:tournamentId` | Tournament matrix and agents at work | all | BKO-1, BKO-7 |
| `/arena/:tournamentId/trials/:trialId` | Trial replay | all (projected) | BKO-6, BKO-9 |
| `/leaderboards/:tournamentId?` | Assistant, subject and investigator scorecards | all | EVL-1, EVL-3..EVL-6, EVL-9..EVL-11 |
| `/trust`, `/trust/:section` | Trust center: isolation, commitments, fairness, methodology, budget | all | EVL-12, EX-4, SCN-5 |
| `/review`, `/review/:itemId` | Trainer console | trainer | BKO-3, EVL-7 |
| `/admin` | Admin console (only on the `arena-referee` origin) | admin | BKO-9 |

Route modules are lazy (`lazy: () => import(...)`), so the room, arena, voice and character art load only when used.

---

## 3. User flows

### 3.1 Practice, text (the slice flow; CH-1, SOL-6 Practice)
1. First visit: `/onboarding`; the EX-4 statement must be acknowledged (server-stored) before any session starts.
2. Case library: pick a development case; choose Practice; channel Text.
3. `POST /api/sessions` returns `{session_id, trial_id}`; the room opens and the trial stream connects (section 5).
4. Loop, up to 12 exchanges (BKO-8): investigator types one question, optionally attaches released records ("present evidence"), sends; the subject avatar shows `thinking`; the answer appears as turn `Tn`; the coach card for that turn arrives with cited flags, a neutral follow-up and the running finding (AST-1..AST-3). The investigator may request a record from the requestable list at any time; a release appears on the evidence board with its turn (SCN-4).
5. The investigator commits a finding (deceptive, truthful, insufficient evidence) with confidence, cited rationale, and for "insufficient" the corroboration to seek (EX-3). At exchange 12 the composer locks and commit is required.
6. `finalize_trial()` runs server-side; the room shows the commitment hash, then links to the debrief.

### 3.2 Assessment, text (SOL-6 Assessment; KPI-1 pre and post tests)
Same as 3.1 except: no coach card, no coach activity, no running finding, and the companion follows lifecycle states only. Coaching is computed and stored server-side; the debrief reveals it. The room header states "Assessment: coaching is saved for your debrief."

### 3.3 Practice, voice (D-006; development cases only, direction section 9)
1. Channel Voice is offered only when `case.split = 'dev'`, `config.voice_available = true` and the user's voice quota is non-zero.
2. Disclosure and consent screen (gokbase pattern: disclosure plays before the mic opens, `audioController.ts` lines 22-24); then `POST /api/voice/ticket` and `new WebSocket(url, [ticket])` (gokbase `useVoiceSession.ts` lines 10-11, 308-328).
3. The investigator speaks; the subject answers in audio; live transcript fragments render as captions; each server-finalized turn (`voice.turn_committed`) enters the transcript as `Tn` and triggers the same coach card over SSE as text.
4. Interrupted subject utterances are marked partial and are not citable (direction 9, F10).
5. The session ends at 12 exchanges, 480 s, idle, cost cap or user stop; the investigator then commits a finding in text.
6. Voice in assessment mode is disabled until the voice acceptance tests in direction 9 pass and the server sets `config.voice_scored = true`; until then voice sessions are practice-only and outside scored training results.

**OWNER DECISION PENDING (direction 3.2 decision points, Oct 15 and Oct 18):** voice may become Live on Vertex (default), push-to-talk STT-LLM-TTS (D-006 exception), Developer API Live (D-001 exception) or dropped. The voice machine (6.2) has a `mode: 'live' | 'push_to_talk'` input; push-to-talk replaces `listening` with `recording` held by an explicit control. If voice is dropped, `config.voice_available = false` hides the channel and nothing else changes.

### 3.4 Debrief and progress (EVL-1, EVL-2, EVL-7, KPI-1)
Debrief opens after finalize. Rubric cards show "Scoring" until `debrief.ready`; the annotated transcript is available at once. Progress shows the participant's score series and, for study participants, pre and post results with absolute change and relative change (undefined when pre = 0, EVL-7/KPI-1 contract in direction 7.2).

### 3.5 Judge path (D-008; matches S7 section 2.2)
Sign in through IAP, onboarding, one practice session, debrief, `/arena`, `/leaderboards`, `/trust`. Quota messages state the reason plainly.

### 3.6 Trainer review (BKO-3, EVL-7)
`/review` lists assigned blinded items; each shows a transcript with participant, pre/post label, dates and coach output removed; the trainer scores five dimensions 0-4 against the frozen anchors and submits once.

### 3.7 Admin (BKO-9)
Admin uses the console on the `arena-referee` origin (section 4.13): tournament lifecycle, budget ledger, subject validity review queue, reveal with precondition checklist, kill switch.

---

## 4. Screens and components

Each component lists its data source and acceptance criteria. Layout and visual treatment come from DESIGN.md; region names below are structural.

### 4.1 Onboarding (EX-4)
- Regions: EX-4 statement (exact sponsor wording, section 8), what the coach does and does not do, what is recorded, a link to methodology.
- Acknowledge button calls `POST /api/me/ack-ex4`.
- FE-ONB-1: no session-start control in the app is enabled while `ex4_acknowledged = false` (Playwright).
- FE-ONB-2: the statement text equals the `EX4_TEXT` constant (unit test against REQUIREMENTS EX-4 wording).

### 4.2 Case library (PRB-1, PRB-2)
- Data: `GET /api/cases` (development cases only; hidden cases are never listed, SCN-12).
- Card fields: case ID, domain, investigation objective (one line), difficulty, completion status for this user, available channels. **Not shown: communication style, role, family ID, matched-variant relationships** (style shown before an interview primes demeanor reasoning, PRB-4; family ID lets a user pair matched variants).
- Study participants see their assigned step ("Pre-test", "Practice", "Post-test") with the server-assigned case set (counterbalanced, direction 7.2 KPI-1 protocol).
- FE-LIB-1: a contract test asserts the case-list schema has no `style`, `role`, `family_id` or `variant` fields; the client schema rejects a payload containing them.
- FE-LIB-2: the case brief (`/cases/:id`) renders the full public packet (SCN-7: case ID, objective, known timeline, initial documents, interview context).

### 4.3 Interrogation room (CH-1, SOL-1, SOL-6)

Regions:

| Region | Content | Practice | Assessment |
| --- | --- | --- | --- |
| Case header | Case ID, objective, exchanges used `n/12`, mode badge, channel, EX-4 line | yes | yes |
| Subject panel | Subject avatar (6.4), persona display name, status word ("Listening", "Answering", "Session ended") | yes | yes |
| Transcript | Turns `T1..Tn` with speaker, text, release markers; partial voice turns marked "interrupted" | yes | yes |
| Composer | Question input, attached-record chips, Send; voice control when on voice | yes | yes |
| Evidence board | Section 4.4 | yes | yes |
| Coach companion card | Section 4.5 | yes | hidden (placeholder text "Coaching is saved for your debrief") |
| Companion | Section 6.3 | lifecycle and coach events | lifecycle only |
| Finding commit | Section 4.6 | yes | yes |

Behavior:
- One open question at a time: Send is disabled from `question.accepted` until `subject.answer` or a terminal status (server enforces too).
- Question length limit 600 characters (server value from `GET /api/config`, displayed as a counter).
- Subject and coach text are untrusted (SUB-7): rendered as plain text nodes, never `dangerouslySetInnerHTML`, never markdown. Quoted spans are highlighted by offset, not by HTML injection.
- Transcript region is `role="log"` with `aria-live="polite"`, mounted from the start and never unmounted (gokbase `Transcript.tsx` lines 15-18, 472-473); voice captions batch announcements at clause boundaries or every 400 ms (same file, lines 310-325).
- Mobile (< 768 px): regions become tabs (Transcript, Evidence, Coach); composer stays pinned and does not obscure focused content (WCAG 2.4.11).
- Terminal statuses other than `completed` show a neutral message: `subject_quarantined` -> "The session was stopped for a platform check. It is not counted." (never names the subject's behavior); `infra_failed` -> "The session stopped because of a technical fault."; `budget_skipped` / `budget_truncated` -> "The session stopped because the spend limit was reached."

Acceptance:
- FE-ROOM-1: a component test with a fixture event sequence renders turns in seq order regardless of arrival order and ignores duplicate seqs.
- FE-ROOM-2: an XSS fixture (`<img src=x onerror=...>` and markdown links in subject text) renders as literal text; no new elements in the DOM.
- FE-ROOM-3: in assessment mode the coach card region contains no coach text after a full fixture session (and the client logs a contract violation if any `coach.*` event arrives, section 5.4).
- FE-ROOM-4: after 12 exchanges the composer is disabled and the finding commit is the only primary action.
- FE-ROOM-5: each terminal status renders its neutral message; the `subject_quarantined` message contains none of the words "attack", "injection", "deceptive", "lying".

### 4.4 Evidence board, court-record pattern (SCN-4, SCN-7, SCN-10)

The pattern follows Ace Attorney's always-visible court record (X5 section 1): an inventory the investigator can consult and present. One change from the game pattern: records are **never tagged with the statements they contradict**, because contradictions are evaluator-only (SCN-9). The investigator draws those links.

- Sections: Initial documents (from the public packet), Released records (each with "released at turn n" and trigger `scheduled` or `requested`), Requestable records (from the public list; a Request button calls `POST /api/trials/:id/evidence-requests` with a work item).
- A denied request shows "Not available at this point in the interview" without the predicate (predicates are evaluator-only, SCN-9) and leaves the record requestable.
- "Present": attaching a released record to the next question adds a chip to the composer and sends `presented_record_ids` with the question (Strategic Use of Evidence, direction 6.1; the subject's disclosure gates depend on evidence presented, direction 6.2).
- Personal pins: the investigator can pin a record to a transcript turn ("relates to T4"). Pins are the investigator's notes, stored with the session, shown in the debrief; they never reach the coach or subject.
- FE-EVD-1: a released record appears within one render of its `evidence.released` event, in release order, with turn and trigger.
- FE-EVD-2: a denied request's message is the fixed generic string; the response body's `reason` code is not displayed beyond it.
- FE-EVD-3: presenting is keyboard-operable without drag (WCAG 2.5.7); only records already visible on the board can be presented (the client offers no others; the server rejects others).

### 4.5 Coach companion card with citation chips (AST-1..AST-8, EX-2, EX-3)

One card per subject turn (direction 6.1 common required card). The newest card is expanded; earlier cards collapse into a per-turn list.

| Card field | Display | Source field |
| --- | --- | --- |
| Question assessment | Question type (open, probing, closed, leading, suggestive, compound, forced-choice, opinion) and neutrality issues as text | `question_assessment` |
| Answer category | Responsive, non-responsive, contradiction, explicit uncertainty, possible evasion (AST-8) | `answer_category` |
| Flags | Each: kind (gap or contradiction), citation chip(s), missing fact or the two conflicting statements | `flags[]` |
| Follow-up | One neutral question, its tactic, a "Use this question" button that copies it into the composer (the investigator may edit) | `follow_up` |
| Running finding | Value, ICD 203 phrase, confidence level, "last revised at Tn" | `running_finding` |
| Demeanor callout | When the coach marks the investigator's question as relying on demeanor, the card says so (PRB-4) | `question_assessment.neutrality_issues` contains `demeanor_based` |
| Deeper update (candidate A1 only) | "Updated finding" line with evidence coverage, when `coach.update` arrives | `coach.update` |

Citation chip behavior (AST-7):
- Label `T4`, accessible name "Turn 4: <first 60 characters of the quote>".
- Activation scrolls the transcript to `T4`, moves focus to that turn, and highlights the quoted span.
- The client checks the quote is an exact substring of the cited turn's committed text. If not, the chip renders in an "quote not found in T4" state and is excluded from highlight. The UI never presents an unverifiable citation as verified (X5 section 1, Obra Dinn principle); scoring of unsupported flags remains server-side (EVL-5).
- Partial (interrupted) voice turns are never valid citation targets; a chip pointing at one renders the "not citable: interrupted" state.

Failure states: `coach.failed` shows "Coaching for this turn was not available (timed out)" and counts as a KPI-4 miss server-side; the room continues.

Acceptance:
- FE-COACH-1: EX-1/EX-2 fixture ("Why did you enter?" / "It was a busy shift.") renders answer category "Non-responsive", a gap flag naming the missing fact "purpose of entry" with chip `T1`, and follow-up "What task required entry?".
- FE-COACH-2: EX-3 fixture with finding "insufficient evidence" renders the corroboration to seek ("Verify the work order and timeline").
- FE-COACH-3: a flag whose quote is not a substring of the cited turn renders the "quote not found" state (unit test of `verifyQuote(turnText, quote)` with whitespace normalization only, no fuzzy match).
- FE-COACH-4: chip activation moves focus to the turn element and the turn's quoted span has `data-highlighted="true"`.
- FE-COACH-5: the three findings render with the same component and token family; no finding value maps to a different size, weight or motion (snapshot of computed classes per value).
- FE-COACH-6: a fixture card with `neutrality_issues` containing `demeanor_based` renders the demeanor callout text (PRB-4).

### 4.6 Finding commit (SOL-5, EX-3, BKO-9)
- Dialog with: finding (three options, no default selected), confidence (ICD 203 phrase list from config), rationale with at least one citation (turn or record) for "deceptive" and "truthful", corroboration to seek (required for "insufficient evidence"), the EX-4 statement, Confirm.
- Confirm calls `POST /api/trials/:id/finding` with a work item and the expected transcript version; a stale-version reply (`409`) reloads the transcript and keeps the draft.
- After `trial.finalized`, the room shows the commitment hash (copyable) and "Open debrief".
- FE-FIND-1: Confirm is disabled until required fields for the chosen value are present.
- FE-FIND-2: a `409` keeps the draft and shows "The interview changed; review and confirm again."
- FE-FIND-3: the dialog contains the EX-4 text.

### 4.7 Debrief (EVL-1, EVL-2, EVL-7, EX-4)

Regions:
1. Header: case, mode, date, EX-4 statement.
2. Outcome (development cases): the case's ground truth and resolution summary, provided by a reveal projection that `arena-referee` writes after finalize (`arena-api` cannot read evaluator data, direction 4.1). Hidden-split material never appears (SCN-12).
3. Five rubric cards (EVL-7): clarity and neutrality; response relevance; evidence-based follow-up; testing alternative explanations; supported closure. Each card: score 0-4, the frozen anchor text for that score, 1-3 cited turns as evidence, and a "provisional" marker when that dimension has not met its calibration thresholds (direction 7.2 judge calibration). Total = 5 x sum, 0-100, with scorer provenance ("calibrated proxy vN; human review pending | complete").
4. Three scorecards for this session (EVL-1): learning (the rubric above and evidence coverage, EVL-2), detection (the coach's flags against the referee's independent evasion labels for this session's turns), subject realism (this session's subject fidelity). Numbers come from the server; the client formats only.
5. Annotated transcript: per turn, question type, answer category, flags with chips, the coach's suggested follow-up next to the question actually asked next, released-record markers, the investigator's pins, and demeanor-driven question callouts (PRB-4). In assessment mode this is where coaching first appears.
6. Export: JSON and print view; both carry EX-4.

- FE-DEB-1: before `debrief.ready`, rubric cards show "Scoring" and no number.
- FE-DEB-2: the total displayed equals the server total (no client arithmetic; a fixture with an inconsistent server total still shows the server value and the test asserts the client never sums).
- FE-DEB-3: a dimension flagged provisional shows the marker and its reason.
- FE-DEB-4: assessment-mode debrief shows the coach cards that were withheld during the session.

### 4.8 Progress (KPI-1)
- Score series per session with dimension breakdown; study participants see pre, post, absolute change and relative change, or "relative change undefined (baseline 0)".
- No streaks, no reminders, no loss framing, no "catch" counts (X5 section 4: Duo and Tamagotchi retention mechanics rejected).
- FE-PRG-1: with pre = 0 the relative change cell reads "undefined" and absolute change is shown.
- FE-PRG-2: a text search of the rendered page finds none of: "streak", "don't lose", "caught", "liars".

### 4.9 Arena: tournament matrix and agents at work (CH-4, BKO-1..BKO-7, BKO-10)

- Tournament list: state (draft, frozen, running, sealed, scoring, revealed), split (dev or hidden), seed, roster manifest hash, budget used against the tournament budget (server values).
- Matrix: rows assistants A1-A3, columns subjects S1-S3 (BKO-4). Each cell is one pairing's room in the agents-at-work view (6.5): planned trials, counts by execution state (`completed`, `subject_quarantined`, `assistant_failed`, `infra_failed`, `budget_skipped`, `budget_truncated`), the current trial's progress `turn n/12`, and a caption line.
- Track tabs: Replay track (BKO-6) and Interactive track (BKO-7), shown in the sponsor's order (BKO-2).
- Before reveal on a hidden tournament the matrix is structure-only (section 5.4): counts and progress, no text, no findings, no case identity.
- Trial replay `/arena/:t/trials/:trial`: transcript, coach cards, releases and finalize, played on the 6.5 clock; available for dev tournaments at once and for hidden tournaments only after reveal.
- FE-ARENA-1: given a hidden-tournament pre-reveal fixture, no element in the DOM contains any transcript string from the post-reveal fixture of the same trials (leak test).
- FE-ARENA-2: matrix counts equal the server's counts by execution state for every cell.
- FE-ARENA-3: replay controls (play, pause, scrub, 1x/2x/4x) are keyboard-operable and the scrubber has `aria-valuetext` "n of m events" (TechnoMile `agent-office.tsx` lines 212-218).

### 4.10 Leaderboards (EVL-1, EVL-3..EVL-6, EVL-9..EVL-11, BKO-9, BKO-10, KPI-2, KPI-3, KPI-5)

All numbers are read from `arena.leaderboards` through `arena-api` after reveal; the client computes nothing but formatting. Three separate scorecards (EVL-1): Assistants, Subjects, Investigators.

**Assistant leaderboard, in this order on the page:**
1. Header: tournament, track, "bound to inclusion manifest `<hash>`" (copyable full hash), roster manifest hash, reveal time, EX-4 statement, EVL-10 sentence "A tournament rank is not certification for real investigations.", and a "Corrected leaderboard" label with a link to the original when the manifest is a later one (direction 7.1).
2. Eligibility gate panel per candidate, shown before any rank (EVL-6, KPI-5, PRB-3): FPR point estimate with its interval and the sponsor gate (`<= 5%`, pass or fail); for zero events, the complete-family one-sided bound and its family count as provided by the server (for example "0 of 10 truthful families; one-sided 95% upper bound 25.9%"); isolation gate pass or fail with a link to `/trust/isolation`; "insufficient" when the candidate has no included truthful trials.
3. Ranked eligible candidates: rank interval (best to worst from the bootstrap, X5 LMArena rank-spread pattern), deceptive-role recall with interval, questioning quality with interval, provisional marker with the server's reason (attrition sensitivity, own deceptive coverage below 90%).
4. Ineligible candidates listed below, unranked, each with the failing gate stated.
5. Detail per candidate: PPV, the 2x3 count matrix with raw counts, unresolved rate by role (EVL-9), evasion-event precision and recall ("undefined" for zero denominators), unsupported-flag rate, cost per trial, p95 coaching latency with interval (KPI-4), coverage and attrition per role, exclusions by execution state.
6. Role prevalence in the included set (BKO-10).

**Subject leaderboard (EVL-4, EVL-11, KPI-3):** all-turn fidelity (primary) with interval, valid-session fidelity (secondary), invalid-session rate, deceptive success split into misleading clearance and unresolved, truthful consistency and appropriate uncertainty, correct recognition as an interaction outcome; the shared-checkpoint disclosure (referee labels on the same model as S1, direction 7.2).

**Investigator scorecard (EVL-2, EVL-7, KPI-1):** participant-level relative and absolute change with intervals, n, and the note that it is "a demonstration of the instrument, not a causal claim" (direction 7.2).

**Exhibition section:** OWNER DECISION PENDING (A2A exhibition track, direction DM-2). Rendered only when `config.exhibition_enabled = true`, under its own heading with the label "exhibition: model, prompt and budget unverified", never merged with the official table.

Acceptance:
- FE-LB-1: a fixture where candidate X has FPR 6% and the highest recall renders X in the ineligible list, unranked, with "FPR gate failed".
- FE-LB-2: every metric cell with an interval renders both bounds; a fixture missing an interval renders "interval unavailable", never a bare point.
- FE-LB-3: the manifest hash shown equals the leaderboard record's `inclusion_manifest_hash`.
- FE-LB-4: the EVL-10 sentence and EX-4 are present (text assertion).
- FE-LB-5: before reveal the route shows "Results are sealed until reveal" and no numbers.

### 4.11 Trust center (EVL-12, EX-4, SCN-5, BKO-9, P2, P3, P8)

| Section | Content | Source |
| --- | --- | --- |
| Isolation | The capability matrix (direction 4.3) rendered from the same JSON fixture the tests use (bundled at build), plus the latest gate run per check: pgTAP privilege tests, route tests including direct calls to IAM-private services, assistant-context type test, hidden-split seal, commitment verification, canary audit hits; run time and commit SHA | `arena.isolation_checks` |
| Commitments | For a revealed tournament: per trial, commitment hash, transcript and evidence hashes, and after reveal the nonce; a "Verify in browser" button recomputes the commitment with WebCrypto SHA-256 using the ledger spec's construction and shows match or mismatch | ledger projections |
| Fairness audit | FPR and flag rates by communication style with intervals, unsupported style-based flags per assistant, the permutation test result, and the demeanor-driven negative-control fixtures with their detection result (PRB-4, SCN-3) | server |
| Methodology | Every metric's estimand, unit and interval method (direction 7.2), attrition rules, the zero-event bound explanation, judge calibration results, the NIST AI RMF MEASURE mapping, and the EVL-12 statement that NIST has not validated these thresholds | static content plus server values |
| Budget | D-009 cap and target, spend to date by bucket from the reservation ledger, plan size (20 or 26 cases) | `ops.*` projection |
| Observability | Link to Phoenix when hosted. OWNER DECISION PENDING (DM-5): if Phoenix stays local, the section shows a dated static p95 latency panel image and says so | config |

- FE-TRUST-1: commitment verification test: a fixture with known inputs shows "match"; one altered byte shows "mismatch".
- FE-TRUST-2: the methodology page contains the EVL-12 non-validation statement and EX-4.
- FE-TRUST-3: the capability-matrix table renders every row of the fixture file (count equality).

### 4.12 Trainer console, blinded review (BKO-3, EVL-7, KPI-1)
- Item list: opaque item IDs only, shuffled server-side.
- Review screen: transcript with speaker labels "Investigator" and "Subject"; removed: participant identity, pre/post label, session dates and times, case-set label, coach output, mode badge, and any other item's score. Five dimension inputs (0-4, radio groups) each showing the frozen anchors; optional note; Submit once.
- FE-REV-1: the review payload schema contains none of `participant`, `user`, `pre`, `post`, `date`, `created_at`, `mode`, `coach`; the client schema rejects them (contract test).
- FE-REV-2: the screen renders no timestamps (text and attribute scan).
- FE-REV-3: Submit requires all five dimensions; a second submit for the same item is rejected by the server and shown as "already submitted".

### 4.13 Admin console (served from `arena-referee`)

The capability matrix routes admin operations through `arena-referee` with an IAM identity (direction 4.3). The same static bundle is served by `arena-referee`; an admin opens it locally with `gcloud run services proxy arena-referee --project <arena project>` and the app, being origin-relative, talks to the referee's `/api/admin/*`. `arena-api` serves no admin routes and its build shows no admin entry point (`/api/me` never returns `admin` on the `arena-api` origin).

- Screens: tournament lifecycle with allowed transitions; budget ledger (reservations, settled spend, buckets, cap); kill switch with a typed confirmation; subject validity review queue (blinded: candidate IDs hidden) recording `valid` or `subject_invalid` with reason; reveal page listing each precondition (roster frozen, one execution record per planned trial, every subject review resolved, replay corpus sealed, commitments verified) as computed by the server, with Reveal enabled only when all pass; inclusion manifest view.
- No infra controls (workers, instances, timeouts, health checks) appear in any UI (global owner-approval gate).
- FE-ADM-1: on the `arena-api` origin, `/admin` renders "Not available here" and the bundle makes no `/api/admin/*` request.
- FE-ADM-2: Reveal is disabled while any precondition is false (fixture).

---

## 5. Live event contract

### 5.1 Transport

- **Server-sent events**, one stream per trial (`/api/trials/:trialId/events`) and one per tournament (`/api/tournaments/:tournamentId/events`). Client: TechnoMile `web/src/lib/sse/ticketed-stream.ts` (lines 1-206), lifted. Each connection mints a single-use ticket by `fetch` (`POST /api/streams/ticket` with the scope), then opens `EventSource(url?ticket=..&after=<lastSeq>)`. The server replays `seq > after` and continues live (TechnoMile `frames.ts` lines 15-31: `id: <seq>` per frame, `: ping` comments every 15 s, resume from `?after=` or `Last-Event-ID`, larger wins).
- **Backoff for the trial stream** is changed from the donor's `2 s x attempt` (`ticketed-stream.ts` line 69) to `[250, 1000, 2000, 4000, 8000]` ms, because a 2 s first retry alone would break the 3 s KPI-4 budget on any reconnect (I7 implications). The tournament stream keeps the donor default.
- **Catch-up check:** every `POST` that produces events returns `{last_seq}`; if the stream's last accepted seq is below it 1 s later, the client reconnects with `after=<lastSeq>`.
- **Cost rule (D-003, D-009):** an open SSE request keeps an `arena-api` instance billed for its whole duration (Cloud Run bills an instance with an open streaming request as active; GDK `run/docs/triggering/websockets`, 2026-10-08). The client therefore: opens a trial stream only while the trial is `running` or awaiting finalize; calls `finish()` on terminal status; closes any stream after 60 s with the tab hidden (`visibilitychange`) and resumes with `after=` when visible; opens a tournament stream only while the tournament is `running` and the arena tab is visible, otherwise reads the stored events once (finished tournaments are replayed from a `GET`, not a stream). Server-side stream lifetime is bounded by the Cloud Run request timeout; the client reconnects transparently.
- **Voice** uses its own WebSocket (section 6.2); its transcript turns also enter the trial event log, so the trial stream is the single source for transcript and coaching.

### 5.2 Envelope

One JSON Schema file, exported from the backend's pydantic models into the repo (`contracts/events.schema.json`), is the single source of truth. The frontend generates TypeScript types from it and validates every frame at runtime with a compiled `ajv` validator. Frames failing validation, or with unknown `type`, are dropped and counted, never rendered (gokbase `voiceMachine.ts` lines 125-163: unknown frames are ignored as defense in depth). Deltas carry absolute values so re-applying an event is idempotent (TechnoMile `lib/contracts/run-events.ts` lines 1-10). Maximum 16 KB per event (same source, `MAX_EVENT_BYTES`).

```json
{
  "v": 1,
  "seq": 42,
  "scope": "trial",
  "scope_id": "trl_...",
  "type": "coach.card",
  "ts": "2026-10-20T15:04:05.123Z",
  "work_item": "wi_...",
  "transcript_version": 7,
  "data": {}
}
```

### 5.3 Event types

Trial scope:

| Type | `data` | Emitted when |
| --- | --- | --- |
| `snapshot` | `{status, mode, channel, split, exchanges_used, exchanges_cap, turns[], released[], requestable[], cards[], finding?, last_seq}` (absolute state, projected) | First frame of every connection |
| `trial.status` | `{status, exchanges_used, exchanges_cap, reason_code?}`; `status` in `running, finalizing, completed, subject_quarantined, assistant_failed, infra_failed, budget_skipped, budget_truncated` | Any change |
| `question.accepted` | `{turn_index, text, source: investigator \| harness, presented_record_ids[]}` | Question committed |
| `subject.thinking` | `{turn_index}` | Subject work item started |
| `subject.answer` | `{turn_id, turn_index, text, channel: text \| voice, partial, committed_at}` | `record_subject_turn()` committed |
| `evidence.released` | `{record_id, title, kind, body, released_at_turn, trigger: scheduled \| requested}` | `release_evidence()` committed |
| `coach.working` | `{turn_index}` | Coach call started |
| `coach.card` | `{turn_id, card: {question_assessment: {type, neutrality_issues[]}, answer_category, flags: [{flag_id, kind: gap \| contradiction, citations: [{turn_id, quote}], missing_fact?}], follow_up: {text, tactic}, running_finding: {value, icd203_phrase, confidence, last_revised_turn}}, timing: {answer_committed_at, card_validated_at}}` | Card validated |
| `coach.update` | `{turn_id, running_finding, evidence_coverage}` | Candidate A1 deeper update |
| `coach.failed` | `{turn_id, reason: timeout \| invalid}` | Card missed |
| `finding.committed` | `{by: investigator \| assistant, value, confidence, committed_at}` | Finding submitted |
| `trial.finalized` | `{commitment_hash}` | `finalize_trial()` committed |
| `debrief.ready` | `{session_id}` | Referee scoring written |
| `notice` | `{kind: paused \| quota \| ending_soon, text}` | Kill switch, quota, voice time warning |

Tournament scope adds: `tournament.status {state}`, `block.started {block_index, pairings[]}`, `trial.started {trial_ref, pairing, track}`, `harness.question {trial_ref, turn_index, text?}`, `subject.answer {trial_ref, turn_index, latency_ms, text?}`, `coach.card {trial_ref, turn_index, latency_ms, flag_count?, card?}`, `evidence.released {trial_ref, turn_index, record?}`, `trial.finalized {trial_ref, commitment_hash}`, `trial.execution {trial_ref, state}`, `referee.labeled {trial_ref}`, `budget.reserved {bucket, amount_usd}`, `budget.skipped {block_index}`. `latency_ms` is the recorded model-call duration that drives motion (6.5). `trial_ref` is an opaque per-tournament ordinal, not a case ID.

### 5.4 Projections: what each mode withholds

The server applies the projection; the client re-checks as defense in depth and reports violations to `POST /api/telemetry/contract-violation` (which writes a log line; it never alters state).

| Field or event | Practice | Assessment | Hidden tournament before reveal | Revealed or dev tournament | Trainer review |
| --- | --- | --- | --- | --- | --- |
| Role label, tag proposals, guard results, referee labels, private packet, release predicates, evaluator packet, nonces before reveal | never | never | never | never (labels appear only as leaderboard aggregates) | never |
| Subject and coach candidate IDs | withheld | withheld | shown (roster is frozen and public) | shown | withheld |
| Communication style, family ID | withheld | withheld | withheld | shown in fairness audit only | withheld |
| `coach.working`, `coach.card`, `coach.update`, `coach.failed` | sent | **withheld until the session ends**, then in debrief only | structure only: `latency_ms`, no `card`, no `flag_count` | full | withheld |
| `running_finding`, `finding.committed.value` | sent | investigator's own only | withheld | full | withheld |
| Question and answer `text`, `evidence.released.record` | sent | sent | withheld | full | sent, without dates |
| `ts`, dates | sent | sent | sent | sent | withheld |
| `trial.execution` states, counts | n/a | n/a | sent | sent | n/a |

Acceptance:
- FE-SSE-1: `ticketed-stream` lift passes its 13 donor tests (`ticketed-stream.test.ts`) plus: first retry at 250 ms on the trial stream; `after=` carries the last accepted seq; a rejected (invalid) frame does not advance the cursor.
- FE-SSE-2: the trial reducer is order-independent and duplicate-safe: property test over random permutations and duplications of a fixture log yields the same state.
- FE-SSE-3: in assessment mode, a fixture stream containing a `coach.card` causes no render and one contract-violation report.
- FE-SSE-4: hidden pre-reveal fixture: the tournament reducer state contains no `text`, `card` or `record` keys after folding.
- FE-SSE-5: the stream closes within 61 s of the tab becoming hidden and reconnects with `after=<lastSeq>` on visibility; it closes on terminal status (`finish()`), with no reconnect.
- FE-SSE-6: a frame over 16 KB or failing schema validation is dropped and counted.

### 5.5 REST calls the frontend makes (owned by the API spec; listed for alignment)

`GET /api/me`, `POST /api/me/ack-ex4`, `GET /api/config`, `GET /api/cases`, `GET /api/cases/:id`, `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/trials/:id/questions {text, presented_record_ids, work_item, expected_version}`, `POST /api/trials/:id/evidence-requests {record_id, work_item}`, `POST /api/trials/:id/finding {...}`, `POST /api/trials/:id/latency {...}`, `GET /api/sessions/:id/debrief`, `GET /api/progress`, `GET /api/tournaments`, `GET /api/tournaments/:id`, `GET /api/tournaments/:id/events?after=` (non-stream read), `GET /api/leaderboards/:tournamentId`, `GET /api/trust/*`, `GET /api/review/items`, `POST /api/review/items/:id`, `POST /api/streams/ticket`, `POST /api/voice/ticket`. Work item IDs come from the server (`POST /api/trials/:id/work-items`) or the question response; the client never invents turn numbers (direction 4.2).

### 5.6 KPI-4 client measurement

KPI-4 is "time from the subject's answer being committed to the complete card validated and received by the client" (direction 7.2). Client and server clocks differ, so the client measures only same-clock intervals and reports them:

- `t_answer_recv`, `t_card_recv`: `performance.now()` when the `subject.answer` and `coach.card` frames for the same `turn_id` pass validation.
- `rtt_ms`: the minimum round trip of `GET /api/ping` measured at stream open and every 60 s.
- Client posts `{turn_id, card_minus_answer_ms: t_card_recv - t_answer_recv, rtt_ms}` to `POST /api/trials/:id/latency`.
- Proposed server formula (owned by the metrics spec): `KPI-4 sample = (answer_emitted_at - answer_committed_at) + card_minus_answer_ms + rtt_ms / 2`. Every term is a same-clock difference except the one-way transit estimate. A card that never arrives within 10 s, or `coach.failed`, is a miss.
- FE-KPI4-1: unit test of the latency recorder with a fake clock: answer at 1000 ms, card at 3400 ms, RTT 80 ms posts `card_minus_answer_ms = 2400, rtt_ms = 80`.
- FE-KPI4-2: the card renders within 100 ms of frame receipt at the 95th percentile in the Playwright fixture run (performance marks around the reducer dispatch and the card's commit effect).

---

## 6. State machines

All machines are pure TypeScript modules (no React, no I/O), unit-tested as tables, in the style of gokbase `voiceMachine.ts` (lines 1-18: "the PURE core") and `kin/fsm.ts` (lines 1-21).

### 6.1 Trial lifecycle reducer (room)

`trialReducer(state, envelope) -> state`: monotonic on `seq`, duplicate-safe with a seen-set, events sorted by `seq` before folding (TechnoMile `lib/war-room/office.ts` lines 76-111, `foldOffice`). Derived UI status:

| Derived status | Entered on | Composer | Subject avatar | Companion |
| --- | --- | --- | --- | --- |
| `connecting` | stream opening, no snapshot yet | disabled | `present` | `attentive` |
| `awaiting_question` | snapshot `running` with no open question; `subject.answer` | enabled | `listening` | `attentive` |
| `subject_answering` | `question.accepted`, `subject.thinking` | disabled | `thinking` | `attentive` |
| `coach_working` (practice) | `coach.working` | enabled after the answer | `listening` | `think` |
| `cap_reached` | `exchanges_used = 12` | disabled; commit required | `listening` | `attentive` |
| `finalizing` | finding submitted | disabled | `present` | `attentive` |
| `ended` | any terminal `trial.status` | disabled | `away` | `farewell` then `sleep` |
| `reconnecting` | stream retry scheduled | unchanged | unchanged | `error` |

### 6.2 Voice machine (lifted from gokbase `voiceMachine.ts`, lines 1-234)

Kept verbatim: the pure reducer shape, the terminal `ended` absorbing state (line 193), `frameToEvent` whitelist with unknown frames ignored (lines 125-163), the terminal-versus-transient close-code split (lines 73-110), transcript fragment merging by role (lines 165-182), and the no-cost-on-the-wire rule (lines 112-114: the frame union has no cost variant).

Arena changes:

| Change | Reason |
| --- | --- |
| States: `idle, consent, connecting, listening, speaking, thinking, reconnecting, ended`; `tool-lookup` renamed `thinking` (subject preparing an answer) | Arena vocabulary; consent gate before mic (gokbase disclosure-before-mic pattern) |
| Add `mode: 'live' \| 'push_to_talk'`; under push-to-talk `listening` becomes `recording` while the talk control is held | OWNER DECISION PENDING voice branch (3.3) |
| Add frame `turn_committed {turn_id, role, text, partial}`; the transcript shown is committed turns plus at most one live caption line | Text is the scored artifact (SOL-1); live fragments are captions only (I6 section 4: one answer arrives as many fragments) |
| Add frame `exchange_count {used, cap}` | 12-exchange cap (BKO-8) |
| Close codes: keep `1000` normal, `4408` idle, `4413` cost cap, `4401` ticket, `4403` origin, `4404` not found, `4503` resume failed; add `4410` exchange cap reached (terminal), `4429` budget reservation refused at open (terminal), `4423` paused by kill switch (terminal). Any other code is transient and drives resume with `["voice-resume", token]`, backoff 500/1000/2000 ms, 3 attempts (gokbase `useVoiceSession.ts` lines 17, 37-38, 278-300) | Arena spend guard (direction 8.3) and cap; codes must match the voice spec |
| Add client control `playback_ack {utterance_id, played_samples}` every 250 ms while speaking and on barge-in | Playback-grounded transcripts (direction 9, F10). The gokbase playback worklet does not report played samples (`public/worklets/playback-processor.js` lines 21-77); the arena worklet posts `{type:'played', samples}` from `process()` every 250 ms of output and `{type:'cleared', dropped}` on `clear` |
| Timer and `ending_soon` warning kept (lines 214-224); the room shows "Voice ends in 60 s; you can continue in text" | WCAG 2.2.1 (time limit with warning and an untimed alternative) |

Audio layer lifted from gokbase `audioController.ts` (lines 1-338): two contexts (16 kHz capture, 24 kHz playback), same-origin worklets, Chrome auto-suspend guard (lines 18-21), barge-in flush (lines 234-240), RMS taps (`sampleLevels`, lines 243-270) feeding the subject avatar's talk value.

Acceptance:
- FE-VOICE-1: reducer table test covers every (state, event) pair; `ended` absorbs every later event.
- FE-VOICE-2: close-code table: every terminal code maps to its ended copy key; `1006` and `1011` are transient.
- FE-VOICE-3: fragments for one subject utterance merge into one caption line; only `turn_committed` adds a transcript turn.
- FE-VOICE-4: worklet test (AudioWorklet processor run in Node with a stub `AudioWorkletProcessor`): after 24,000 output samples it has posted `played` totals summing to 24,000; `clear` posts `cleared` with the dropped count.
- FE-VOICE-5: the voice channel control is absent when `split != 'dev'` or `voice_available = false`.

### 6.3 Companion pet (lifted from gokbase `kin/fsm.ts`, lines 25-122)

Kept: pure `petStateFor(input)`, the precedence ladder (dragging > point > one-shot windows > status table, lines 77-121), `SLEEP_AFTER_MS = 45000`, `ONE_SHOT_MS = 1600` (lines 42-47), reduced-motion and mobile collapse of bursts to still poses (lines 84, 95-100, 119), the lazy per-character registry (`kin/registry.ts` lines 108-137), and per-frame CSS variables outside React (`KinLayer.tsx` lines 657-670). Dropped for this product: roaming, cursor lean and drag (`KinLayer.tsx` cursor and drag machinery; I7 lift map: fixed placement in the coach region instead), and the `talk-sync` pose (the companion does not speak).

Arena input: `status: CompanionStatus` derived from 6.1 and 6.2, `pointSignal` (counter bumped on a `coach.card` with at least one flag), `reducedMotion`, `isMobile`, `idleMs`, `greeted`, `celebrating`, `farewelling`.

| CompanionStatus | Pose | Meaning |
| --- | --- | --- |
| `idle` | `idle`, `sleep` after 45 s | No activity |
| `connecting`, `awaiting_question`, `subject_answering`, `cap_reached`, `finalizing` | `attentive` | Following the interview |
| `coach_working` (practice only) | `think` | Coach is reading the latest turn |
| `pointSignal` bump (practice only) | `point` toward the newest flag's chip, one-shot 1600 ms | A cited flag is ready (the gesture gokbase left dormant, `fsm.ts` line 36) |
| session opened | `celebrate` one-shot, still `attentive` under reduced motion | Session ready (gokbase meaning, lines 38-39) |
| `ended` | `farewell` one-shot then `sleep` | Session over |
| `reconnecting` | `error` | Transport only |

Rules (PRB-4, AST-10, X5 section 4): no pose depends on the finding value, the investigator's question score, flag count beyond "at least one", or any accusation; no sad, disappointed or impatient pose; `error` is used only for transport faults; no notifications, streaks or idle reminders. In assessment mode the companion receives no coach-derived input.

Acceptance:
- FE-PET-1: `petStateFor` table test over every status and flag combination; under `reducedMotion` or `isMobile` no burst pose is returned.
- FE-PET-2: type test: `CompanionInput` has no field typed from finding value, question score or role (compile-time `@ts-expect-error` fixtures).
- FE-PET-3: assessment fixture: the companion pose sequence equals the one produced with all `coach.*` events removed.
- FE-PET-4: the companion root is `aria-hidden="true"`, not focusable, and `pointer-events: none` except where it is a control (gokbase `KinLayer.tsx` line 741 and the pointer-events contract).
- FE-PET-5: bundle gate (lifted `scripts/check_pet_bundle.mjs`): character art reachable only through dynamic imports; active-set gzip ceiling pinned at the first green measured value (section 10).

### 6.4 Subject avatar (PRB-4, SCN-3, SCN-11)

Assignment: the public packet carries `presentation {persona_id, display_name, voice_id, baseline_demeanor}` assigned **per case family**, so both matched variants of a family share one persona, one voice and one baseline demeanor. Role cannot correlate with presentation inside a family by construction. Portraits are one neutral still per persona (generated within the demo allocation, direction 8.2); no per-turn expression variants.

States: `present`, `listening`, `thinking`, `speaking`, `away`.

| Input (complete list) | Source |
| --- | --- |
| Derived trial status | 6.1 |
| Voice status | 6.2 |
| `--arena-talk` level 0-1 from the playback RMS tap, set per frame on the DOM node | gokbase `audioController.ts` `sampleLevels`, `KinLayer.tsx` line 670 technique |
| `presentation` | public packet |
| `reducedMotion` | media query |

Forbidden inputs (type-enforced): answer category, flags, running finding, committed finding, tag proposals, guard results, role, communication style, quarantine reason. The avatar's appearance never changes in response to what the subject said.

Live Avatar talking heads (direction TL;DR 7, stretch): if enabled, a video element replaces the still; the same inputs apply, and a matched-content fixture (same text, different personas and voices) must show no systematic difference in the visible state sequence before it ships.

Acceptance:
- FE-AV-1: type test: `SubjectAvatarInput` rejects each forbidden field (`@ts-expect-error` fixtures).
- FE-AV-2: two fixture sessions with identical lifecycle timing but opposite `answer_category` sequences produce identical avatar state sequences.
- FE-AV-3: contract test on the case fixtures: for every family, both variants' `presentation` objects are equal.
- FE-AV-4: under reduced motion `--arena-talk` stays 0 and the speaking state is shown by a static marker and the status word.

### 6.5 Agents at work (lifted from TechnoMile `lib/war-room/office.ts` and `components/war-room/agent-office.tsx`)

Kept: the doctrine that every movement is one recorded event (`office.ts` lines 1-15; `motion.md` lines 43-45); fold, plan, schedule, frame as pure functions (`foldOffice` lines 76-111, `buildSchedule` lines 449-575, `frameAt` lines 661-729); the live clock 3.5 s behind the ledger with measured skew (`liveClock` lines 376-388, `noteArrival` lines 749-756); history before the snapshot seq never animates (`motion.md` line 56); replay at 8x with quiet stretches capped at 6 s (`replayClock` lines 334-374); model-call motion bound to the recorded latency window, capped at 1.6 s live (`LIVE_TYPING_MS`, line 377; `motion.md` line 49); store updates batched at about 10 Hz (`motion.md` line 41; `agent-office.tsx` `TICK_MS = 100`, line 48); a caption line saying in words what is happening (`agent-office.tsx` `Caption`, lines 844-859).

Arena floor: the 3x3 matrix of pairing rooms (4.9) plus three shared stations.

| Role (`Role` enum) | Station | Beat | Event |
| --- | --- | --- | --- |
| `interviewer` (harness) | each room | asks: bubble with the first words (or "Q5" before reveal) | `harness.question` |
| `subject` | each room | writing during `[ts - latency_ms, ts]`, then bubble | `subject.answer` |
| `coach` | each room | writing during its latency window; flag-count badge after reveal | `coach.card` |
| `clerk` | evidence locker | walks to the room with a record | `evidence.released` |
| `clerk` | ledger desk | stamps the commitment | `trial.finalized` |
| `referee` | referee desk | stamps a label sheet (no content) | `referee.labeled` |
| room marker | each room | state word appears (`budget_skipped` etc.) | `trial.execution`, `budget.skipped` |

The interrogation room reuses the same rule at small scale: the companion's `think` pose and the coach activity line ("Coach is reading T5") exist only between `coach.working` and `coach.card`.

Reduced motion (`motion.md` lines 58-62): no walking or loops; figures appear at their stations; the caption carries the state in words. The reduced-motion rendering is also the cut-order fallback (direction 3.3 cuts the animation first): cutting animation means shipping this rendering.

Acceptance:
- FE-AW-1: `foldArena` is order-independent and duplicate-safe (property test, as `office.test.ts`).
- FE-AW-2: with a fixture whose `coach.card` has `latency_ms = 900`, the coach is in `typing` exactly during the mapped window on the replay clock (frame test at sample times).
- FE-AW-3: events at or before the snapshot seq produce no beats.
- FE-AW-4: reduced motion: zero running animations longer than 1 ms or looping on the page during a fixture replay (Playwright `document.getAnimations()`), matching TechnoMile's verification (`motion.md` lines 66, 74).
- FE-AW-5: the caption is present in every state and changes when the frame's activities change.

---

## 7. PRB-4 UI rules (enforced, not advisory)

| Rule | Enforcement |
| --- | --- |
| No stress, nervousness, voice-tone, pace or biometric meter anywhere; no acoustic feature is shown or sent to the coach (direction 9, N03) | Lint: forbidden identifiers (`stress`, `nervous`, `arousal`, `pitch`, `tremor`, `heartRate`, `eyeContact`) fail the build in `src/`; e2e text scan of every route |
| Subject avatar persona, voice and baseline demeanor assigned per family, independent of role; no per-turn expression | 6.4 types and FE-AV-1..3 |
| Avatar and companion never react to answer categories, flags or findings in a way tied to the subject's role or content | FE-AV-2, FE-PET-2/3 |
| Confidence shown as the ICD 203 phrase and the coach's confidence level, both evidence-based; never as a gauge, needle or color ramp that reads as a lie detector | Component review checklist; snapshot test of the running-finding component (text only plus a static token) |
| The three findings carry equal visual weight; "deceptive" gets no alarm treatment, sound or motion | FE-COACH-5 |
| Every flag shows its citation; a flag without a verifiable quote is visibly marked | FE-COACH-3 |
| Communication style is never shown before or during an interview | FE-LIB-1; style appears only in the fairness audit |
| The coach's demeanor callout is shown when the investigator's question relies on demeanor | FE-COACH-6 |
| No accusation streaks, "catch" counts or rewards for "deceptive" findings | FE-PRG-2, FE-PET-2 |

---

## 8. EX-4 and EVL-12 placements

`EX4_TEXT` (sponsor wording, REQUIREMENTS EX-4): "All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person."

| Placement | Form |
| --- | --- |
| Onboarding | Full text; acknowledgement required (FE-ONB-1) |
| Case brief | Full text above the start control |
| Interrogation room | Persistent single line in the case header, expandable |
| Finding commit dialog | Full text (FE-FIND-3) |
| Debrief | Header (full text) and in exports |
| Leaderboards | Header, with the EVL-10 "not certification" sentence |
| Arena | Header line |
| Trust center and methodology | Full text; EVL-12 NIST non-validation statement on every methodology page |
| JSON and print exports | Included as a field and in the printed header |

- FE-EX4-1: Playwright visits every route in 2.2 (with fixtures) and asserts `EX4_TEXT` is present in the accessible text (presence test named in S7 section 1).
- FE-EX4-2: every `/trust/methodology*` page contains the EVL-12 statement.

---

## 9. Accessibility (WCAG 2.2 AA)

| Criterion | How |
| --- | --- |
| 1.1.1 Non-text content | Portraits `alt` = persona display name; decorative companion and office figures `aria-hidden`; the office SVG has `role="group"` with a summary label (TechnoMile `agent-office.tsx` line 231) |
| 1.3.1 Info and relationships | Transcript is a list of turns with headings `T1..Tn`; flags reference turns by `aria-describedby` |
| 1.4.1 Use of color | Flag kind, finding, gate status and execution state each carry a text label and an icon slot, never color alone |
| 1.4.3, 1.4.11 Contrast | Token pairs from DESIGN.md must meet 4.5:1 text and 3:1 UI; axe checks every route in light and dark |
| 1.4.10 Reflow, 1.4.4 Resize | Works at 320 CSS px and 200% zoom; room collapses to tabs |
| 2.1.1 Keyboard | Every action, including present-evidence, chip navigation, replay controls and voice start/stop, is keyboard-operable |
| 2.2.1 Timing adjustable | Voice session limit announced with 60 s warning; text mode has no time limit and is always available |
| 2.3.3 Animation from interactions, 2.2.2 Pause | `prefers-reduced-motion` honored everywhere; replays have pause |
| 2.4.3 Focus order, 2.4.7 Focus visible | Citation activation moves focus to the turn; focus ring token required |
| 2.4.11 Focus not obscured (minimum) | Pinned composer and EX-4 header never cover the focused element (`scroll-padding` set from their heights) |
| 2.5.7 Dragging movements | No drag-only interaction (companion drag removed; evidence presented by button) |
| 2.5.8 Target size (minimum) | Interactive targets at least 24 x 24 CSS px, including citation chips |
| 3.2.6 Consistent help | Methodology and "How coaching works" links in the same place on every screen |
| 3.3.7 Redundant entry | Finding draft survives a `409` and a reconnect |
| 3.3.8 Accessible authentication | Google sign-in through IAP; no app passwords or puzzles |
| 4.1.3 Status messages | One polite live region for coach-card arrival ("Coach: 1 flag on T4, follow-up suggested"), evidence releases and status changes; transcript `role="log"`; captions batched at clause boundaries or 400 ms (gokbase `Transcript.tsx` lines 310-325) |

Acceptance:
- FE-A11Y-1: `@axe-core/playwright` reports zero violations at WCAG 2.2 A and AA tags on every route, in light and dark themes, with fixture data.
- FE-A11Y-2: a keyboard-only Playwright run completes flow 3.1 (ask, request record, present record, follow a chip, commit, open debrief) without a pointer.
- FE-A11Y-3: at 320 px viewport width no horizontal scroll on any route.
- FE-A11Y-4: the polite live region announces each coach card once (count of mutations equals cards received).

---

## 10. Performance budgets

| Budget | Target | Method |
| --- | --- | --- |
| Frame pacing, room streaming and arena 4x replay | p95 frame time at most 16.8 ms and 0 frames over 50 ms over 8 s on the demo laptop, matching TechnoMile's measured result (481 frames in 8 s, p50 16.7 ms, p95 16.8 ms, 0 over 50 ms; office 4x replay 477 frames; `motion.md` lines 64-75) | Release verification, recorded in `docs/design/motion.md` with the build and date, using a `requestAnimationFrame` sampler injected by Playwright during a fixture replay. Not a CI gate: headless CI frame timing does not represent a display (stated, not softened) |
| Animated properties | `transform` and `opacity` only | CI: stylelint rule rejecting `transition`/`animation` on any other property, and a test scanning `document.getAnimations()` keyframes during a fixture replay |
| Layout shift | CLS 0.00 on the room and arena while streaming (TechnoMile measured 0.0000) | Playwright `PerformanceObserver('layout-shift')`; skeletons reserve final size |
| Reduced motion | 0 looping or longer-than-1 ms animations | FE-AW-4 (CI) |
| Card render | p95 at most 100 ms from frame receipt to card committed (part of the 3 s KPI-4 budget) | FE-KPI4-2 (CI, fixture) |
| Interaction | INP at most 200 ms for Send, Request, chip activation | Playwright Event Timing |
| JavaScript | Entry chunk (shell, library route, router, React) and each lazy chunk under gzip ceilings pinned at the first green slice build's measured size plus 10%; voice and character art are separate lazy chunks | CI: lifted `check_pet_bundle.mjs` (three checks: lazy-only, ceiling, presence; lines 6-30). A ceiling is raised only by a recorded owner decision with the measured number, never to make a failing build pass (same file, lines 29-40) |
| Main-thread work per frame | One shared rAF loop for all per-frame work (gokbase `raf.ts` lines 1-96), paused when the tab is hidden | Unit test of subscriber count; manual check |
| Cold start | Shell visible within 1 s after `index.html`; data regions show skeletons during a Cloud Run cold start | Playwright with artificial API delay |

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
| Motion | `--arena-duration-instant`, `-fast`, `-base`, `-slow`, `-data`, `--arena-stagger-step`, `--arena-ease-out-quart`, `--arena-ease-out-expo`, `--arena-ease-in-out-quart` (names from TechnoMile `motion.md` lines 9-19; TechnoMile's values are placeholders until DESIGN.md) |
| Per-frame variables | `--arena-talk` (0-1, subject speaking level), `--arena-pet-talk` reserved |
| Typography and space | `--arena-font-sans`, `--arena-font-mono`, `--arena-font-display`, `--arena-space-*`, `--arena-radius-*` |

State hooks for styling: `data-state` (room status), `data-pose` (companion), `data-avatar-state`, `data-activity` (office figures, TechnoMile `office-avatars.tsx` contract), `data-finding`, `data-flag-kind`, `data-gate` (`pass`, `fail`, `insufficient`), `data-provisional`, `data-highlighted`. Themes: light and dark token sets under `:root` and `[data-theme="dark"]`, plus `prefers-color-scheme`.

**OWNER DECISION PENDING (DESIGN.md):** all values; character and portrait art style; companion character set; icon set; fonts. Until it lands, development uses a neutral placeholder theme that is not shipped.

- FE-TOK-1: a lint fails on raw color literals, raw durations or raw font stacks in `src/` outside `src/styles/tokens.css`.

---

## 12. Testing

| Layer | Tool | Scope |
| --- | --- | --- |
| Pure modules | Vitest 5, coverage gate 90% lines and branches on `src/lib/**` (TechnoMile gate level, direction P9) | Reducers (6.1), voice machine (6.2), companion FSM (6.3), avatar FSM (6.4), arena fold, schedule and frame (6.5), SSE client, quote verifier, latency recorder, projections re-check |
| Components | Vitest + Testing Library (jsdom) | Coach card, citation chips, evidence board, finding dialog, debrief cards, leaderboard gate panel, review form |
| Contract | ajv against `contracts/events.schema.json` and the REST schemas | Every fixture event validates; negative fixtures (forbidden fields such as `role`, `style`, `tag`) fail validation |
| End to end | Playwright 1.63 against a local `arena-api` running with the deterministic fake agent port and a seeded local Supabase (the backend's test mode); fixture streams for arena and leaderboards | Flows 3.1-3.7, leak tests, EX-4 presence, axe, keyboard-only, reduced motion, CLS |
| Visual and motion verification | Playwright traces and recordings | Release verification (section 10), stored under `docs/design/` |

Fixtures: one canonical facility-access dev case (slide 8 case, EX-1..EX-3), a full practice session log, an assessment session log, a voice session log with an interrupted utterance, a hidden-tournament pre-reveal and post-reveal pair, a leaderboard with one ineligible candidate and one zero-event FPR, and a commitment with known inputs.

End-to-end acceptance list (all CI unless marked):
- E2E-1 Practice text session, 3 exchanges, one request, one present, commit "insufficient evidence", debrief shows five cards (FE-ROOM, FE-COACH, FE-DEB).
- E2E-2 Assessment session shows no coaching in the room and shows it in the debrief.
- E2E-3 Stream drop mid-session (server closes the connection): the room reconnects with `after=` and no turn is duplicated or lost.
- E2E-4 Voice session against the voice relay's fake Live backend: consent, connect, two committed turns, barge-in flush, `4410` at cap.
- E2E-5 Hidden pre-reveal arena: no transcript text in the DOM (FE-ARENA-1).
- E2E-6 Leaderboard gate ordering and intervals (FE-LB-1..5).
- E2E-7 Commitment verification in the trust center (FE-TRUST-1).
- E2E-8 Trainer review blinding (FE-REV-1..3).
- E2E-9 EX-4 presence on every route (FE-EX4-1).
- E2E-10 Axe, keyboard-only, 320 px (FE-A11Y-1..3).
- E2E-11 IAP expiry banner and refresh window (FE-TECH-2).
- E2E-12 Hidden tab closes the stream within 61 s (FE-SSE-5).
- REL-1 (release verification, recorded) Frame pacing on the demo laptop for room streaming and arena 4x replay.

---

## 13. Lift map

Effort: S up to 2 h, M 2-6 h, L over 6 h. All sources are read-only (D-002); code is copied with an attribution header naming the source path and commit.

| Source (read-only) | Lines | Target | Adaptation | Effort |
| --- | --- | --- | --- | --- |
| TechnoMile `web/src/lib/sse/ticketed-stream.ts` | 1-206 | `web/src/lib/sse/ticketed-stream.ts` | Verbatim; trial stream passes `backoffMs` `[250, 1000, 2000, 4000, 8000]`; add `visibilitychange` close/resume wrapper outside the module | S |
| TechnoMile `web/src/lib/sse/ticketed-stream.test.ts` | all (13 tests) | same path | Verbatim plus FE-SSE-1 additions | S |
| TechnoMile `web/src/lib/sse/frames.ts` | 15-31 | Server reference for `arena-api` SSE framing (`id: seq`, ping, `resumeAfter`) | Port to Python in the API spec | S |
| TechnoMile `web/src/lib/contracts/run-events.ts` | 1-10 | `contracts/events.schema.json` conventions | Absolute values, per-scope seq, 16 KB cap; arena event types (5.3) | M |
| TechnoMile `web/src/lib/war-room/office.ts` | 76-111, 323-399, 449-575, 661-729, 737-756 | `web/src/lib/arena/office.ts` | New `Role`/`Zone` enums and station plan (6.5); keep clocks, beats, frame, live sync | L |
| TechnoMile `web/src/components/war-room/agent-office.tsx` | 48, 120-230, 650-670, 844-859 | `web/src/components/arena/arena-floor.tsx` | Replace isometric office with 3x3 room matrix plus three stations; keep ticker, replay controls, `Mover`, `Caption` | L |
| TechnoMile `web/src/components/war-room/office-avatars.tsx` | `data-activity` contract (4, 237, 284) | `web/src/components/arena/figures.tsx` | Redraw figures per DESIGN.md; keep the activity attribute contract | M |
| TechnoMile `web/src/components/war-room/swarm-graph.tsx` | 45-51 | `web/src/lib/motion/use-reduced-motion.ts` | Verbatim `useSyncExternalStore` hook | S |
| TechnoMile `docs/design/motion.md` | 1-75 | `docs/design/motion.md` (arena) | Doctrine and verification method verbatim; arena event table; token values pending DESIGN.md | S |
| gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/voiceMachine.ts` | 1-234 | `web/src/lib/voice/voiceMachine.ts` | Section 6.2 changes | M |
| gokbase `.../voice/useVoiceSession.ts` | 1-392 (ticket subprotocol 10-11, 308-328; resume 17, 37-38, 278-300) | `web/src/lib/voice/useVoiceSession.ts` | Arena ticket route, close codes, `playback_ack` control; cost never on the wire | M |
| gokbase `.../voice/audioController.ts` | 1-338 | `web/src/lib/voice/audioController.ts` | Verbatim; add `played` and `cleared` message handling | S |
| gokbase `recruiter-frontend/public/worklets/capture-processor.js` | 1-56 | `web/public/worklets/capture-processor.js` | Verbatim | S |
| gokbase `recruiter-frontend/public/worklets/playback-processor.js` | 1-77 | `web/public/worklets/playback-processor.js` | Add played-sample reporting every 250 ms and `cleared` count (6.2) | S |
| gokbase `.../voice/pcm.ts` | 1-62 | `web/src/lib/voice/pcm.ts` | Verbatim | S |
| gokbase `.../voice/raf.ts` | 1-96 | `web/src/lib/motion/raf.ts` | Verbatim | S |
| gokbase `.../voice/spring.ts` | 1-117 | `web/src/lib/motion/spring.ts` | Verbatim if any eased value remains; else skip | S |
| gokbase `.../voice/companionContext.tsx` | 1-82 | `web/src/components/companion/companion-context.tsx` | Status type becomes `CompanionStatus`; `pointSignal` live (coach flags); levels getter feeds `--arena-talk` | S |
| gokbase `.../voice/kin/fsm.ts` | 25-122 | `web/src/lib/companion/fsm.ts` | Section 6.3 table; drop `approach`, `talk-sync`, `dragging` | S |
| gokbase `.../voice/kin/fsm.test.ts` | all | same | Re-target to the arena table | S |
| gokbase `.../voice/kin/registry.ts` | 17-26, 108-161 | `web/src/lib/companion/registry.ts` | Arena character set from DESIGN.md; keep lazy loader and `poseStyle` | S |
| gokbase `.../voice/kin/KinLayer.tsx` | 640-724 (per-frame CSS variable, reduced-motion static path), 735-760 (aria-hidden root, pointer-events) | `web/src/components/companion/companion.tsx` | Fixed placement; drop roaming, cursor lean, drag and keep-out | M |
| gokbase `.../voice/kin/pets/**` | art | none | Avoid: recruiting-brand art; new art per DESIGN.md | n/a |
| gokbase `.../voice/Transcript.tsx` | 15-18, 300-325, 472-473 | `web/src/components/room/transcript.tsx` | Pattern only: always-mounted `role="log"`, batched announcements; arena turn model | M |
| gokbase `recruiter-frontend/scripts/check_pet_bundle.mjs` | 1-251 | `web/scripts/check_bundle.mjs` | Arena chunk names; ceilings set from the first green build; honesty rules kept | M |
| gokbase `recruiter-frontend/playwright.config.ts` | all | `web/playwright.config.ts` | Base URL to local `arena-api`; projects for light, dark, reduced motion, 320 px | S |

---

## 14. Delivery order and cut order

| Window (direction 3.2) | Frontend work | Exit |
| --- | --- | --- |
| Oct 8-12 | Scaffold (1.2 pins, lint, Vitest, Playwright, bundle gate); event schema; SSE lift; reducers and machines (6.1-6.5 as pure modules with tests) | `make check` green for `web/` |
| Oct 13-18 (slice) | Plain unstyled room (text practice and assessment), evidence board, coach card, finding commit, plain leaderboard; minimal voice session if the Live probe passes | E2E-1, E2E-2, E2E-3; E2E-4 if voice |
| Oct 19-26 | Debrief, progress, arena matrix (structure), trial replay, trainer console, admin console; DESIGN.md applied when it lands | E2E-5..E2E-8 |
| Oct 27-30 | Trust center, leaderboards in full, companion, avatars, agents-at-work motion, voice polish | E2E-9..E2E-12 |
| Oct 31-Nov 2 | Accessibility pass, REL-1 frame pacing, recordings for S7 | All FE criteria green |

Cut first (direction 3.3): A2A exhibition section, Live Avatar, agents-at-work animation (ship the reduced-motion rendering), companion art (ship the status words and coach activity line). Never cut: mode projections and leak tests, EX-4 placements, gate-before-rank leaderboard, citation chips, trust center isolation and fairness sections.

---

## 15. Dependencies on other spec parts

| Needed from | Item |
| --- | --- |
| API spec | Routes in 5.5; SSE endpoints with `?after=` replay and ping; per-mode projections (5.4) applied server-side; `config` values (`voice_available`, `voice_scored`, `exhibition_enabled`, `phoenix_url`, question length limit); `409` on stale transcript version; `presented_record_ids` on questions |
| Data and isolation spec | Debrief reveal projection written by `arena-referee` for dev cases; `arena.isolation_checks` rows; leaderboard rows with all fields in 4.10 including interval bounds, provisional reasons and manifest hashes |
| Ledger spec | Exact commitment construction for in-browser verification (4.11) |
| Voice spec | Close codes (6.2), `turn_committed` and `exchange_count` frames, `playback_ack` control accepted by the relay |
| Scenario generator spec | `presentation` assigned per family (6.4) |
| Metrics spec | KPI-4 composition formula (5.6) |

---

## 16. Open questions (each with a proposed fix)

1. **WebSocket through IAP on Cloud Run is unconfirmed.** GDK documents WebSockets on Cloud Run and IAP on Cloud Run, but no source states that IAP passes WebSocket upgrades to a Cloud Run service. Fix: add a WebSocket-through-IAP upgrade to the day-1 probe matrix (direction 13.1); if it fails, voice falls to the owner's Oct 15 decision point.
2. **Browser Supabase session.** Direction 4.3 lists "a Supabase session" for the browser; this spec has the browser talk only to `arena-api` with IAP identity. Fix: `arena-api` verifies the IAP JWT assertion and maps it to an app user; no Supabase auth in the browser, which removes a credential and PostgREST exposure. If a Supabase session is required, only `src/lib/api/` changes.
3. **Admin path.** Section 4.13 serves the admin console from `arena-referee` through `gcloud run services proxy`. Needs confirmation in the infra and isolation specs.
4. **`playback_ack` control.** Direction 4.3 allows only start, stop and interrupt across the relay; playback-grounded transcripts (direction 9) need the played-sample acknowledgement. Fix: add `playback_ack` to the approved control list with a size cap.
5. **KPI-4 composition.** Section 5.6 proposes a formula; the metrics spec must adopt or replace it before the dev pilot measures latency.
6. **IAP adds latency** (GDK, `iap/docs/enabling-cloud-run` known limitations). The day-1 latency benchmark should run through IAP so KPI-4 includes it.

## 17. Sources and query log

Files read (read-only): direction v10; REQUIREMENTS.md; DECISIONS.md; PATTERNS.md; BRIEF.md; X5; I6; I7; S7 (sibling spec, for EX-4 and demo alignment). gokbase `recruiter-frontend`: `voice/voiceMachine.ts`, `voice/kin/fsm.ts`, `voice/kin/registry.ts`, `voice/kin/KinLayer.tsx` (640-760 and grep), `voice/companionContext.tsx`, `voice/raf.ts`, `voice/audioController.ts` (1-120, 225-300), `voice/useVoiceSession.ts` (grep), `voice/Transcript.tsx` (1-40, 300-325, grep), `public/worklets/playback-processor.js`, `scripts/check_pet_bundle.mjs` (1-40), `package.json`. TechnoMile: `docs/design/motion.md`, `web/src/lib/sse/ticketed-stream.ts`, `web/src/lib/sse/frames.ts`, `web/src/lib/contracts/run-events.ts` (1-60), `web/src/lib/war-room/office.ts` (1-75, 320-400, 737-776, exports), `web/src/components/war-room/agent-office.tsx` (1-80, 120-200, 842-897, grep), `web/src/components/war-room/swarm-graph.tsx` (grep), `web/package.json`, `web/next.config.ts`.

Context7 (CLI): `library "Next.js"` -> `/vercel/next.js`; `docs /vercel/next.js` static export (2 calls); `library "Vite"`, `library "Tailwind CSS"`, `library "React Router"` (resolutions); `docs /tailwindlabs/tailwindcss.com` Vite plugin and `@theme`; `docs /remix-run/react-router` data mode; `library "React Router"` v8; `docs /websites/reactrouter` v8 upgrade and `createBrowserRouter`. No quota errors.

Google Developer Knowledge MCP: `answer_query` IAP session expiry for AJAX (sources `iap/docs/sessions-howto`); `answer_query` IAP with WebSockets and SSE on Cloud Run, request timeouts (sources `run/quotas`, `iap/docs/concepts-overview`); `search_documents` IAP on Cloud Run limitations and Cloud Run WebSockets (sources `iap/docs/enabling-cloud-run`, `run/docs/securing/identity-aware-proxy-cloud-run`, `run/docs/triggering/websockets`).

npm registry (read-only `npm view <pkg> time`): versions and publish dates in 1.2.

No GCP, Vertex or paid API calls were made.
