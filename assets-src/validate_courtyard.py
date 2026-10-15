#!/usr/bin/env python3
"""Variant acceptance checks. Source-only checks do not constitute renderer acceptance.

Run after the exclusive CPU lane is granted. Full mode additionally checks exported
GLB metadata, source/file limits, preservation report and actual lossless decoder proof.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from collections import deque
from collections.abc import Sequence
from pathlib import Path

from courtyard_layout import ASSET, VARIANT_ID, build_manifest, design

CAP = 5_242_880
MIN_DOOR_WIDTH = 2.05
MIN_DOOR_HEIGHT = 2.5
GLTF_VERSION = 2
MAX_TRIANGLES = 150_000
CAPSULE_HEIGHT = 1.8
ROOT = Path(__file__).resolve().parent.parent
EXPECTED_HOTSPOTS = {
    "reception",
    "case_board",
    "open_office",
    "personal_dossier",
    "briefing",
    "interview",
    "observation",
    "debrief_replay",
    "coach_lab",
    "instructor",
    "archive",
    "trophies",
}


def require(condition: bool, message: object) -> None:
    if not condition:
        raise ValueError(message)


def clear(
    position: Sequence[float], colliders: list[dict[str, object]], radius: float = 0.28, height: float = 1.8
) -> bool:
    x, y, z = position
    return not any(
        c["max"][1] > y + 1e-8
        and c["min"][1] < y + height - 1e-8
        and c["min"][0] - radius + 1e-8 < x < c["max"][0] + radius - 1e-8
        and c["min"][2] - radius + 1e-8 < z < c["max"][2] + radius - 1e-8
        for c in colliders
    )


def segment_clear(
    a: Sequence[float], b: Sequence[float], colliders: list[dict[str, object]], radius: float = 0.28
) -> bool:
    count = max(1, math.ceil(math.dist(a, b) / 0.045))
    return all(clear([a[k] + (b[k] - a[k]) * i / count for k in range(3)], colliders, radius) for i in range(count + 1))


def in_bounds(position: Sequence[float], bounds_: dict[str, list[float]]) -> bool:
    return all(bounds_["min"][i] - 1e-6 <= position[i] <= bounds_["max"][i] + 1e-6 for i in (0, 2))


def validate_graph(baseline: dict[str, object], manifest: dict[str, object]) -> tuple[dict[str, object], int]:
    nodes = {n["id"]: n for n in manifest["navigationNodes"]}
    require(len(nodes) == len(manifest["navigationNodes"]), "Duplicate navigation node IDs")
    require(len({c["id"] for c in manifest["colliders"]}) == len(manifest["colliders"]), "Duplicate collider IDs")
    for old in baseline["navigationNodes"]:
        new = nodes[old["id"]]
        require(new["position"] == old["position"], f"Old node moved: {old['id']}")
        require(set(old["neighbors"]) <= set(new["neighbors"]), f"Old graph connection removed: {old['id']}")
        if old["id"] != "arrival":
            require(new == old, f"Unrelated original node changed: {old['id']}")
    colliders = manifest["colliders"]
    edges = 0
    for node in nodes.values():
        require(in_bounds(node["position"], manifest["walkBounds"]), f"Node outside walk bounds: {node['id']}")
        require(clear(node["position"], colliders), f"Node blocked: {node['id']}")
        for target in node["neighbors"]:
            require(
                target in nodes and node["id"] in nodes[target]["neighbors"],
                f"Nonreciprocal edge: {node['id']} → {target}",
            )
            if node["id"] < target:
                require(
                    segment_clear(node["position"], nodes[target]["position"], colliders),
                    f"Blocked graph edge: {node['id']} → {target}",
                )
                edges += 1
    seen, todo = {"arrival"}, ["arrival"]
    while todo:
        for neighbor in nodes[todo.pop()]["neighbors"]:
            if neighbor not in seen:
                seen.add(neighbor)
                todo.append(neighbor)
    require(len(seen) == len(nodes), "Navigation graph has disconnected rooms")
    return nodes, edges


def destination_reachable(
    feet: Sequence[float], room_id: str, manifest: dict[str, object], nodes: dict[str, object]
) -> bool:
    colliders = manifest["colliders"]
    if any(segment_clear(node["position"], feet, colliders) for node in nodes.values()):
        return True
    room = next(room for room in manifest["rooms"] if room["id"] == room_id)
    area = room["bounds"]
    padding = 0.285
    points = [list(feet)]
    for collider in colliders:
        if collider["max"][1] <= 0 or collider["min"][1] >= CAPSULE_HEIGHT:
            continue
        for x in (collider["min"][0] - padding, collider["max"][0] + padding):
            for z in (collider["min"][2] - padding, collider["max"][2] + padding):
                point = [x, 0, z]
                if in_bounds(point, area) and clear(point, colliders):
                    points.append(point)
    targets = [node["position"] for node in nodes.values() if in_bounds(node["position"], area)]
    queue = deque([0])
    unseen = set(range(1, len(points)))
    while queue:
        point = points[queue.popleft()]
        if any(segment_clear(point, target, colliders) for target in targets):
            return True
        for neighbor in list(unseen):
            if segment_clear(point, points[neighbor], colliders):
                unseen.remove(neighbor)
                queue.append(neighbor)
    return False


def validate_destinations(
    manifest: dict[str, object], nodes: dict[str, object], colliders: list[dict[str, object]]
) -> None:
    for room in manifest["rooms"]:
        anchor = room["anchor"]
        require(clear(anchor, colliders), f"Room anchor blocked: {room['id']}")
        require(
            any(segment_clear(node["position"], anchor, colliders) for node in nodes.values()),
            f"Room unreachable from graph: {room['id']}",
        )
    for hotspot in manifest["hotspots"]:
        feet = [hotspot["position"][0], 0, hotspot["position"][2]]
        require(in_bounds(feet, manifest["walkBounds"]), f"Hotspot outside bounds: {hotspot['id']}")
        require(clear(feet, colliders), f"Hotspot blocked: {hotspot['id']}")
        require(destination_reachable(feet, hotspot["room"], manifest, nodes), f"Hotspot unreachable: {hotspot['id']}")


def validate_portals(manifest: dict[str, object], colliders: list[dict[str, object]]) -> int:
    portal_checks = 0
    for portal in manifest["doors"]:
        require(
            portal["width"] >= MIN_DOOR_WIDTH and portal["height"] >= MIN_DOOR_HEIGHT,
            f"Portal clearance reduced: {portal['id']}",
        )
        tangent, normal = (0, 2) if portal["axis"] == "x" else (2, 0)
        half = portal["width"] / 2 - 0.28 - 0.04
        for offset in (-half, -half / 2, 0, half / 2, half):
            a, b = list(portal["walkCenter"]), list(portal["walkCenter"])
            a[tangent] += offset
            b[tangent] += offset
            a[normal] -= 0.30
            b[normal] += 0.30
            require(segment_clear(a, b, colliders), f"Portal capsule corridor blocked: {portal['id']} offset {offset}")
            portal_checks += 1
    return portal_checks


def validate_semantics(baseline: dict[str, object], manifest: dict[str, object]) -> dict[str, object]:
    require(manifest["worldVariant"]["id"] == VARIANT_ID, "Wrong world variant")
    require(manifest["asset"] == ASSET, "Manifest/asset pairing differs")
    require(manifest["hotspots"] == baseline["hotspots"], "Existing hotspot behavior or coordinates changed")
    require({h["id"] for h in manifest["hotspots"]} == EXPECTED_HOTSPOTS, "All 12 original hotspot IDs required")
    require(manifest["rooms"][: len(baseline["rooms"])] == baseline["rooms"], "Original room metadata changed")
    require(manifest["doors"][: len(baseline["doors"])] == baseline["doors"], "Original portals changed")
    require(manifest["colliders"][: len(baseline["colliders"])] == baseline["colliders"], "Original colliders changed")
    require(manifest["spawn"] == baseline["spawn"], "Spawn changed")
    require(manifest["player"] == baseline["player"], "Player configuration changed")
    require(
        manifest["reviewCameras"][: len(baseline["reviewCameras"])] == baseline["reviewCameras"],
        "Original review cameras changed",
    )
    require(
        manifest["worldVariant"]["preservedModuleTransform"] == {"translation": [0, 0, 0], "rotationY": 0, "scale": 1},
        "Working module transformed",
    )
    require(manifest["navigation"]["nodes"] == manifest["navigationNodes"], "Navigation representations differ")
    require(manifest["navigation"]["portals"] == manifest["doors"], "Portal representations differ")
    nodes, edges = validate_graph(baseline, manifest)
    colliders = manifest["colliders"]
    validate_destinations(manifest, nodes, colliders)
    portal_checks = validate_portals(manifest, colliders)
    for camera in manifest["reviewCameras"]:
        feet = [camera["position"][0], 0, camera["position"][2]]
        require(in_bounds(feet, manifest["walkBounds"]), f"Camera outside bounds: {camera['id']}")
        require(clear(feet, colliders, 0.15), f"Camera embedded: {camera['id']}")
        require(camera["position"][1] >= 1.0, f"Camera below safe eye range: {camera['id']}")
    # Dedicated court route width and four-sided enclosure, including the existing north frontage.
    for x in (-0.85, 0, 0.85):
        require(segment_clear([x, 0, 0.5], [x, 0, 19.2], colliders), f"Axial courtyard capsule lane blocked at X {x}")
    annex = colliders[len(baseline["colliders"]) :]
    for edge in ([14, 0, 10], [-14, 0, 10], [0, 0, 20]):
        require(not clear(edge, annex), "Courtyard perimeter has an uncontained exit")
    return {
        "passed": True,
        "originalHotspotsPreserved": 12,
        "originalRoomsPreserved": len(baseline["rooms"]),
        "roomsReachable": len(manifest["rooms"]),
        "navigationNodes": len(nodes),
        "clearGraphEdges": edges,
        "portalCapsuleSamples": portal_checks,
        "reviewCamerasClear": len(manifest["reviewCameras"]),
        "capsuleRadius": 0.28,
        "sourceOnly": True,
        "actualRendererValidated": False,
    }


def validate_export(root: Path, manifest: dict[str, object]) -> dict[str, object]:
    source = root / "assets-src/northstar-precinct-courtyard.blend"
    runtime_path = root / "web/public/world" / manifest["asset"]
    proof_path = root / "assets-src/courtyard-compression-report.json"
    proof = json.loads(proof_path.read_text())
    data = runtime_path.read_bytes()
    require(not manifest.get("assetPending"), "Unfinished asset")
    require(data[:4] == b"glTF" and struct.unpack_from("<I", data, 4)[0] == GLTF_VERSION, "Invalid GLB")
    require(struct.unpack_from("<I", data, 8)[0] == len(data), "Invalid GLB length")
    document = json.loads(data[20 : 20 + struct.unpack_from("<I", data, 12)[0]])
    require("EXT_meshopt_compression" in document.get("extensionsRequired", []), "Lossless Meshopt required")
    triangles = sum(
        document["accessors"][primitive["indices"]]["count"] // 3
        for mesh in document["meshes"]
        for primitive in mesh["primitives"]
    )
    require(triangles < MAX_TRIANGLES, "Existing triangle budget exceeded")
    require(triangles == manifest["performance"]["triangles"], "Triangle metadata stale")
    require(len(data) == manifest["performance"]["fileBytes"], "Runtime bytes metadata stale")
    require(
        len(document["meshes"]) == manifest["performance"]["meshMaterialGroups"], "Material batching metadata stale"
    )
    require(not document.get("images") and not document.get("textures"), "Unexpected external texture dependency")
    require(all("uri" not in buffer for buffer in document["buffers"]), "External buffer dependency")
    require(len(data) <= CAP and source.stat().st_size <= CAP, "Committed asset over 5 MiB")
    require(
        hashlib.sha256(source.read_bytes()).hexdigest() == proof["sourceSha256"], "Source differs from lossless proof"
    )
    require(
        proof["allDecodedBufferBytesIdentical"] and not proof["quantization"] and not proof["geometryRemoved"],
        "Lossless proof incomplete",
    )
    decoded_proof = json.loads((root / "qa/courtyard-runtime-decoded.json").read_text())
    require(decoded_proof["runtimeSha256"] == hashlib.sha256(data).hexdigest(), "Decoder verified another runtime")
    require(decoded_proof["passed"] and decoded_proof["triangles"] == triangles, "Actual runtime decoder failed")
    preservation = json.loads((root / "qa/courtyard-module-preservation.json").read_text())
    require(
        preservation["passed"] and preservation["retainedObjectFingerprintsUnchanged"], "Original module not preserved"
    )
    manifest_path = root / "web/public/world/precinct-courtyard-manifest.json"
    identity = {
        "schemaVersion": 1,
        "variantId": VARIANT_ID,
        "asset": ASSET,
        "sourceFile": "assets-src/northstar-precinct-courtyard.blend",
        "manifestFile": "web/public/world/precinct-courtyard-manifest.json",
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "runtimeSha256": hashlib.sha256(data).hexdigest(),
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "uncompressedRuntimeSha256": proof["inputSha256"],
        "decodedBinarySha256": decoded_proof["decodedBinarySha256"],
        "baselineSourceSha256": preservation["baselineSourceSha256"],
        "baselineManifestSha256": preservation["baselineManifestSha256"],
        "losslessGeometryVerified": True,
        "originalModuleObjectsPreserved": preservation["retainedObjects"],
        "runtimeBytes": len(data),
        "sourceBytes": source.stat().st_size,
        "triangles": triangles,
        "actualRendererValidated": False,
        "note": (
            "Hashes identify the final compressed runtime and its matching final manifest. "
            "Browser acceptance is separate."
        ),
    }
    (root / "assets-src/courtyard-export-report.json").write_text(json.dumps(identity, indent=2) + "\n")
    return {
        "sourceOnly": False,
        "variantId": VARIANT_ID,
        "sourceSha256": identity["sourceSha256"],
        "runtimeSha256": identity["runtimeSha256"],
        "manifestSha256": identity["manifestSha256"],
        "runtimeBytes": len(data),
        "sourceBytes": source.stat().st_size,
        "triangles": triangles,
        "decodedBufferViews": decoded_proof["decodedBufferViews"],
        "losslessGeometryVerified": True,
        "originalModuleObjectsPreserved": preservation["retainedObjects"],
        "actualRendererValidated": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-manifest", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    baseline = json.loads(args.baseline_manifest.read_text())
    manifest = (
        build_manifest(baseline, design())
        if args.source_only
        else json.loads((args.root / "web/public/world/precinct-courtyard-manifest.json").read_text())
    )
    report = validate_semantics(baseline, manifest)
    if not args.source_only:
        report.update(validate_export(args.root, manifest))
    (args.root / "qa").mkdir(exist_ok=True)
    filename = "courtyard-source-validation.json" if args.source_only else "courtyard-validation.json"
    (args.root / "qa" / filename).write_text(json.dumps(report, indent=2) + "\n")
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
