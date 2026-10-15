# Precinct interface themes

## Intent

The precinct has two explicitly selectable interface treatments. **Office (original)** stays the default: the existing warm-paper, forest-green office presentation. **Studio** is an alternate, focused dark interface for reading and working within the same training world.

The choice is under **Comfort and accessibility settings → Interface theme**. It uses native, labeled radio buttons. Changing it is immediate and reversible. It remains selected through station visits, dialog dismissal, case selection, and session changes within this mounted route. A new route visit or page reload returns to Office. The setting does not write storage, contact an API, alter recordings, or imply a saved account preference. The picker explains that lifetime.

## Reference and adaptation

The owner supplied the [VoltAgent Framer design analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/framer/DESIGN.md), read in full via its [raw source](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/framer/DESIGN.md) on 2026-10-15.

Studio adapts its near-black surfaces, white primary pills, close-set display headings, restrained blue interaction signals, and a single atmospheric welcome card. It is an Arena interface rather than a reproduction of Framer's marketing site. No text, brand assets, illustrations, or proprietary font files from that reference are copied. The existing Geist/Inter/system font stack is reused; no bundled font binaries were found and no remote fonts are fetched.

Training needs take priority over marketing conventions: body text has generous leading, controls retain clear boundaries, safety copy remains readable, and large-text mode relaxes display tracking. High contrast, reduced motion, and forced colors remain separate preferences. Blue marks focus, links, and selection; findings remain equally weighted.

## Studio tokens

Values live only inside `.precinct-root[data-theme="studio"]` in `web/src/styles/precinct-theme.css`.

| Role | Normal Studio | High-contrast Studio |
| --- | --- | --- |
| Canvas | `#09090b` | `#000000` |
| Reading surface | `#141416` | `#090909` |
| Raised surface | `#202024` | `#171717` |
| Hover surface | `#2c2c32` | `#272727` |
| Main text / primary pill | `#fafafa` | `#ffffff` |
| Secondary text | `#b9b9c2` | `#dedee3` |
| Content divider | `#414149` | `#8b8b95` |
| Control boundary | `#7b7b85` | `#b9b9c2` |
| Focus / link / selection | `#66bcff` | `#66bcff` |

Content dividers are deliberately quieter than interactive boundaries. Active fields retain their background with a 3px blue focus outline and 4px offset. Main and secondary body text target at least 4.5:1 against each flat surface; interactive boundaries target 3:1. `precinct-theme.test.ts` computes these contracts from the shipped CSS values. This checks flat token pairs, not pixels, every inherited component, or background composition.

## Component direction

- **World chrome:** a restrained dark header; a compact objective panel with a clear title, explanation, and progress; an opaque safety footer; keyboard hints, map, interact, pause, and seat actions remain available. Labels are larger than the original small HUD labels.
- **Welcome:** a self-contained dark showcase card, one static low-intensity violet/magenta/orange atmosphere, and a white entrance pill. No gradient is added to case content, scene geometry, or status indicators. High contrast removes the decorative atmosphere.
- **Dialogs:** keep the existing native dialog, sticky title/close row, scrolling behavior, and focus return. Use a 20px outer radius and a consistent sans-serif title hierarchy. No new overlay or portal is introduced.
- **Controls:** primary pills are white with dark text; secondary actions are charcoal with visible boundaries. Text actions use blue and an underline. Principal targets are at least 44px tall. Native radios and checkboxes remain native.
- **Documents:** reuse the dossier's public content, tabs, reading-scale control, and notebook behavior. Paper surfaces become dark with modest stacked depth. The existing source IDs, citations, and safety wording remain unchanged.
- **Interview:** separate controls from transcript/evidence by surface depth. Preserve every availability rule, disabled reason, assessment boundary, recorded-run disclaimer, and finding guard. All finding categories share the same text tokens.
- **Observation:** theme the monitor frame, controls, and captions; retain the donor SVG scenes and their caller-owned motion. No scene recoloring from case truth is possible through the theme.
- **Replay and capture:** cover slice-five status, errors, timeline controls, and notices. Never suppress partial-capture warnings, absence-of-original-audio wording, or fidelity limits. Errors use a strong edge plus their existing explanatory text.

## Implementation boundaries

`PrecinctThemeControl.tsx` is a controlled, content-only component. `PrecinctRoute.tsx` owns one `useState<PrecinctTheme>("office")`, passes its setter to that picker, and exposes `data-theme` on the existing root. No keyed wrapper, Canvas remount, second camera, clock, lifecycle effect, storage access, or network write is added.

The original stylesheet and route behavior remain intact. Studio styles are scoped overrides, imported after the route's existing stylesheet imports. Theme-independent CSS is limited to the new picker. Existing wire types, generated validators, session reducers, recording contracts, world manifest, geometry, materials, audio, and assets are not changed.

The sponsor ground rule is still rendered from the existing `EX4_TEXT` constant without edits:

> All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.

Nervousness, demeanor, accent, and stress remain excluded from evidence. Themes do not receive hidden case labels or change any behavior by truth/deception.

## Regression coverage and verification status

New tests:

- `web/src/components/precinct/PrecinctThemeControl.test.tsx`: native control labels/descriptions, parent-controlled selection, independent instances.
- `web/src/routes/PrecinctRoute.theme.test.tsx`: original default, renderer-readiness guard, unchanged Canvas/clock/manifest identity, no persistence/network side effects, choice retention through navigation and case selection, earned-progress retention, native cancel/focus return, new-visit reset, both comfort modes, exact safety copy, pending-assessment withholding, and accessible fallback under both themes.
- `web/src/styles/precinct-theme.test.ts`: body-text, control-edge, and focus contrast calculated from the actual CSS token declarations.

**At initial handoff, all new tests, lint, types, build, browser checks, and screenshot review are unrun.** Execution is deliberately held for the shared machine's sole-CPU queue. Source review alone is not a visual or accessibility pass. The integration handoff will record later results separately when execution is allowed.

Required browser review before release:

1. At 1440×900 and 1920×1080, compare Office and Studio welcome, settings, world HUD, reception, dossier, interview, observation, and replay/capture. Office should match its pre-change presentation apart from the new settings picker.
2. Navigate the picker by keyboard, close with Escape, and confirm focus returns. Switch repeatedly during a station visit and after case selection. Do not lose draft, notebook, session, progress, seat, camera, or playback state.
3. Inspect 200% zoom, larger text, high contrast, reduced motion, and forced colors. Check focus clipping, select options, disabled text, document tables, errors, and every safety notice. Check compact layouts at 700px and below; no essential action should be inaccessible.
4. Check actual computed contrast, including the welcome gradient and image-backed surroundings; run the existing axe/browser suite. The token tests cannot establish conformance alone.
5. Exercise both themes with offline fallback, pending assessment, recorded interviews, incomplete capture, and a published debrief. No new truth claim or access path may appear.

No screenshots or full quality pass are claimed until those checks run against the integrated code.
