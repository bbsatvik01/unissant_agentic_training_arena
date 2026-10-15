"""Check collider IDs, navigable graph, paths and GLB size/triangle budget."""

import hashlib
import json
import math
import struct
import sys
from pathlib import Path


def require(condition: bool, message: object) -> None:
    """Keep validation active even when Python assertions are optimized away."""
    if not condition:
        raise ValueError(message)


GLTF_VERSION = 2
MAX_ASSET_BYTES = 25_000_000
MAX_TRIANGLES = 150_000
COLLISION_FLOOR = 0.2
COLLISION_CEILING = 1.8

source_root = Path(__file__).resolve().parent
root = source_root.parent / "web/public/world"
m = json.loads((root / "precinct-manifest.json").read_text())
require(m["asset"] == "precinct.glb", "Manifest must name the runtime file loaded by the app: precinct.glb")
require(not m.get("assetPending", False), "Manifest is an unfinished preview")
require(m["coordinates"]["units"] == "meters", "Manifest units must be meters")
require(
    m["coordinates"]["runtimeUp"] == "+Y" and m["coordinates"]["runtimeNorth"] == "-Z",
    "Expected runtime +Y up and -Z north",
)
ids = [c["id"] for c in m["colliders"]]
require(len(ids) == len(set(ids)), "Duplicate collider IDs")
nodes = {n["id"]: n for n in m["navigationNodes"]}
errors = []
for a in nodes.values():
    for bid in a["neighbors"]:
        require(bid in nodes and a["id"] in nodes[bid]["neighbors"], "Broken reciprocal graph edge")
        b = nodes[bid]
        if a["id"] > bid:
            continue
        p, q = a["position"], b["position"]
        steps = max(1, int(math.dist(p, q) / 0.06))
        for i in range(steps + 1):
            t = i / steps
            x = p[0] + (q[0] - p[0]) * t
            z = p[2] + (q[2] - p[2]) * t
            hit = None
            for c in m["colliders"]:
                lo, hi = c["min"], c["max"]
                if hi[1] < COLLISION_FLOOR or lo[1] > COLLISION_CEILING:
                    continue
                if lo[0] - 0.28 < x < hi[0] + 0.28 and lo[2] - 0.28 < z < hi[2] + 0.28:
                    hit = c["id"]
                    break
            if hit:
                errors.append((a["id"], bid, hit))
                break
require(not errors, f"Blocked navigation links: {errors}")
for h in m["hotspots"]:
    x, _, z = h["position"]
    for c in m["colliders"]:
        lo, hi = c["min"], c["max"]
        if hi[1] < COLLISION_FLOOR or lo[1] > COLLISION_CEILING:
            continue
        require(
            not (lo[0] - 0.28 < x < hi[0] + 0.28 and lo[2] - 0.28 < z < hi[2] + 0.28),
            f"Hotspot {h['id']} overlaps {c['id']}",
        )

for f in m["colliders"]:
    if f["kind"] != "furniture":
        continue
    for w in m["colliders"]:
        if w["kind"] != "wall":
            continue
        require(
            not all(f["min"][i] < w["max"][i] and f["max"][i] > w["min"][i] for i in range(3)),
            f"Furniture {f['id']} overlaps wall {w['id']}",
        )
seen = {"arrival"}
todo = ["arrival"]
while todo:
    for nxt in nodes[todo.pop()]["neighbors"]:
        if nxt not in seen:
            seen.add(nxt)
            todo.append(nxt)
require(len(seen) == len(nodes), "Disconnected navigation graph")
b = (root / m["asset"]).read_bytes()
require(b[:4] == b"glTF", "Invalid GLB magic")
require(struct.unpack_from("<I", b, 4)[0] == GLTF_VERSION, "Expected glTF 2.0")
require(struct.unpack_from("<I", b, 8)[0] == len(b), "Invalid GLB length")
n, t = struct.unpack_from("<II", b, 12)
g = json.loads(b[20 : 20 + n])
tris = sum(g["accessors"][p["indices"]]["count"] // 3 for mesh in g["meshes"] for p in mesh["primitives"])
require(len(b) < MAX_ASSET_BYTES, "Runtime file exceeds 25 MB")
require(tris < MAX_TRIANGLES, "Runtime geometry exceeds 150k triangle target")
require(m["performance"]["triangles"] == tris, "Manifest triangle count is stale")
require(m["performance"]["fileBytes"] == len(b), "Manifest byte count is stale")
require(m["performance"]["meshMaterialGroups"] == len(g["meshes"]), "Manifest material group count is stale")
require(not g.get("images", []) and not g.get("textures", []), "Unexpected image texture dependency")
require(all("uri" not in buffer for buffer in g["buffers"]), "GLB must be self-contained")
source_bytes = (source_root / "northstar-precinct.blend").stat().st_size
require(source_bytes < MAX_ASSET_BYTES, "Editable Blender source exceeds 25 MB")

report = {
    "passed": True,
    "colliders": len(ids),
    "hotspots": len(m["hotspots"]),
    "navigationNodes": len(nodes),
    "rooms": len(m["rooms"]),
    "triangles": tris,
    "meshMaterialGroups": len(g["meshes"]),
    "runtimeAsset": m["asset"],
    "runtimeBytes": len(b),
    "runtimeSha256": hashlib.sha256(b).hexdigest(),
    "sourceBytes": source_bytes,
    "allNavigationLinksClearAtCapsuleRadius": 0.28,
    "allNodesReachable": True,
}
(source_root / "validation-report.json").write_text(json.dumps(report, indent=2))
sys.stdout.write(json.dumps(report, indent=2) + "\n")
