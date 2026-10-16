# Portable preview: licensing decision still open

Checked 16 October 2026 UTC. This is a packaging decision record, not legal advice or acceptance of new terms.

## Verified dependency boundary

The inherited web package pins `gsap@3.15.0` and `@gsap/react@2.1.2`. Direct imports occur in four existing files:

- `web/src/components/world/CameraRig.tsx`: camera flights and drift, cancellation/arrival callbacks.
- `web/src/components/world/Hub.tsx`: focus/hover card lift and scale.
- `web/src/components/world/moments.tsx`: session-clock seekable document/pin/seal timelines and focus/fade effects.
- `web/src/components/overlay/DebriefScene.tsx`: debrief presentation/count animation.

The production build includes GSAP in a lazy WorldRoute chunk. The exercised Studio precinct stationary sample did not request that chunk; this does not certify every app route. Trimming it out of a full build would create an incomplete package and is not a licensing solution.

## Terms and the brief

The [official GSAP standard license](https://gsap.com/community/standard-license/) permits commercial web use without a charge, but has restrictions concerning competing visual animation-building tools and preserving proprietary notices, and incorporates Webflow terms. The page lists an effective date of 30 April 2025 and modification date of 30 May 2025. These custom terms are not a blanket MIT/open-source license. The brief suggests GSAP but separately requires approval before non-open licensing; the owner’s bounded decision is pending.

Choices: approve retaining only these inherited packages under the linked terms, or replace their uses with existing open-licensed/browser primitives. A source review estimates 2–4 focused engineering hours for replacement, plus unchanged gates and real legacy replay/camera QA. That estimate is not a completed migration or commitment to begin one.

If retention is approved, the final emitted bundle’s notice preservation must be checked. Source packages have notices; inspecting minified output did not establish their retention. A proposed notice inventory is incomplete and not certified. No portable archive has been built or delivered, no terms have been accepted, and no new paid service or Mac access is involved. Local performance diagnosis continues independently.
