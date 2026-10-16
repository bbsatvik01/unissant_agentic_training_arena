"""Read-only inspection of the staged editable source; writes only a QA JSON report."""

import json
import sys
from pathlib import Path

import bpy


def require(condition: bool, message: object) -> None:
    """Keep validation active even when Python assertions are optimized away."""
    if not condition:
        raise ValueError(message)


EXPECTED_LABEL_COUNT = 40

root = Path(__file__).resolve().parent.parent
bpy.ops.wm.open_mainfile(filepath=str(root / "assets-src/northstar-precinct.blend"))
bpy.context.view_layer.update()
limits = {
    "Corridor entry direction": 4.4,
    "Primary precinct name": 6.1,
    "Primary precinct subline": 6.1,
    "Reception front label": 3.8,
    "Case board title": 8.3,
    "Case board subtitle": 8.3,
    "Mission card title": 2.24,
    "Mission card summary": 2.24,
    "Mission status": 2.2,
    "Recognition heading": 3.3,
    "Recognition subtitle": 3.3,
    "Award caption": 0.8,
    "Hall wayfinding text": 1.86,
    "Interview sign typography": 2.98,
}
labels = []
for ob in bpy.context.scene.objects:
    if ob.type != "FONT":
        continue
    limit = next((width for prefix, width in limits.items() if ob.name.startswith(prefix)), None)
    if " sign number" in ob.name or " sign label" in ob.name:
        limit = 0.62
    if limit is None:
        continue
    width = max(v[0] for v in ob.bound_box) - min(v[0] for v in ob.bound_box)
    height = max(v[1] for v in ob.bound_box) - min(v[1] for v in ob.bound_box)
    require(width <= limit + 1e-5, (ob.name, width, limit))
    require("Bold" in ob.data.font.name, (ob.name, ob.data.font.name))
    require(ob.data.font.packed_file is not None, (ob.name, "font not packed"))
    labels.append(
        {
            "name": ob.name,
            "body": ob.data.body,
            "font": ob.data.font.name,
            "fontPacked": True,
            "width": round(width, 6),
            "maxWidth": limit,
            "height": round(height, 6),
            "nominalSize": round(ob.data.size, 6),
        }
    )
require(len(labels) == EXPECTED_LABEL_COUNT, len(labels))
report = {
    "passed": True,
    "blenderVersion": bpy.app.version_string,
    "labelCount": len(labels),
    "allLabelsFitWidth": True,
    "allBoldFacesPacked": True,
    "labels": labels,
}
(root / "docs/ui-v2/signage-source-audit.json").write_text(json.dumps(report, indent=2))
sys.stdout.write("SIGNAGE_SOURCE_AUDIT " + json.dumps({k: v for k, v in report.items() if k != "labels"}) + "\n")
sys.stdout.flush()
