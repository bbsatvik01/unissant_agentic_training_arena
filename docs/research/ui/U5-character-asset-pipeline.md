<!-- Route U5; 2026-10-08; Sonnet. Counts: {"google_web": 5, "gdk_mcp": 2, "context7": 2, "files_read": 8} -->

# U5: Character asset pipeline — producing avatars, the coach pet, and agent characters on a small budget and timeline

Research date: 2026-10-08. Scope: route U5 only — **how to produce** the character set (pipelines, cost, licensing, state models, lip sync), not which visual style to use (DESIGN.md's call) and not a re-survey of avatar/pet UX research. Builds on and does **not** repeat: `02-direction.md` (sections 0, 2, 3, 6, 9 — read in full), `X5-interrogation-ui-avatars-voice-pets.md`, `I7-ui-lift-map-pets-agents-at-work.md`, `U1-claude-skills-and-design-tools.md`, `U2-speaking-avatars-and-pets.md`, `U3-motion-system-and-pipeline-visuals.md` (all five read in full before this route started, per the task's "go deeper and newer" instruction). Where this route confirms an X5/U2 finding it says so instead of re-deriving it; where it resolves an X5/U2 open question, it is marked **[resolves X5/U2 open question]**.

Hard constraints carried forward: **PRB-4** (no stress/nervousness meters; avatar demeanor and voice independent of role; nervousness is never evidence), **EX-4** (synthetic-only ground rule visible), assessment mode hides coaching, reduced-motion support, WCAG 2.2 AA. **No colors or fonts are picked here** — DESIGN.md owns those. **No final decisions** — every section is an option set with trade-offs.

---

## 1. Pipelines to build a consistent character set in 2-3 days

Three independent production paths exist, usable alone or layered (cheap tier for bulk personas, richer tier for 2-4 "hero" characters — the coach pet, maybe one subject archetype). None requires a GPU/3D runtime; D-011 (local-first) and the 1-2-concurrent-user reality favor the cheapest path that still looks deliberate.

### 1.1 Pipeline A — Gemini image generation -> vectorize -> hand-finish SVG+CSS rig (gokbase `kin` pattern)

**Step 1 — character sheet and expression variants (Gemini image generation on Vertex).** X5 already found the consistency technique (one fixed, unchanging character-description paragraph reused verbatim across prompts, varying only the action/expression clause; up to 5 character-reference images for Gemini 3.x Pro Image / "Nano Banana Pro"; same seed reused for style consistency; "thought signatures" carried across multi-turn edits). This route adds **current, dated Vertex/Gemini API pricing**, fetched directly from Google's own pricing corpus:

| Model | 1K/2K image | 4K image | Notes |
|---|---|---|---|
| **Gemini 3 Pro Image ("Nano Banana Pro")** — standard | $0.134 | $0.24 | Batch (50% off): $0.067 / $0.12. GA 2026-05-28 on Vertex (`gemini-3-pro-image`), global region only, 65,536 input / 32,768 output tokens, up to 14 images per prompt. [GDK `search_documents`, `ai.google.dev/gemini-api/docs/pricing` and `docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image`, fetched 2026-10-08] — H, primary, same-day |
| **Gemini 3.1 Flash Image ("Nano Banana 2")** | $0.067 (1K), $0.101 (2K) | $0.151 | Batch: $0.034 / $0.050 / $0.076. Cheaper, faster tier; X5 already noted Flash Image accepts up to 4 character-reference images (vs. Pro's 5) | H, same source |
| **Gemini Nano Banana 2.1** | $0.0336 (1K), $0.0504 (2K) | $0.113 | Cheapest tier found; "improved multi-turn character consistency" named explicitly in its own model description | H, same source |

A character sheet (1 base pose, 6-8 expression/action variants, 2-3 "hero" characters plus 3-6 cheap-tier personas) costs **well under $5 total** at any of these tiers — this is a rounding error against the arena's $43-66 D-009 model budget and does not need its own line item; the risk is calendar days, not dollars. **New, high-value finding not in X5/U2:** `gemini-3-pro-image`'s model card lists **"Content Credentials (C2PA): Supported"** — i.e. Google's own Vertex-hosted model can embed C2PA provenance metadata in generated images natively, which is directly useful for section 4's hackathon-provenance question below. [GDK, same fetch] — H, primary.

**Step 2 — raster to SVG.** **[new this route, not covered by X5/U2]** For the hand-built SVG+CSS rig path (gokbase `kin` style), a Gemini-generated PNG character needs vectorizing before it can be rigged with CSS custom-property deformation the way `Pip.tsx` is. Confirmed via Context7 primary docs (`/visioncortex/vtracer`, fetched 2026-10-08):

- **VTracer** (Rust, MIT-licensed, actively maintained, O(n) tracing vs. Potrace's O(n²) fitting) is the current best open-source choice: handles full-color high-resolution input (unlike Potrace, which needs pre-binarized black/white input and is marked discontinued upstream per this route's web search). CLI: `vtracer input.png output.svg --preset poster --mode spline --filter-speckle 4 --color-precision 6 --max-colors 12 --simplify 1.5 --optimize 2`. Key flags for a clean, animatable character SVG: `--mode spline` (smooth curves, not polygon/pixel), `--max-colors` to force a small flat palette (fewer `<path>` fills to retarget for CSS theming later), `--simplify` to cut anchor-point noise, `--optimize 2` for shorthand/grouped output. A WASM binding (`vectortracer`, `/alanscodelog/vectortracer`) exists if the pipeline needs to run vectorization client-side/in a Node build step rather than shelling out to the Rust binary. [Context7 `/visioncortex/vtracer`, `cli.md`/`config.md`, fetched 2026-10-08] — H, primary repo docs.
- **Practical caveat (not in any source, inferred from the pipeline shape):** VTracer traces faithfully — it will not simplify a photorealistic Gemini-image render into clean, few-path cartoon line art the way a human illustrator would. It is the right tool for vectorizing an already-flat/stylized Gemini output (prompt Gemini explicitly for "flat vector illustration, limited color palette, clean outlines" rather than photorealistic rendering) or for a quick-and-dirty placeholder; it is the wrong tool to expect clean "Pip.tsx"-quality hand-drawn path data from a photographic source without manual cleanup afterward. Budget 1-2 hours of manual SVG cleanup per hero character even with vectorization, not zero.
- **Alternative for the hero characters specifically:** skip vectorization and hand-author SVG path data directly (gokbase's own approach — I7 confirmed `Pip.tsx` is "explicit path coordinates, no external asset import"), using the Gemini-generated character sheet only as a visual reference for a designer/illustrator (human or Claude-assisted) to trace by hand in an SVG editor. Higher quality, more hours, no licensing question at all (fully original art, per I7's existing finding on gokbase's own provenance).

**Step 3 — rig with CSS custom properties, following gokbase's `kin` pattern exactly (confirmed by a direct read of `fsm.ts` this route, not secondhand via I7).** Read directly: `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/fsm.ts` is a **pure function** `petStateFor(input: FsmInput): PetState`, ~100 lines, no state-machine library. Its exact `PetState` union (verbatim from the file): `greet | idle | attentive | approach (deprecated) | talk-sync | point (dormant) | think | error | sleep | celebrate | farewell`. Precedence is explicit and total: `dragging` (carried visual) > `pointSignal` (dormant) > one-shot windows (`celebrating` scoped to `status === 'listening'`, `farewelling` scoped to `status === 'ended'`) > the status switch table. Reduced-motion/mobile suppression collapses `celebrate -> attentive` and `farewell -> sleep` (lines 95-100) — the burst poses degrade to their *nearest still pose*, never to nothing. This is a small, easily-ported, zero-dependency pattern: the arena's own pet FSM can be a ~100-line file in the same shape, with `VoiceStateName` replaced by arena turn-states (I7 already proposed `investigator-typing, subject-thinking, subject-speaking, coach-flagging, evidence-released, finding-committed, trial-running`).

**Effort for pipeline A, 2-3 day budget:** day 1 generate + select character sheets (cheap, fast, parallelizable across personas); day 1-2 vectorize/hand-clean to SVG; day 2-3 port the ~100-line FSM pattern and wire `--kin-talk`-style CSS-variable amplitude deformation (already proven at 60fps per I7's TechnoMile frame-pacing cross-check). This is the **fastest, lowest-risk** path of the three and the only one with a direct, already-measured, already-accessible local precedent.

### 1.2 Pipeline B — Rive editor: state machines, data binding, free tier, licensing

X5/U2 already confirmed the *runtime API* (Data Binding superseding legacy State Machine Inputs; `useViewModel`/`useViewModelInstance*` hooks) and flagged Rive's commercial/editor licensing as an **open question**. **[resolves U2 open question #4]**

**Editor pricing and limits, confirmed this route (web search, cross-corroborated across 3 independent sources):**

| Plan | Price | What it includes |
|---|---|---|
| **Free** | $0/seat/month | 3 collaborative files, 1 project, 1 workspace, 10 MB per imported asset, limited AI Agent — **can design and animate, but exporting `.riv` for production use requires a paid plan** |
| **Cadet** | $9/seat/month | Unlimited files/projects, **`.riv` exports**, up to 3 seats — the plan a small team actually needs to ship |
| **Voyager** | $32/seat/month | Libraries, advanced AI Agent, $20/seat/month agent credits, hosted embed links |
| **Enterprise** | $120/seat/month | SSO, SOC2, custom runtime, subteam workspaces |

[WebSearch cross-corroborated across vijaytalksai.com "Rive Pricing Explained 2026", frontdeskreview.com "Rive pricing (2026)", rive.app's own `/blog/rive-s-new-9-mo-plan` and `/blog/no-cap-free-unlimited-personal-files-for-individual-creators`, fetched 2026-10-08] — M-H (vendor's own blog posts plus two independent third-party pricing-comparison pages agree on the tier structure; exact current price points should be re-checked at rive.app/pricing directly before budgeting, since Rive has changed its plan structure at least twice recently per the "new 9mo plan" post title). **Practical read for this build:** the free tier is sufficient for *designing and iterating* on a `.riv` rig during the 2-3 day build, but **exporting the finished `.riv` file for the actual demo requires at least Cadet ($9/seat for the month)** — a small, explicit, named cost (not found/flagged in X5 or U2, which only covered the runtime, not the editor's export gate). The **open-source runtime itself** (`@rive-app/react-canvas`/`react-webgl2`, the Context7-confirmed npm packages) has no licensing cost regardless of editor tier — only the *authoring* step is gated.

**Editor workflow, confirmed via Context7 primary docs this route (`/rive-app/rive-docs`, fetched 2026-10-08) — new detail beyond X5/U2's runtime-only coverage:**
- Export is **editor-UI-only** (Publish button or Export > For runtime), not CLI/API-automatable — relevant for a 2-3 day plan: budget a human-in-the-loop export step per character iteration, not a scriptable build pipeline.
- Only the **default artboard** and artboards explicitly marked **Components** are included in the exported `.riv`; everything else (including its animations/state machines) is silently excluded unless marked. A multi-character rig needs each character's artboard marked as a Component, or they will not ship.
- Binding is confirmed `autoBind: false` by default at the runtime layer, with an explicit `r.bindViewModelInstance(vmi)` call after resolving `r.viewModelByName(...)` / `vm.instanceByName(...)` — matches X5/U2's existing finding, now with the exact binding call shown.

**Fit:** best for the **coach pet or one hero subject character**, where the one-time $9-32 editor cost and the artist/rigger time are justified by reuse across every session; weak fit for generating 6-20+ bulk hidden-case personas (I7/X5's existing per-persona Gemini-portrait recommendation stays the cheaper choice there).

### 1.3 Pipeline C — LottieFiles / dotLottie: marketplace licensing

**[new this route]** U2 already covered the dotLottie *state-machine runtime API* (`stateMachineSetNumericInput` etc.) in depth; this route covers the **marketplace licensing** question the task specifically asks about:

- **Free marketplace animations** use the "Lottie Simple License": download, modify, redistribute, and use for **personal and commercial purposes, free of charge**, no attribution legally required (though LottieFiles' own help docs recommend visible attribution as good practice). [help.lottiefiles.com, "Animation licensing basics" and "Can I use a free animation... for commercial business use?", fetched 2026-10-08] — H, primary vendor source.
- **Premium marketplace animations** require a Premium/Pro/Enterprise LottieFiles subscription; the subscription's commercial-use terms cover them, with "extended commercial use rights" at Pro/Enterprise tier.
- **Practical rule, and the one actual risk:** "check the license on the individual animation's page before commercial use" — LottieFiles' own guidance is per-asset, not blanket; a public hackathon demo pulling a marketplace Lottie must screenshot/record that specific asset's license page as provenance (ties into section 4 below), not assume the whole marketplace is free.
- **Fit for this build:** marketplace Lottie/dotLottie assets are a reasonable **zero-build-time filler** for generic UI chrome (loading spinners, success checkmarks, simple icon-level motion) but a poor fit for the arena's own named characters (coach pet, subject personas) — a stock marketplace character cannot carry PRB-4's role-independence requirement or the arena's specific turn-state vocabulary without a custom state machine built from scratch, at which point it is equivalent effort to pipeline B with a different file format (U2's existing library comparison already covers the dotLottie-vs-Rive runtime trade-off; this route adds only that the *licensing* side favors Lottie for borrowed generic assets, not custom characters).

### 1.4 Summary option table (no decision made)

| Pipeline | 2-3 day fit | Cost | Licensing risk | Best for |
|---|---|---|---|---|
| **A — Gemini image + vectorize/hand-SVG + CSS rig (gokbase pattern)** | Best — fastest, already-proven locally | <$5 in model calls; $0 tooling (open runtime, VTracer is free/MIT) | Lowest — own art or Google-generated images with available C2PA credentials (section 4) | Bulk personas (hidden-case subjects) + a fast MVP coach pet |
| **B — Rive editor, data-bound state machine** | Workable if 1 person owns rigging full-time for 2 days | $9-32 editor seat-month; $0 runtime | Low (own `.riv`, open runtime) once the editor seat is paid | 1-2 hero characters (coach pet, or one flagship subject) where polish matters most |
| **C — LottieFiles/dotLottie marketplace** | Fast for filler, slow if custom characters are needed | $0 (free tier) to Premium subscription for premium assets | Medium — per-asset license must be checked and recorded, not assumed | Generic UI motion (spinners, checks), not named characters |

---

## 2. State model

### 2.1 Coach pet

Directly adoptable, ported from the gokbase `kin` FSM read in full this route (section 1.1, step 3) plus the task's named state list, mapped onto arena turn-events (I7's existing event vocabulary):

| Pet state | Trigger (arena event) | gokbase precedent |
|---|---|---|
| `idle` | No activity for N seconds, investigator has not yet acted | `idle` default |
| `listening` | Investigator is composing/typing a question | `attentive` (gokbase's `listening`/`connecting` status) |
| `thinking` | A coaching call is in flight (the complete-card request, KPI-4's 3s window) | `think` (gokbase's `tool-lookup`) |
| `noticing a contradiction` | A flag is produced with a quoted span | New pose, same *mechanism* as gokbase's dormant `point` (a model turn resolved with evidence) — this is the one state gokbase built but never activated on live data; the arena is the first live use case for it |
| `encouraging` | A neutral, evidence-cited follow-up was sent (reinforces reasoning quality, not outcome — I7's existing finding, restated) | No direct gokbase analog; nearest precedent is `celebrate`'s one-shot shape, scoped to the event rather than to session-start |
| `celebrating a good question` | The investigator's question passes the neutrality/evidence-grounding check at a high bar | `celebrate` (one-shot, ~1.6s hold per `ONE_SHOT_MS`, scoped to a specific event so a stale window can never leak) |
| `sleeping` | Idle beyond a threshold (gokbase uses 45s, `SLEEP_AFTER_MS`) or trial ended | `sleep` |

**PRB-4 invariant, mechanically enforced the same way gokbase enforces it:** `petStateFor`'s only inputs are turn-structure/status signals (`status`, one-shot windows, reduced-motion, dragging) — **nothing in the input shape reads dialogue sentiment, demeanor, or the subject's content.** The arena's pet FSM must keep that same invariant by construction: its `FsmInput` type should contain only turn-state enums and UI chrome flags, never a confidence/stress/sentiment field, so a demeanor-coded pet reaction becomes a type error, not a reviewable mistake.

### 2.2 Subject avatars

Per the task's named states (neutral idle, speaking, pausing) plus PRB-4's explicit requirement that style may vary by persona but **never by role**:

| Subject state | Trigger | Role-independence rule |
|---|---|---|
| `neutral idle` | Between turns, no audio/text output | **Must be bit-identical across every role assignment of the same persona.** A persona playing truthful in trial 1 and deceptive in trial 2 must render the exact same idle animation in both — role is a property of the *scenario*, never the *character* (direct quote of U2's own framing, re-affirmed here as the state-model rule, not just a design note) |
| `speaking` | Audio/text output streaming (voice sessions only, per direction doc section 9's development-cases-only scope) | Driven only by amplitude/viseme signal, never by the content of what is said |
| `pausing` | A brief gap mid-answer (voice) or a deliberate thinking beat (text) | Must not be confused with, or rendered more "nervous" than, speaking — this is exactly the demeanor-bias trap X5 section 5 already grounds in the research literature (nervousness is not correlated with deception, and can invert) |

**Build rule (mechanical, not aspirational), restated from U2 section 3 because it is the load-bearing rule for this specific route's deliverable:** the subject-avatar FSM's input type must contain *only* turn-structure events (composing, speaking, evidence-released) — never a sentiment/confidence signal derived from the dialogue. This is the same enforceable-by-type pattern as section 2.1.

---

## 3. Lip sync and speaking motion, per pipeline, with Gemini Live audio output

X5/U2 already established the core finding and it is **reconfirmed, not re-derived, this route**: Gemini TTS/Live returns no phoneme or viseme timing on any tier, so lip sync must be amplitude-driven or text-driven (we hold the script).

**New, concrete detail this route — Gemini Live's exact audio output contract** (GDK `answer_query`, fetched 2026-10-08, high confidence, primary docs across 6 corroborating document references): **16-bit PCM, little-endian, 24 kHz, mono.** The client is explicitly responsible for decode/buffer/playback; **GDK's own corpus confirms there is no API-level amplitude or lip-sync timing method** — this is not a gap in GDK's indexing, it is a confirmed absence in the Live API itself, consistent with X5's TTS finding and now confirmed for the Live (voice) path specifically, not just the batch-TTS path. **[resolves the audio-output half of X5's open question, specifically for the Live/voice path rather than batch TTS]**

Per pipeline, concretely:

- **Pipeline A (CSS-variable talk-sync, gokbase pattern):** feed the 24 kHz PCM16 buffer into a Web Audio `AnalyserNode`, compute RMS or `getByteFrequencyData()` once per animation frame, write it to a single CSS custom property (`--kin-talk`, confirmed in `fsm.ts`'s own docstring as "driven by TTS/Live RMS amplitude") read inline by the SVG's `transform`. Zero React re-renders, matches I7's already-measured 60fps pattern exactly. This is the **lowest-effort, lowest-risk** lip-sync path and the natural pairing with pipeline A's SVG rig.
- **Pipeline B (Rive):** bind the same amplitude float to a numeric View Model property (e.g. `mouthOpen`) every frame via `useViewModelInstanceNumber`, exactly as X5/U2 already specified — Rive does not read the OS `prefers-reduced-motion` or do amplitude extraction itself; the host app computes both and pushes them in.
- **Pipeline C (dotLottie):** same shape, via `stateMachineSetNumericInput('talkLevel', amplitude)` each frame (U2's confirmed API).
- **Text-driven alternative (any pipeline), since the script is known in advance for text-mode trials:** map the known utterance text to a coarse viseme/phoneme sequence locally and drive discrete mouth shapes on a timer keyed to estimated word timing, rather than true audio amplitude — cheaper to make *look* intentional (discrete shapes read as more "spoken," less "vibrating") but desyncs if actual TTS/Live playback timing drifts from the estimate. Not needed for pipeline A's amplitude-only CSS approach, which has no sync risk because it reads the actual playing audio continuously.

**No pipeline needs an ASR/forced-alignment step** given the amplitude-only default is already proven (I7) and acceptable for a hackathon-scale demo; reserve the Duolingo-style ASR-to-phoneme pipeline (X5's original framing) only if a future pass specifically wants frame-accurate mouth shapes, which is not justified by the 2-3 day budget.

---

## 4. Licensing and provenance for a public hackathon demo; accessibility

### 4.1 Licensing and provenance

**New, directly relevant finding: Gemini 3 Pro Image's C2PA support.** The model card confirms "Content Credentials (C2PA): Supported" for `gemini-3-pro-image` on Vertex [GDK, same fetch as section 1.1] — this means Gemini-generated character images **can carry embedded, standards-based provenance metadata out of the box**, which is the single strongest, lowest-effort answer available to "prove this was AI-generated, not a real person" for a sponsor (Unissant, serving federal law-enforcement/DHS-adjacent clients) that will scrutinize synthetic-content claims closely (EX-4 is already load-bearing for exactly this reason). Verify at build time whether the Vertex SDK call path used actually preserves/exposes the C2PA manifest (model-card "supported" does not by itself confirm the exact API flag or default-on behavior) — treat as a build-time check, not yet a settled fact.

**2026 regulatory context, newly surfaced this route (not previously researched in X5/U1/U2/U3):**
- **EU AI Act Article 50**: AI-generated/AI-manipulated images used in many public-facing contexts must be clearly labeled as AI-generated, in force **from 2026-08-02** — already in effect as of this report's date. Not directly binding on a US hackathon demo, but a clean precedent for the exact UI pattern the arena already needs for EX-4 (a visible, standing "these characters and cases are synthetic" disclosure).
- **US**: generative-AI providers are expected to embed latent disclosures (provider name, system name, version) in generated content metadata; **California AB 853** (AI transparency law) takes effect **2026-08-02** for certain large online platforms, with further provenance rules from early 2027. Not applicable to a small non-commercial hackathon build, but the direction (metadata-level provenance becoming a default expectation, not an edge case) supports keeping whatever C2PA/provenance metadata Gemini attaches intact through the pipeline rather than stripping it at the vectorization step.
- **Copyright ownership**: a prompt alone does not establish copyright ownership, and purely machine-generated material is not protected as human-authored work under current US copyright guidance — **not a blocker** for a hackathon demo (no one is asserting copyright over the characters), but relevant if the owner later wants to protect the character designs commercially; flag for the owner, not resolved here.
[WebSearch: capcut.com "Licensing and Copyright in AI-Generated Images... Early 2026," cepic.org "CEPIC guidelines on provenance and trusted content," cliprise.app "copyright ai art legal guide commercial use 2026," rewarx.com "Your AI Hero Image Is a Legal Liability Starting This Month" — fetched 2026-10-08] — M (aggregator/legal-explainer blogs, not primary statute text; the EU Article 50 date and AB 853 date should be verified against the actual statute/regulation text before the owner relies on either as a hard compliance deadline — flagged, not independently confirmed against primary legislative sources in this route).

**Practical provenance checklist for the demo:**
1. Keep a per-character manifest: which model generated it (model ID + date), the prompt/seed used, and whether C2PA metadata survived the vectorization step (VTracer and hand-tracing both strip raster metadata — if C2PA provenance matters for the demo, keep the original Gemini PNG alongside the derived SVG as the provenance record, not just the SVG).
2. For any LottieFiles/marketplace asset used as filler (section 1.3): record that specific asset's license-page screenshot/URL at the time of use.
3. For gokbase-pattern hand-authored SVG art (pipeline A, step 2 alternative): no licensing question exists (original work), but keep authorship attribution internal to the repo for the owner's own records.
4. Surface the existing EX-4 "synthetic-only" statement (already drafted in U3 section 4's table: "This is a training simulation. All cases are made up — a simulated score is not a finding about a real person.") near any character the trainee interacts with, not only in onboarding — this is already a locked requirement, restated here only because the character pipeline is exactly where "looks like a real government interrogation" risk is highest for a sponsor serving ICE/CBP/DHS.

### 4.2 Accessibility

Not re-researched here — I7 and U2 already demonstrated two complete, tested, working implementations (gokbase's `prefers-reduced-motion` collapse-to-stills plus explicit low-motion-character labeling, confirmed again in this route's own direct read of `fsm.ts`'s `suppress` branch at lines 84/95/98; TechnoMile's reduced-motion-collapses-to-caption pattern). The only addition specific to this route's character-asset scope:

- **Alt text**: every character SVG in the gokbase pattern already carries `role="img" aria-label="..."` per-art-file (I7's existing finding, confirmed structurally sound for screen readers that traverse hidden/decorative trees) — the arena's ported characters should keep this per-character, not per-component, so a screen-reader user hears which character is on screen, not just "an image."
- **Captions**: not a character-pipeline concern per se, but directly coupled to it — whichever avatar pipeline is chosen, its "speaking" state and any caption/transcript UI must stay in sync (the direction doc's own playback-grounded-transcript finding, section 9, already governs this at the transcript level; the avatar's speaking-pose timing should follow the same played-audio-driven source of truth, not a separate estimate, so a captioned utterance and an animated mouth never desync in a way that misleads a reader relying on captions alone).
- **Reduced motion for the pet specifically**: gokbase's own "low-motion character labeled in the UI" pattern (I7, `PetPicker.tsx:194-207`) is a deliberate accessibility-by-choice option beyond the OS-level `prefers-reduced-motion` fallback — worth carrying forward if the arena ships more than one pet-style option, since it lets a user choose calm motion without needing to change a system-wide OS setting.

---

## 5. Open questions

1. Does the Vertex SDK call path actually surface/preserve Gemini 3 Pro Image's C2PA Content Credentials by default, or is it an opt-in flag? Not confirmed at the API-parameter level in this route — build-time check needed before relying on it as the EX-4/provenance answer.
2. Rive's exact current editor price points (Cadet/Voyager/Enterprise figures above) should be re-verified directly at rive.app/pricing before budgeting — the vendor has changed its plan structure recently per its own blog post titles, and this route's figures come from third-party pricing-comparison pages plus the vendor's blog, not a single current pricing page fetch.
3. EU AI Act Article 50 and California AB 853's exact applicability/dates were taken from legal-explainer aggregator sites, not primary statute text — re-verify before citing either as a hard compliance fact to the owner or judges (neither is likely binding on this specific hackathon build, but the dates should not be repeated as settled without a primary-source check).
4. VTracer's output quality on an actual Gemini-generated character image (vs. this route's documentation-only confirmation of its CLI/config surface) was not tested hands-on in this route — the "budget 1-2 hours of manual cleanup" estimate in section 1.1 is an inference from the tool's documented tracing behavior, not a measured result.

## 6. Contradictions / tensions

- **Pipeline A's near-zero cost and already-proven local precedent vs. the owner's "amazing, stunning" bar.** U2/U3 already flagged this tension at the aesthetic level (restraint vs. richness); this route adds the operational version — the cheapest, fastest, lowest-risk pipeline (A) is also the one with the smallest visual ceiling of the three, and the richest-ceiling pipeline (Rive, B) is the one with both a real dollar cost and an editor-UI-only (non-automatable) export step that eats build-calendar time disproportionately for a 2-3 day window. A plausible resolution (not a decision made here): pipeline A for the bulk/hidden-case personas and the MVP pet, pipeline B reserved for exactly one hero character if calendar time allows after the slice gate (Oct 18) — consistent with `02-direction.md` section 3.3's own cut-order (pets and agents-at-work animation are both already on the "cut first" list).

---

## Query log

**Google web search (WebSearch) — 5 queries, mode "standard":**
1. Rive editor pricing free tier teams plan 2026 commercial license
2. Gemini 3 Nano Banana Pro image generation pricing per image Vertex AI 2026
3. raster to SVG vectorization tool vtracer potrace character illustration 2026 open source
4. LottieFiles marketplace license commercial use terms animation 2026
5. AI generated image character licensing hackathon demo provenance disclosure rules 2026

(Floor was >=5; ran exactly 5, each load-bearing and non-overlapping with X5/U1/U2/U3's own query logs; no 403s, no "extended" mode needed.)

**Google Developer Knowledge MCP — 2 queries (floor >=2, met exactly):**
1. `search_documents`: "Gemini image generation pricing Nano Banana Pro per image Vertex AI" — returned the primary pricing tables for `gemini-3-pro-image`, `gemini-3.1-flash-image`, and `gemini-nano-banana-2.1`, plus the `gemini-3-pro-image` model card (region, token limits, C2PA support)
2. `answer_query`: "What audio format and sample rate does the Gemini Live API return for output audio, and how can client code derive amplitude or lip-sync timing from it in a browser?" — confirmed 16-bit PCM/24kHz/mono and the confirmed absence of any API-level amplitude/lip-sync method, across 6 distinct corroborating document references

**Context7 (via `npx ctx7@latest` CLI; MCP server `context7` reported down per this session's connection-failure notice, so the CLI fallback was used, consistent with X5/U2/U3's own convention) — 2 libraries, 4 calls:**
1. `library "Rive" "Rive editor export .riv file state machine data binding workflow for a character rig"` → resolved to `/rive-app/rive-docs` (chosen over `/websites/rive_app` for being the documentation-specific ID with the higher snippet count)
2. `docs /rive-app/rive-docs "Rive editor workflow: artboards, state machines, data binding view models, exporting .riv files, importing SVG/vector art into the editor, timeline authoring for a character rig"` — returned the Publish/Export mechanism, the Component-artboard export-inclusion rule, and the confirmed `autoBind: false` + `bindViewModelInstance` binding call
3. `library "vtracer" "convert PNG raster image to SVG vector CLI options character illustration"` → resolved to `/visioncortex/vtracer`
4. `docs /visioncortex/vtracer "CLI usage, color mode, filter_speckle, corner_threshold, segment_length options for converting a PNG character portrait into a clean layered SVG for animation rigging"` — returned the full CLI flag table and `Config` struct defaults

(Floor was >=2; ran 2 libraries, 2 calls each, both load-bearing and not previously fetched by X5/U1/U2/U3, which covered Rive's *runtime* API but not its editor export mechanics, and did not cover vectorization tooling at all.)

**Files read (not web/GDK/Context7) — 8, all specified as required reading by the task or found necessary mid-route:**
1. `docs/research/synthesis/02-direction.md` (full file; sections 0, 2, 3, 6, 9 specifically per the task)
2. `docs/research/external/X5-interrogation-ui-avatars-voice-pets.md` (full)
3. `docs/research/internal/I7-ui-lift-map-pets-agents-at-work.md` (full)
4. `docs/research/ui/U1-claude-skills-and-design-tools.md` (full — sibling batch route, read to avoid duplicating its skills/tools inventory)
5. `docs/research/ui/U2-speaking-avatars-and-pets.md` (full — sibling batch route, read to avoid duplicating its avatar/lip-sync-library survey)
6. `docs/research/ui/U3-motion-system-and-pipeline-visuals.md` (full — sibling batch route, read to avoid duplicating its motion-library/pipeline-visual survey)
7. Directory listing of `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/` (confirmed the files I7 already inventoried are present at the given path, per the task's explicit "read it" instruction)
8. `/Users/balla/Desktop/satvik/gokbase-org/recruiter-frontend/src/sections/knowledge-base/public/voice/kin/fsm.ts` (full, direct read — the task specifically named this directory as required reading; read directly rather than relying solely on I7's prior summary, to get the exact `PetState` union, precedence order, and reduced-motion suppression lines quoted in section 1.1/2.1/4.2 above)

No `.env` files were opened; no files were written outside this report's path; nothing was installed (VTracer/Rive/LottieFiles were researched via Context7/web docs only, not installed on this machine).
