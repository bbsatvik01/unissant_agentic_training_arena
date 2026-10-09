# UI direction: characters, motion, voice, and the design pipeline

Version 1, 2026-10-08. Research-harness synthesis of `docs/research/ui/U1-U5*.md` (69 Google web, 9 GDK, 17 Context7, 33 files) plus the earlier X5 and I7 reports. Matrix totals and sensitivity come from `decision_matrix.py` (`ui_report`). The owner's DESIGN.md will set colors, type and brand; this document sets the characters, motion, voice surfaces, copy rules and tooling, and stays token-agnostic. Local-first (D-011).

## 0. TL;DR

1. **Quiet by default, expressive at the moments that matter.** The most-copied product UIs (Linear, Vercel, Stripe) keep everyday motion at 80-240 ms and decoration-free; "stunning" comes from a few choreographed signature moments, not from motion everywhere. Ours: evidence released, contradiction noticed, finding committed, leaderboard reveal, debrief score count-up. (M-H) [U3, U4]
2. **The coach is a pet, in the sense OpenAI shipped in May 2026:** ChatGPT and Codex "Pets" are small characters showing real work states (running, needs input, ready, blocked). Ours ports gokbase's companion-pet state machine (`kin/fsm.ts`, ~100 lines, measured, accessible) with new arena art and arena states; its state reflects the session, never anyone's demeanor (PRB-4). (H) [U2, U3, U5]
3. **Subject avatars are a generated, vectorized portrait set with an audio-driven mouth.** Gemini image generation produces a consistent character sheet (well under $5 total); VTracer plus cleanup gives SVG; a CSS-variable rig reads one amplitude value per frame from the Web Audio analyser for speaking. Demeanor and voice are assigned independently of role, and the avatar has no nervous or stressed states at all. (H) [U2, U5]
4. **Gemini 3.8 Live Avatar is out of scope.** Its configuration lives in Gemini Enterprise's Agent Platform with presets for Enterprise customers and custom avatars allowlisted; it is not confirmed reachable from a plain Vertex project and has no published video price. (H on the finding) [U2]
5. **Motion stack: Motion for state-driven UI, GSAP (now fully free) for the signature sequences, plain CSS transforms for per-frame character rigs.** All three honor `prefers-reduced-motion`; frame pacing is measured (p95 under 16.8 ms, TechnoMile's bar) with the Long Animation Frames API. (M-H) [U3]
6. **Voice uses a pill-shaped bar, not a full-screen takeover** (Gemini Live's May 2026 redesign), so the evidence board and transcript stay visible; the voice state machine mirrors the Live API's own `interaction_status` and `interrupted` fields. (M-H) [U4]
7. **Agents at work:** TechnoMile's pipeline rail plus canvas (progressive disclosure, already measured at 60 fps) ships first; the isometric office becomes a demo "theater" toggle only if time remains. (M; the matrix is a tie) [U3, I7]
8. **No AI jargon, enforced.** A word list in the copy rules, an anti-slop gate (no purple-blue gradients, glow, sparkles, robot icons) checked before every UI merge, and EX-4 disclosure worded per surface so it never fades into a habituated badge. (M-H) [U3, U4]
9. **Tooling:** `impeccable` for product UI (audit, polish, animate), the official `frontend-design` plugin (already cached) for marketing surfaces, Stitch MCP to turn the owner's DESIGN.md into static screens, `vercel:shadcn` for components, `claude-in-chrome` for visual QA today; Playwright MCP and Chrome DevTools MCP are recommended additions that need the owner's yes. (H on availability) [U1]

## 1. Characters

### 1.1 Coach companion pet (UI-1)

| Option | Total |
| --- | --- |
| **A. Port gokbase kin FSM, new SVG art, CSS-variable rig** | **4.70** |
| B. Rive data-bound state machine | 3.90 |
| C. dotLottie state machine | 3.70 |

No 10-point weight shift changes the winner. Rive stays an upgrade path for one hero character after the October 18 slice (its editor needs a paid seat, about $9 a month, to export, and export is manual). [U5]

**States** (inputs are turn structure and coaching events only; a type-level invariant forbids any input derived from sentiment or the subject's demeanor):

| State | Trigger | Motion |
| --- | --- | --- |
| idle | Nothing pending | Slow breathing loop, blink |
| listening | Investigator typing or speaking | Ears and eyes toward the input |
| thinking | Coaching card in progress | Small looped gesture, no spinner |
| noticing | A flag arrives (gap, contradiction) | One-shot point toward the cited turn chip |
| encouraging | The investigator's question scores well on neutrality and evidence use | One-shot nod |
| celebrating | Finding committed with support, or a debrief improvement | One-shot, at most once per session |
| sleeping | Assessment mode (coaching hidden) or long idle | Still pose |

Assessment mode suppresses every coaching-derived state (no `noticing` or `encouraging`), so the pet cannot leak hidden coaching (F21). Reduced motion collapses each one-shot to the nearest still pose with a caption, as gokbase does.

### 1.2 Subject avatars (UI-2)

| Option | Total |
| --- | --- |
| **A. Gemini-generated portrait set, vectorized, amplitude-driven mouth** | **4.40** |
| B. Rive-rigged 2D | 3.60 |
| C. three-vrm 3D with TalkingHead lip sync | 3.30 |

No 10-point shift changes the winner. Pipeline: one fixed character description plus reference images per persona in Gemini image generation (character sheet: neutral, speaking mouth shapes, pausing), VTracer to SVG, hand cleanup, CSS-variable rig. Keep the original PNG per character as the provenance record (Gemini 3 Pro Image supports C2PA content credentials; vectorizing strips them). Speaking: amplitude from the Web Audio analyser (Gemini Live outputs 24 kHz PCM16 with no timing metadata) drives mouth and a subtle head motion; text-driven visemes are an optional upgrade since we hold the script. States: idle, speaking, pausing. There is no nervous, defensive or stressed state, and the voice, accent and portrait are drawn independently of role.

### 1.3 Agents at work (UI-4)

| Option | Total |
| --- | --- |
| A. Pipeline rail + canvas, with an office "theater" toggle for the demo | 4.40 |
| B. Pipeline rail + canvas only | 4.40 |
| C. Isometric agent office only | 3.50 |

A and B tie, and many weight shifts favor B, so B ships first (TechnoMile `pipeline-view/SPEC.md` and `agent-office.tsx`: event-bound motion, nothing animates without a backing event, live runs played a few seconds behind the ledger, reduced-motion captions). The office theater is added only if time remains after the slice, as a cut-first item.

## 2. Motion system (UI-3)

| Option | Total |
| --- | --- |
| **A. Motion (state-driven UI) + GSAP (signature sequences) + CSS (per-frame rigs)** | **4.60** |
| B. CSS only (TechnoMile discipline) | 4.40 |
| C. Motion only | 4.30 |

The lead is narrow: shifting 10 points from impact to delivery or performance makes B the winner. So A is adopted with a discipline: no library animates per-frame character rigs (CSS variables do), GSAP is limited to the signature moments, and everything else uses Motion's declarative transitions.

- **Tokens** (names only; values come from DESIGN.md): `motion.instant` (~80 ms), `motion.quick` (~160 ms), `motion.base` (~240 ms), `motion.signature` (~600-900 ms choreographed), one standard ease, one spring preset for layout changes.
- **Signature moments:** evidence released (card slides into the court-record board, the cited statement chip pulses once); contradiction noticed (a thin connector draws between the two quoted turns); finding committed (seal animation, the commitment hash appears); leaderboard reveal (rank intervals grow from zero, ties shown as overlapping spreads, LMArena pattern, D3 transitions with interrupt for reduced motion); debrief (five 0-4 cards count up).
- **Streaming text:** the coaching card fades in field by field as validated JSON arrives; no typewriter effect for transcript text.
- **Performance:** transform and opacity only on hot paths; Long Animation Frames observer in development; p95 frame time under 16.8 ms on the demo laptop, with zero layout shift (TechnoMile's measured bar).
- **Reduced motion:** every animation has a still end state and, where motion carried meaning, a caption.

## 3. Voice surface
- A pill-shaped voice bar docked at the bottom of the interrogation room; the evidence board, transcript and coach stay visible.
- The bar's states mirror the Live API's `interaction_status` (idle, in progress) and `interrupted` flag, plus the gokbase `voiceMachine.ts` close-code taxonomy for connection states; the field set is confirmed on the chosen model during the day-1 probe.
- An audio-reactive ring on the bar and the subject avatar's mouth read the same amplitude value; the investigator's own input level shows as a small meter while speaking.

## 4. Copy rules (no AI jargon)

| Use | Not |
| --- | --- |
| coach | AI assistant, agent, copilot |
| subject | bot, persona, AI character |
| check, review | inference, model call, LLM |
| case file, evidence | context, prompt, retrieval |
| finding, confidence | prediction, probability score |
| practice, assessment | mode toggle names from the code |

Tournament vocabulary (candidate, manifest, replay track) appears only on the arena, leaderboard and trust-center screens, never in the trainee's room. EX-4 is worded per surface: onboarding ("Every case here is invented. Nothing you do here is a finding about a real person."), room footer, debrief header, leaderboard caption, methodology page. Each wording is short and persistent, not a one-time interstitial.

**Anti-slop gate** (checked by `impeccable` audit and a checklist before each UI merge): no purple-to-blue gradient signature, no default glow shadows, no sparkle or "AI" badges, no robot or brain icons, no particle heroes, no stress-coded colors on avatars (also PRB-4), no generic stock illustration.

## 5. Design-to-code pipeline and skills
1. Owner supplies DESIGN.md (format to confirm: Stitch's design-md schema and impeccable's are not confirmed interchangeable).
2. Stitch MCP (`create_design_system_from_design_md`, `generate_screen_from_text`, `generate_variants`) produces static and form-heavy screens: onboarding, case library, debrief, leaderboard, trust center. Character, voice and agents-at-work surfaces are hand-built (Stitch makes static screens, not event-driven state machines).
3. Components via `vercel:shadcn` (the official `npx shadcn@latest mcp init` exposes the project's registry to agents).
4. `impeccable` drives product-UI polish: `audit`, `polish`, `animate`, `harden`; the official `frontend-design` plugin (cached under `claude-plugins-official`, install with the owner's yes) guides the landing and demo surfaces.
5. Visual QA: `claude-in-chrome` screenshots and GIF capture now; recommended additions with the owner's sign-off: Playwright MCP (scripted visual diffs, axe accessibility scans) and Chrome DevTools MCP (performance traces, frame pacing).
6. Google's separate Design MCP (color, font and icon generation) is not used: colors and fonts belong to DESIGN.md.

## 6. Risks and open questions

| Item | Note | Resolution path |
| --- | --- | --- |
| "Stunning" vs quiet premium motion | Owner intent vs industry practice | Signature moments; owner reviews a motion reel at the slice |
| VTracer quality on generated art | Not tested hands-on | Pick a flat, stylized art direction in the character sheet prompt; budget 1-2 h cleanup per character |
| Rive licensing | Editor export needs a paid seat | Only if a hero character is approved after the slice |
| Live API state fields on the chosen model | `interaction_status` confirmed for 3.8 Live; unconfirmed for 2.5 native audio | Day-1 probe |
| GSAP version | Sources disagree (3.13 vs 3.15) | Pin from npm at build time |
| Pet personality vs scoped tool | Mascot risk (Microsoft narrowed Mico in Aug 2026) | Pet appears only in the room and debrief, bound to real states, small, dismissible |

## 7. Owner decisions
1. Confirm the character direction (kin-style pet, generated portrait avatars, no 3D, no Live Avatar).
2. DESIGN.md format (Stitch design-md or impeccable).
3. Install the official `frontend-design` plugin, Playwright MCP and Chrome DevTools MCP.
4. Pet name and personality range (calm and encouraging by default).
