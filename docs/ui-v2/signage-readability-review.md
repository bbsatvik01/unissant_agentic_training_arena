# Precinct signage readability repair

Status: Blender source/GLB integrated and geometry/manifest/source-fit checks passed. Integrated browser visual acceptance is still pending. This review concerns only the original Northstar precinct in `unissant_agentic_training_arena`.

## Finding

The fragmented room and case-board lettering is primarily undersampled vector text. The authored GLB is not missing the relevant glyph triangles, and the inspected text faces are planar, outward-facing, and separated from their support geometry. The poor legibility is strongest in small, thin strokes at low resolution. Increasing depth alone would not fix that.

Evidence:

- `web/src/components/precinct/PrecinctCanvas.tsx` selects low tier for detected software renderers. The low tier uses DPR 0.75 and `antialias: false`, with camera FOV 66°. A 1920 × 1080 viewport therefore renders the world at 1440 × 810 before upscaling.
- The original `text` helper in `assets-src/build_precinct.py` used regular DejaVu Sans typography. The nominal font size does not equal the exported cap height.
- The runtime optimization at `assets-src/build_precinct.py` and `assets-src/export_runtime.py` flattens text to planar, low-resolution curves. Planarity is efficient and is retained; it is not itself a z-fighting defect.
- `docs/ui-v2/screenshots/slice-01/02-entered-first-person-1920x1080.png` visibly loses narrow horizontal and vertical strokes in the case subtitle, card headings and corridor signs, while the larger fieldwork title survives.
- The original GLB has 116,034 triangles in 38 material meshes, 5,484,180 bytes, and no textures. No geometry compression extension or unstable text transform is involved.

Measured from the runtime GLB, not inferred from the script's font-size values:

| Label | Original cap height | Backing gap | Cap pixels at 5 m / 8 m, low tier |
| --- | ---: | ---: | ---: |
| Fieldwork title | 126.96 mm | 25 mm | 15.84 / 9.90 |
| Case-board subtitle | 46.84 mm | 30 mm | 5.84 / 3.65 |
| First case-card title | 45.97 mm | 7 mm | 5.73 / 3.58 |
| Interview door number | 52.53 mm | 5 mm | 6.55 / 4.10 |
| Interview door label | 32.25 mm | 5 mm | 4.02 / 2.51 |
| Hall “Curiosity” label | 59.10 mm | 6 mm | 7.37 / 4.61 |

The pixel estimates use a 1080-pixel viewport, 0.75 DPR, 66° vertical FOV and camera-space depths of 5 and 8 meters. They are reference distances, not a claimed reconstruction of the exact screenshot camera. Door lettering is additionally compressed horizontally when seen obliquely. Full coordinates, triangle counts, normals and planarity are in `signage-baseline-metrics.json`.

## Source repair

Only high-priority authored wayfinding changes:

1. Use the installed DejaVu Sans Bold face for important signs and case cards. The existing permissive DejaVu/Bitstream license covers this face; retain `assets-src/FONT_LICENSE.txt`. Both fonts are packed in the editable Blender file.
2. Raise the nominal size of small wayfinding/card text approximately 1.5–1.75×. Main titles grow more conservatively. Door numbers become 0.20 m nominal and labels 0.13 m nominal; the case-board subtitle becomes 0.18 m and case-card headings 0.18 m.
3. Uniformly fit each important label to the existing plaque's usable width before saving the source. Long labels keep their original wording and do not overflow the plaque. Decorative monitor microtext stays unchanged.
4. Use ivory for the fieldwork and recognition subtitles, improving their contrast against the existing petrol backing.
5. Increase several already-valid face gaps to at least 10 mm as a conservative safeguard: door letters 10 mm, card title 12 mm, hall letters 12 mm, shared panel lettering 10.5 mm. No backing object moves.

The fix preserves original names, layout, scene authorship, semantic source objects, materials, source paths, scene scale and narrative text. It adds no texture, web dependency, shader, rendering pass or service. It does not raise low-tier DPR. Export confirms the same 38 material meshes and zero textures. The revised GLB has 116,267 triangles (+233, about 0.2%) and 5,668,084 bytes (+183,904, about 3.35%).

## Implementation files

- `assets-src/build_precinct.py`: reproducible source change
- `assets-src/audit_signage.py`: lightweight read-only GLB typography measurement
- `assets-src/check_signage_preservation.py`: compares all manifest fields except measured performance
- `docs/ui-v2/signage-baseline-metrics.json`: original GLB measurements
- `docs/ui-v2/signage-readability-review.md`: this review

The original font license remains in `assets-src/FONT_LICENSE.txt`. The baseline manifest can be recovered from commit `5279845` for a preservation comparison; it is not duplicated in the runtime assets.

## Checks completed

- All authoring/audit Python files compile.
- AST comparison confirms all 255 non-typography geometry, collision and navigation constructor calls are unchanged, including their arguments and ordering.
- All six sampled original text regions are planar with outward normals; none intersects its own support face.
- Source `.blend`, runtime GLB and manifest are committed together so the editable model matches the exported scene.
- Rebuilt with Blender 4.3.2 in 16 seconds using two threads and `--skip-renders`.
- Standard asset/navigation validation passed: 121 colliders, 12 hotspots, 30 navigation nodes, 11 rooms; every node reachable and all checked routes clear for the 0.28 m capsule.
- Every non-performance manifest field is identical to the baseline, not just navigation.
- Source audit passed for all 40 revised labels: each fits its existing width budget and each uses packed DejaVu Sans Bold.
- Revised source is 1,235,259 bytes; GLB SHA-256 is `dc6c19271bf1c7c93717240ae125029706823747d9945ad34a3aba2c7fd294b8`.
- Attempted local headless Chromium visual comparison did not launch: the process sandbox denied its local socket, and the supported escalation failed during sandbox setup. No screenshot was produced. All comparison/export/server processes were stopped afterward.

## Reproduction and deferred visual acceptance

The following commands reproduce the measured result (save the prior manifest from `5279845` as `baseline-manifest.json` outside the repository):

    blender --background --threads 2 --factory-startup --python assets-src/build_precinct.py -- --skip-renders
    python assets-src/validate_manifest.py
    python assets-src/check_signage_preservation.py baseline-manifest.json web/public/world/precinct-manifest.json
    python assets-src/audit_signage.py web/public/world/precinct.glb > docs/ui-v2/signage-repaired-metrics.json
    blender --background --threads 2 --factory-startup --python assets-src/inspect_signage_source.py

Acceptance requires:

- The `.blend`, GLB and manifest export successfully and the standard manifest validator passes.
- Every manifest field outside `performance` remains exactly equal to the baseline, preserving every collider and navigation coordinate and the existing provenance.
- All important lettering remains inside its existing backing. Inspect the editable source bounds after fitting, including long door labels and both subtitles.
- Original material-group count stays 38; textures stay zero; GLB remains below 25 MB and 150,000 triangles.
- At low tier, compare an equivalent first-person lobby view and a near-interview-door view. Check full strokes in fieldwork/card headings and legible door numbers/labels on approach. Very distant room labels are not expected to be readable across the entire building.
- Verify a normal hardware-rendered tier too; do not use its result as a substitute for low-tier acceptance.

Integrated browser acceptance is required before declaring the repair visually verified. The reception smoke uses this exported scene; its screenshots and visual review are recorded with slice 02. A normal hardware-rendered tier has not yet been tested.


## Rebuilt measurements

| Label | New cap height | New gap | Low-tier cap pixels at 5 m |
| --- | ---: | ---: | ---: |
| Fieldwork title | 168.01 mm | 25 mm | 20.96 |
| Case-board subtitle | 84.00 mm | 30 mm | 10.48 |
| First case-card title | 84.00 mm | 12 mm | 10.48 |
| Interview door number | 93.34 mm | 10 mm | 11.64 |
| Interview door label | 59.59 mm | 10 mm | 7.43 |
| Hall “Curiosity” label | 102.67 mm | 12 mm | 12.81 |

These measurements show improved sampling headroom and do not replace an integrated low-tier screenshot. See `signage-repaired-metrics.json` and `signage-source-audit.json` for the full machine-readable evidence.
