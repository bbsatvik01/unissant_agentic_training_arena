<!-- Batch 2 research route I7; run wf_70bb0865-2f7; agent a0100a0e21b4acb63; 2026-10-08; Sonnet. Counts: {"google_web": 0, "gdk_mcp": 0, "context7": 0, "files_read": 19} -->

# Route I7 — UI lift map: companion pets, avatars, agents-at-work motion, live streaming UI

Read-only internal survey of two proven implementations against arena states (BRIEF.md, REQUIREMENTS.md AST/SUB/SCN, DECISIONS D-002/D-006). No recommendation; findings + lift map only.

## (a) gokbase companion-pet system ("kin")

### Component inventory (absolute paths)
- Registry (bundle-discipline seam): `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/registry.ts`
- FSM (pure pose transition table): `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/fsm.ts`
- Movement/render layer: `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/KinLayer.tsx`
- Picker UI: `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/PetPicker.tsx`
- 18 pet art files (6 characters x 3 styles: linework/soft/pixel), e.g. `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/pets/linework/Pip.tsx`
- Companion bridge/status source: `.../voice/companionContext.tsx` (referenced, not read this pass), `.../voice/voiceMachine.ts` (read, below), amplitude getter in `.../voice/PublicVoiceExperience.tsx:417,480,956,1008`
- Shared rAF ticker + spring: `.../voice/raf.ts`, `.../voice/spring.ts` (referenced by KinLayer imports, not opened this pass)
- Tests: `.../kin/__tests__/KinLayer.test.tsx`, `.../kin/__tests__/PetPicker.test.tsx`, `.../kin/__tests__/fsm.test.ts` (23 `it`/`describe` blocks)
- Bundle-discipline CI gate: `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/scripts/check_pet_bundle.mjs`
- DB migration naming the 18-slug cast: `/Users/balla/Desktop/satvik/gokbase-org/backend/database/migrations/182_voice_pet_styles.sql` (not opened; referenced by registry.ts:4,39)
- Design doc cited by code: `/Users/balla/Desktop/satvik/gokbase-org/worktrees/fix-59-public-profile-credentials/GOKBASE-DESIGN-SYSTEM.md`

### State machine and event vocabulary
`fsm.ts:25-122` — pure function `petStateFor(input: FsmInput): PetState`, no library (not XState, despite the docstring naming it for comparison). Inputs: `status: VoiceStateName` (`idle|connecting|listening|speaking|tool-lookup|reconnecting|ended`, from `voiceMachine.ts:23-30`), `pointSignal`, `reducedMotion`, `isMobile`, `idleMs`, `greeted`, `celebrating`, `farewelling`, `dragging`. Outputs one of 10 `PetState` poses: `greet, idle, attentive, approach(deprecated/dormant), talk-sync, point(dormant), think, error, sleep, celebrate, farewell`. Precedence is explicit and documented: dragging > point > one-shot windows (celebrate/farewell, each scoped to a specific `status`) > status table. Reduced-motion/mobile collapse animation bursts to stills (`fsm.ts:84,96,99,119`). The underlying voice FSM (`voiceMachine.ts:192-234`) is a classic reducer: event -> status with a terminal `ended` absorbing state and a close-code taxonomy (`closeCodeToEnded`, lines 91-110) separating terminal vs. transient disconnects — directly reusable for "subject session ended" states.

### Asset format
Pure SVG + CSS. No Rive, Lottie, canvas, or 3D anywhere in this tree (confirmed by reading `Pip.tsx` and the registry/loader code; no such dependency appears in gokbase's pet code). Talk-sync deform is a single CSS custom property `--kin-talk` (0-1, driven by TTS/Live RMS amplitude) read inline in SVG `transform: rotate(calc(var(--kin-talk,0) * -16deg))` (`pets/linework/Pip.tsx:30-36`) — set once per frame on the DOM node (`KinLayer.tsx:670`, `el.style.setProperty('--kin-talk', ...)`), never as a React prop, explicitly to avoid 60/s re-renders (`registry.ts:20-22`). Pose changes (infrequent) go through React state + `poseStyle()` (`registry.ts:148-161`), a cheap opacity/transform map.

### Animation and performance techniques
- Per-frame CSS variable mutation outside React render cycle (`KinLayer.tsx:669-717`), driven by a shared `rAF` subscription (`raf.ts`, not opened) rather than per-component `requestAnimationFrame` calls — avoids N independent rAF loops.
- Critically-dampened spring model (`spring.ts`, referenced, not opened) for anchor/position easing (`KinLayer.tsx:385-386`, stiffness 120/damping 22).
- Cursor-lean (bounded drift, R=160px, MAX_DRIFT=48px) and drag-to-place with pointer capture, computed off refs, not state, to avoid re-render thrash (`KinLayer.tsx:382-394`).
- Lazy-loaded pet components (`React.lazy` per slug, `registry.ts:110-137`) with a CI gate enforcing it stays lazy-only and under a pinned gzip ceiling (`check_pet_bundle.mjs:1-62`, ceiling 25781 B, three hard fail conditions: static-import regression, bundle-size ceiling, missing/undynamic pet).
- No explicit frame-pacing benchmark evidence was found in this code path (unlike TechnoMile, below) — the KinLayer test suite asserts mechanism, not measured FPS (`KinLayer.test.tsx:9-14`: jsdom has no real hit-testing, so tests assert the pointer-events contract, not visual performance).

### Accessibility
- Root layer is `pointer-events:none` always; only the `<svg>` is interactive, `bounding-box` hit-testing so transparent gaps don't swallow clicks (`KinLayer.tsx:233-241,744-757`).
- Sprite is `aria-hidden="true"` and never focusable (`KinLayer.tsx:741`) — i.e., explicitly decorative/non-semantic, not a focusable agent.
- Each pet SVG carries `role="img" aria-label="..."` (`Pip.tsx:18-19`) for screen readers that do traverse hidden trees via other means (defense in depth).
- `prefers-reduced-motion` fully respected: no rAF loop, static placement at anchor, no cursor lean, pose bursts collapse to stills (`fsm.ts:84`, `KinLayer.tsx:657-665`).
- Mobile (`<390px`) gets the same suppression as reduced-motion (`fsm.ts:84`, `KinLayer.tsx:213-221`).
- "Low-motion" character (Bit) is explicitly labeled in the UI (`registry.ts:68-76`, `PetPicker.tsx:194-207`) — a deliberate accessibility-by-choice pattern, not just a system-preference fallback.

### Tests
Vitest + Testing Library only (no visual/e2e suite found in this subtree). `KinLayer.test.tsx` (drivable rAF mock, tests the geometry/pointer-contract/anchor-persistence/reduced-motion/mobile paths as pure functions plus DOM attribute assertions), `PetPicker.test.tsx`, `fsm.test.ts` (23 cases — pure function, trivially testable). No Playwright/visual-regression config found under this directory.

### Asset licensing/provenance
All pet art is original hand-authored SVG path data in-repo (e.g., `Pip.tsx:23-43` — explicit path coordinates, no external asset import, no font/icon library attribution needed). No licensing concern; fully owned.

### Coupling to gokbase's product
Heavy but cleanly seamed coupling: `KinLayer` reads `useCompanion()` (a React context, `companionContext.tsx`, not opened) for `status`/`pointSignal`/`getLevels()`, which is itself fed by `PublicVoiceExperience.tsx`'s Gemini-Live-style voice session (`PublicVoiceExperience.tsx:360-480`, publishing "the REAL session status + amplitude getter into the companion bridge"). Persistence keys (`gkv-kin-anchor:<profileSlug>`, `gk_kin_greeted_<slug>`) are localStorage, per-visitor, keyed by a recruiter "profile" page — i.e., the whole system is scoped to one public recruiter-profile page with one voice widget. The FSM's `VoiceStateName` import (`fsm.ts:23`) is a hard type dependency on gokbase's own voice machine; porting requires either reusing `voiceMachine.ts`'s status union verbatim or re-deriving an equivalent union for the arena.

## (b) TechnoMile agents-at-work motion + live UI

### Component inventory (absolute paths)
- Motion spec/doc: `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/docs/design/motion.md`
- Design system doc (generic brand/tokens/components, no war-room/office/avatar/pet sections found by search): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/docs/design/DESIGN.md`
- Design tokens doc: `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/docs/design/tokens.md`
- Pipeline-view spec (a third run-view mode, alongside War Room and Office): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/docs/design/pipeline-view/SPEC.md`, `AUDIT.md`
- Agent office logic (pure functions: fold/plan/schedule): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/web/src/lib/war-room/office.ts`
- Agent office render (2.5D isometric office floor): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/web/src/components/war-room/agent-office.tsx`
- Hand-drawn SVG character avatars (9 roles): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/web/src/components/war-room/office-avatars.tsx`
- Swarm graph (agent-to-agent message graph view): `.../web/src/components/war-room/swarm-graph.tsx`, logic `.../web/src/lib/war-room/swarm-graph.ts` (tested, `swarm-graph.test.ts`)
- Run feed / run views / war-room shell / war-game: `.../web/src/components/war-room/{run-feed,run-views,war-room,war-game,swarm-panel}.tsx`
- Hooks: `.../web/src/components/war-room/{use-office-feed,use-swarm,use-war-room}.ts`
- War-room pure-logic modules (all independently tested): `player.ts`, `recording.ts`, `script.ts`, `recovery.ts`, `feed-text.ts`, `state.ts`, `swarm.ts`, `run-sync.ts` under `.../web/src/lib/war-room/` (each with a sibling `*.test.ts`)
- SSE client (ticketed, reconnecting EventSource): `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/web/src/lib/sse/ticketed-stream.ts` (+ `frames.ts`, `replay-stream.ts`, each with a `.test.ts`)
- `web/package.json`: `/Users/balla/Desktop/satvik/2026 Fall/Challenge X/TechnoMile Agentic Black Hat/web/package.json` — React 19.3.0, Next 16.3.6, TypeScript 6.0.3, Vitest 4.1.11 (`@vitest/coverage-v8`), Tailwind 4.3.3, `@phosphor-icons/react` 2.1.10, `d3-scale` 4.0.2, `radix-ui` 1.6.7, `cmdk` 1.1.1. **No animation library** (no Framer Motion, GSAP, Rive, Lottie, Three.js) — confirmed absent from dependencies, consistent with motion.md's "No motion library: CSS keyframes and transitions cover every case."
- A "dossier-interview" screen exists (`docs/design/screens/07-dossier-interview.png`) — closest visual analog to an "interview/interrogation" screen in this repo, but it is a static reference screenshot, not source I opened/traced to a component; the name suggests a document-review UI, not a live two-party interrogation room.

### State machine and event vocabulary
Not a classic FSM; it is an **event-replay scheduler** over a typed event ledger. `office.ts:76-111` folds `RunEventEnvelope`s (`STATE_SNAPSHOT`, `STEP_STARTED`/`STEP_FINISHED`, `ACTIVITY_SNAPSHOT` with `activityType: fetch|verify`) into an `OfficeRecord` (lanes, fetches, verifies, stage edges), monotonic on `seq`, duplicate-safe (`seen: Set<number>`), order-independent (sorts by `seq` first). `buildSchedule`/`frameAt` (referenced in office.ts docstring, not fully read) turn this ledger into "beats on a display clock" — i.e., **every visual motion is traced back to a recorded server event**, never free-running. Roles/zones are a closed enum: `Role = researcher|capture_lead|pricing|technical|past_performance|red_team|analyst|evaluator|verifier` (`office.ts:147`), `Zone = pod|red_team|analyst|board|verify` (`office.ts:149`). `Activity` states referenced via `data-activity` CSS hook (`office-avatars.tsx:4,237,284`): at minimum `idle|typing|browsing|still` observed, driving blink/type/step/hop CSS per `motion.md:49-54`.

### Asset format
Pure hand-authored SVG (bezier path data per role, e.g. `office.ts`'s `BODY` record is actually defined in `office-avatars.tsx:50-67`) + CSS, isometric 2.5D projection computed in plain TS math (`office.ts:134-145`, `iso()`/`depth()` functions, tile size 64x32px, no WebGL/canvas/3D engine). Confirmed: no Rive/Lottie/canvas/3D dependency in `package.json`.

### Animation and performance techniques
- Strict "motion means a state change" doctrine (`motion.md:1-6`): every animation utility has exactly one assigned meaning (table, `motion.md:23-31`); a new animation requires a new meaning — explicit anti-decoration rule.
- Only `transform`/`opacity` animated, never width/height/top/left/color-on-large-areas/filters (`motion.md:38`) — avoids layout thrash, explicitly to hold 60fps.
- Store updates batched ~10Hz; a burst of events plays once per batch (`motion.md:41`) — throttles animation triggering independent of event volume.
- Each agent "message" motion is bound to the **actual recorded model-call latency window** (`ts - latencyMs` to `ts`, capped at 1.6s) — not a fixed animation duration (`motion.md:49`).
- A live run plays 3.5s behind the ledger to absorb clock skew + poll lag (`motion.md:56`); a paused replay freezes character loops too; a finished run's replay plays 8x faster with silences capped at 6s.
- One exception to "loops only mark work in progress": a 150ms blink every 5.2s, added purely as "a sign of life," owner-requested (`motion.md:54`) — a deliberate, documented exception.
- **Measured** frame-pacing evidence exists (unusual rigor): `motion.md:64-75` — streaming War Room: 481 frames/8s, p50 16.7ms, p95 16.8ms, 0 frames >50ms, 0.0000 CLS; agent office 4x replay: 477 frames/8s, same p50/p95, 0 frames >50ms. Recordings at `docs/design/motion/war-room-replay.webm` and `docs/design/e2e/agent-office/`.

### Accessibility
`prefers-reduced-motion: reduce` collapses every animation/transition to 1ms with no delay and removes all loops (sweep/pulse-soft/settle) entirely (`motion.md:60-62`), with the end-state of each animation remaining visible as a static style (no information loss). For the agent office specifically, reduced motion removes walking/flying/looping; characters appear already at their relevant location (terminal, board table), and **a caption above the floor states in words what is happening** (`motion.md:58`) — a text-equivalent-of-motion pattern directly reusable for "coach flagging a contradiction" / "evidence released" moments. Verified: reduced motion = 0 looping animations on a replay that otherwise has 29 (`motion.md:74`).

### Tests
Vitest with coverage gate (`package.json` script `"test": "vitest run --coverage"`). Confirmed `*.test.ts` siblings for essentially every pure-logic module under `lib/war-room/` and `lib/sse/` (player, recording, script, recovery, feed-text, state, swarm-graph, swarm, run-sync; frames, ticketed-stream, replay-stream) — 9 test cases in `office.test.ts` alone. No dedicated Playwright/e2e config found in `web/` (the `docs/design/e2e/run1-nswcdd/*.png` and `docs/design/demo/*.png` directories are manual/scripted screenshot walkthroughs, not an automated e2e test suite per se — treat as visual documentation, not CI-gated visual regression).

### Asset licensing/provenance
Original, hand-drawn SVG path data per role (`office-avatars.tsx:50-176`), CSS-variable-themed (`--tint` per team), no external icon/illustration library used for the characters themselves (Phosphor icons are used elsewhere in the product for UI chrome, per `package.json`, but not for the office avatars). No licensing concern.

### Coupling to TechnoMile's product
Office avatars are tightly keyed to **capture/business-development roles** (`pricing`, `capture_lead`, `past_performance`, `technical`) that have no equivalent in an investigative-interview arena; the `researcher`/`red_team`/`analyst`/`evaluator`/`verifier` roles map more naturally. The scheduler is built around a specific event-contract (`RunEventEnvelope`, `lib/contracts/run-events.ts`, not opened this pass) tied to their 15-stage pipeline (S0-S15) — the event taxonomy (`STEP_STARTED/FINISHED`, `ACTIVITY_SNAPSHOT` fetch/verify) is generic enough to adapt but the stage IDs are TechnoMile-specific. The ticketed SSE client (`ticketed-stream.ts`) is the most product-agnostic piece: it is itself noted in its own docstring as "Lifted from gokbase `src/lib/sse/ticketed-stream.ts`" with one bug fix — i.e., **this exact file is already a cross-repo lift precedent**, evidence the team has done this exact kind of port before and it worked (`ticketed-stream.ts:5-16`).

## Lift map

| Component | Path | Lift verbatim / adapt / avoid | Arena adaptation | Effort |
|---|---|---|---|---|
| `fsm.ts` pose transition table | gokbase `.../kin/fsm.ts` | **Adapt** | Replace `VoiceStateName` union with arena turn-states (`investigator-typing, subject-thinking, subject-speaking, coach-flagging, evidence-released, finding-committed, trial-running`); keep the precedence-ladder pattern (one-shot windows > status table) for "coach flags a contradiction" as a one-shot celebrate/farewell-style event | S |
| `voiceReducer` + close-code taxonomy | gokbase `.../voice/voiceMachine.ts` | **Adapt** | Reuse the reducer skeleton + terminal-vs-transient disconnect split for subject Gemini-Live sessions (D-006); the terminal `ended` absorbing-state pattern fits "trial ended" | S |
| `--kin-talk` CSS-var talk-sync | gokbase `.../kin/pets/*/*.tsx`, `KinLayer.tsx:669-717` | **Lift verbatim (technique)** | Drive subject-avatar mouth/head motion from Gemini Live TTS/output amplitude the same way — per-frame CSS var, no React re-render; works for both assistant "thinking" pulse and subject "speaking" tell | S |
| Registry + lazy-per-slug loader + bundle CI gate | gokbase `registry.ts`, `check_pet_bundle.mjs` | **Adapt** | Needed if arena ships 3 assistant + 3 subject "characters" as swappable avatars; reuse the lazy-import + gzip-ceiling gate pattern verbatim, recompute the ceiling number for this app | M |
| 18-pet SVG art (Pip/Marlow/Otto/Bit/Juno/Sable x 3 styles) | gokbase `.../kin/pets/**` | **Avoid (reuse pattern, not art)** | Art is a recruiting-brand character set (crane, moth, etc.); owner's DESIGN.md will likely specify arena-appropriate characters (investigator/coach/subject personas) — redraw, don't reuse | S (to decide), M (to redraw 6 new characters x however many styles) |
| Cursor-lean + drag-to-place + anchor persistence | gokbase `KinLayer.tsx:382-529` | **Avoid for MVP, adapt later** | Investigation-room UI likely wants fixed avatar positions (investigator desk, subject chair, coach panel) matching a "virtual interrogation room" layout, not a free-roaming draggable pet; the anti-roam/cursor-driven-lean machinery is over-built for this use case | — (skip) |
| `prefers-reduced-motion` + low-motion character labeling | gokbase `fsm.ts:84`, `PetPicker.tsx:194-207` | **Lift verbatim (pattern)** | Directly reusable accessibility contract; label whichever of the 3 assistant / 3 subject characters is lowest-motion | S |
| Agent-office event-to-beat scheduler (`foldOffice`/`planOffice`/`buildSchedule`/`frameAt`) | TechnoMile `web/src/lib/war-room/office.ts` | **Adapt (strongest architectural fit)** | This is the single best-matched piece for "agents visibly doing work": fold the arena's own event ledger (investigator question, subject answer, coach flag, evidence release, finding commit, tournament trial) into the same seq-ordered, duplicate-safe, replay-and-live-dual-mode schedule; swap `Role`/`Zone` enums for arena roles | M |
| Hand-drawn SVG office avatars (role-tinted silhouettes, blink/type/step/hop via `data-activity`) | TechnoMile `web/src/components/war-room/office-avatars.tsx` | **Adapt** | Redraw silhouettes for investigator/coach/subject roles; reuse the `data-activity` CSS-driven animation contract (blink-always, type-when-active, hop-on-message) | M |
| Motion doctrine ("one meaning per animation", transform/opacity only, 10Hz batching, measured frame-pacing verification) | TechnoMile `docs/design/motion.md` | **Lift verbatim (doctrine + verification method)** | Directly reusable engineering discipline; re-run the same frame-pacing measurement methodology (p50/p95/frames>50ms, CLS) against the arena's own live-trial streaming view before claiming 60fps | S |
| Reduced-motion caption-replaces-motion pattern | TechnoMile `docs/design/motion.md:58` | **Lift verbatim (pattern)** | "A caption above the floor says in words what is happening" maps directly to "coach flagging a contradiction" / "evidence released" under reduced motion — critical since these are scored/judged moments that must never be motion-only | S |
| Ticketed reconnecting SSE client | TechnoMile `web/src/lib/sse/ticketed-stream.ts` | **Lift verbatim** | Already a gokbase-origin lift once (own docstring says so); reuse directly for streaming live-trial turns/coach flags to the UI; single-use ticket + resume-by-seq fits the Supabase/GCP scale-to-zero topology (D-003) | S |
| Swarm graph (agent-to-agent message visualization) | TechnoMile `web/src/components/war-room/swarm-graph.tsx` + `lib/war-room/swarm-graph.ts` | **Adapt (optional)** | Could visualize assistant-vs-subject-vs-coach message flow in a bake-off trial view; lower priority than the office scheduler for MVP | M/L |
| Pipeline view (rail + canvas, phase grouping) | TechnoMile `docs/design/pipeline-view/SPEC.md` | **Adapt (optional, later)** | Good pattern for an "admin/judge inspector" view of a trial's stage-by-stage progress (question asked -> evidence released -> finding committed), separate from the live interrogation room itself | L |
| "Dossier-interview" screen | TechnoMile `docs/design/screens/07-dossier-interview.png` | **Avoid as-is (insufficient evidence)** | Only a screenshot was available in this pass, not traced to source; do not assume it implements a live two-party interrogation room — verify against actual component before counting on it | — (needs follow-up read) |

## Contradictions

- The task brief states gokbase's kin system cites "GOKBASE-DESIGN-SYSTEM.md" for its design rules at section numbers like §3.2, §9.3, §9.5, §9.4, §7.4, §3.3, §4.1, §C5 (seen in code comments: `registry.ts:4`, `check_pet_bundle.mjs:3,30`, `KinLayer.tsx` docstring, `fsm.ts` docstring). A targeted grep of the one available copy of `GOKBASE-DESIGN-SYSTEM.md` (`/Users/balla/Desktop/satvik/gokbase-org/worktrees/fix-59-public-profile-credentials/GOKBASE-DESIGN-SYSTEM.md`) for "kin", "companion", "pet", "P11", "low-motion", and each cited section marker found **no matching companion-pet design section** — only one incidental reduced-motion CSS rule (`GOKBASE-DESIGN-SYSTEM.md:807`, about an unrelated dash-flow/spark element). Either the cited sections live in a different/newer copy of the design doc not present in the searched worktree, or the doc has drifted out of sync with the code's citations. (medium confidence this is a real doc/code drift, not a search miss — grep was case-insensitive and covered all cited markers)
- The task description characterizes TechnoMile's `docs/design/DESIGN.md` as covering "the agent office, pipeline view and pet components." A structural grep of that file's headings found only a generic brand/typography/component design system (Colors, Typography, Buttons, Cards, Tabs, Badges, Navigation) with **no Agent Office, War Room, Pipeline, companion, avatar, or pet section** — all agent-office/motion content actually lives in the separate `motion.md`, and pipeline-view content lives in its own `pipeline-view/SPEC.md` and `AUDIT.md`. TechnoMile has no "pet"/companion-creature component at all — "agents-at-work" there means office-desk avatars, not a free-standing companion mascot like gokbase's kin.
- TechnoMile's motion doctrine explicitly forbids decorative motion ("never decorates"), while gokbase's kin system is explicitly designed as a decorative/emotional companion (click-to-emote, "pet the pet," cursor-chasing). These are philosophically opposed approaches to agent-presence UI; the arena's need for both "agents visibly doing work" (TechnoMile's doctrine) and "companion pets"/"talking agents" (gokbase's approach, per BRIEF.md) will require reconciling or deliberately scoping each pattern to a different UI surface (e.g., office-scheduler for the interrogation-room floor, kin-style companion for a coach's sidebar mascot).

## Open questions

- Does the owner's forthcoming DESIGN.md specify whether the assistant/subject "avatars" should be decorative companions (gokbase kin style) or work-visualizing office characters (TechnoMile style), or both on different surfaces?
- Is there a newer copy of `GOKBASE-DESIGN-SYSTEM.md` (outside the read-only reference paths given) that actually contains the §3.2/§9.3/etc. companion-pet sections the code cites?
- Was the "dossier-interview" screen (`07-dossier-interview.png`) ever implemented as a live component, or is it a design mock only? Needs a follow-up source read if the owner wants to lift it.
- Does TechnoMile's `lib/contracts/run-events.ts` event schema (referenced but not read this pass) generalize cleanly to arena events (question asked, answer given, flag raised, evidence released, finding committed), or would it need a parallel, arena-specific event contract?
- Is there a non-screenshot automated visual-regression/e2e suite in TechnoMile (Playwright etc.) outside `web/`, or is `docs/design/e2e/*` purely manual walkthrough capture?
- Gokbase's kin system persists companion position via `localStorage` keyed per public profile page — does the arena need multi-user state (Supabase) instead, given judges/users on a hosted link (D-008) rather than gokbase's single-visitor public page model?

## Implications for the arena build

- The **strongest direct architectural fit** for "agents visibly doing work" is TechnoMile's event-ledger-to-schedule pattern (`office.ts`): it is pure, testable, replay/live-dual-mode, and already measured for 60fps — it should likely anchor the "agents at work" / "tournament trial running" visualization, with role/zone enums redefined for investigator/subject/coach.
- The **strongest direct fit** for "talking agents" / amplitude-driven mouth-and-head motion is gokbase's `--kin-talk` CSS-variable technique — it is a small, self-contained, dependency-free pattern that pairs naturally with D-006's Gemini Live lift (amplitude is already computed for the kin talk-sync use case in gokbase's voice stack).
- Neither repo contains a Rive/Lottie/canvas/3D pipeline; both are pure SVG+CSS. This caps expected visual fidelity but keeps bundle size and performance risk low, consistent with D-003's scale-to-zero/1-2-concurrent-user constraint — no GPU/3D runtime to provision or debug.
- The reduced-motion-replaces-with-caption pattern (TechnoMile) is directly load-bearing for the arena's scoring integrity: coaching flags and findings (AST-2, AST-3, EX-2/EX-3) must be legible even with motion off, and TechnoMile already has a tested precedent for "state must remain visible as a static style/caption" rather than motion-only.
- The gokbase bundle-discipline CI gate (`check_pet_bundle.mjs`) is a reusable pattern for enforcing that a 3-assistant/3-subject multi-character set never bloats the hosted judge-facing bundle (relevant to D-008's hosted link + $100 spend cap concerns around judge-usable infra, though that gate concerns client bundle size, not model spend).
- The SSE ticketed-stream client is effectively a zero-risk lift (TechnoMile's own docstring documents it as already ported from gokbase once, with the fix recorded) — strong candidate for the arena's live-coaching/evidence-release streaming transport, and it is architecture-agnostic to the investigative domain.
- Both reference codebases independently reinvented/ported the same SSE pattern, which increases confidence it generalizes a third time to the arena, but the arena's requirement for <=3s coaching latency for 95% of turns (KPI-4) will need this client's retry/backoff timings (2s x attempt, capped 15s, max 5 retries) explicitly re-tuned or bypassed for the real-time coaching path, since the existing defaults could themselves exceed the 3s budget on a reconnect.

## Query log

- Web search: none run (source_counts.google_web = 0, per route constraints).
- GDK MCP: none run (source_counts.gdk_mcp = 0, per route constraints).
- Context7: none run (source_counts.context7 = 0, per route constraints).
- Files read/globbed/grepped (all local, read-only; see `files_read` count): BRIEF.md; REQUIREMENTS.md; DECISIONS.md; gokbase `kin/registry.ts`, `kin/fsm.ts`, `kin/KinLayer.tsx`, `kin/PetPicker.tsx`, `kin/pets/linework/Pip.tsx`, `kin/__tests__/KinLayer.test.tsx` (partial), `voice/voiceMachine.ts`, `voice/PublicVoiceExperience.tsx` (grep only), `scripts/check_pet_bundle.mjs`, `GOKBASE-DESIGN-SYSTEM.md` (grepped twice, full-text not read); TechnoMile `docs/design/DESIGN.md` (headings grepped), `docs/design/motion.md` (full read), `docs/design/pipeline-view/SPEC.md` (partial read), `web/package.json`, `web/src/lib/war-room/office.ts` (partial), `web/src/components/war-room/office-avatars.tsx` (full), `web/src/lib/sse/ticketed-stream.ts` (full), plus directory globs across `kin/`, `docs/design/`, `web/src/components/war-room/`, `web/src/lib/war-room/`, `web/src/lib/sse/`, `web/e2e/` (none found).
