#!/usr/bin/env python3
"""Read-only GLB typography audit; no Blender, rendering, or extra dependencies.

Usage: python assets-src/audit_signage.py /path/to/precinct.glb
The JSON result is printed to stdout. This script never changes the scene.
"""

import argparse
import json
import math
import struct
import sys
from pathlib import Path
from typing import NotRequired, TypedDict, cast

GLTF_VERSION = 2
JSON_CHUNK = 0x4E4F534A
BINARY_CHUNK = 0x004E4942


class Accessor(TypedDict):
    bufferView: int
    type: str
    componentType: int
    count: int
    byteOffset: NotRequired[int]


class BufferView(TypedDict):
    byteOffset: NotRequired[int]
    byteStride: NotRequired[int]


class Primitive(TypedDict):
    attributes: dict[str, int]
    indices: int
    material: int


class Mesh(TypedDict):
    primitives: list[Primitive]


class Material(TypedDict):
    name: str


class GlbScene(TypedDict):
    accessors: list[Accessor]
    bufferViews: list[BufferView]
    meshes: list[Mesh]
    materials: list[Material]
    textures: NotRequired[list[object]]


class LabelAudit(TypedDict):
    id: str
    found: bool
    triangles: NotRequired[int]
    bounds: NotRequired[dict[str, list[float]]]
    capHeightMeters: NotRequired[float]
    backingClearanceMeters: NotRequired[float]
    planarityMeters: NotRequired[float]
    minOutwardNormal: NotRequired[float]
    capPixelsAt1080LowDpr: NotRequired[dict[str, float]]


class AuditReport(TypedDict):
    asset: str
    fileBytes: int
    meshes: int
    triangles: int
    textures: int
    labels: list[LabelAudit]


def require(condition: bool, message: object) -> None:
    """Keep validation active even when Python assertions are optimized away."""
    if not condition:
        raise ValueError(message)


def read_glb(path: Path) -> tuple[GlbScene, bytes, int]:
    data = path.read_bytes()
    require(
        data[:4] == b"glTF" and struct.unpack_from("<I", data, 4)[0] == GLTF_VERSION,
        "Expected glTF 2.0 magic and version",
    )
    require(struct.unpack_from("<I", data, 8)[0] == len(data), "Invalid GLB length")
    json_length, chunk_type = struct.unpack_from("<II", data, 12)
    require(chunk_type == JSON_CHUNK, "Expected GLB JSON chunk")
    scene = cast(GlbScene, json.loads(data[20 : 20 + json_length]))
    binary_length, chunk_type = struct.unpack_from("<II", data, 20 + json_length)
    require(chunk_type == BINARY_CHUNK, "Expected GLB binary chunk")
    binary = data[28 + json_length : 28 + json_length + binary_length]
    return scene, binary, len(data)


def values(scene: GlbScene, binary: bytes, index: int) -> list[tuple[float, ...]]:
    accessor = scene["accessors"][index]
    view = scene["bufferViews"][accessor["bufferView"]]
    count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    code = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}[accessor["componentType"]]
    form = "<" + code * count
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", struct.calcsize(form))
    return [
        cast(tuple[float, ...], struct.unpack_from(form, binary, offset + i * stride)) for i in range(accessor["count"])
    ]


# Only text material/planar regions are sampled. The bounds include the larger
# proposed lettering and both old and new face offsets. Coordinates are runtime.
REGIONS: list[tuple[str, str | None, list[float], list[float], float, int, float, int]] = [
    ("case_board_title", "Paper ivory", [3.88, 2.80, -9.736], [12.3, 3.20, -9.734], 2.83, 2, -9.76, 1),
    ("case_board_subtitle", None, [3.90, 2.46, -9.731], [12.3, 2.70, -9.729], 2.49, 2, -9.76, 1),
    ("first_card_title", "Powder coated charcoal", [3.90, 2.07, -9.664], [6.17, 2.27, -9.655], 2.09, 2, -9.669, 1),
    ("interview_door_number", "Paper ivory", [2.249, 1.65, -11.21], [2.256, 1.78, -10.54], 1.66, 0, 2.26, -1),
    ("interview_door_label", "Paper ivory", [2.249, 1.47, -11.21], [2.256, 1.62, -10.54], 1.48, 0, 2.26, -1),
    ("hall_curiosity", "Paper ivory", [-0.96, 2.88, -15.46], [1.0, 3.12, -15.45], 2.9, 2, -15.465, 1),
]


def audit(path: Path) -> AuditReport:
    material: str | None
    points: list[tuple[float, ...]]
    normals: list[tuple[float, ...]]
    scene, binary, size = read_glb(path)
    primitives = []
    for mesh in scene["meshes"]:
        for primitive in mesh["primitives"]:
            pos = values(scene, binary, primitive["attributes"]["POSITION"])
            normal = values(scene, binary, primitive["attributes"]["NORMAL"])
            inds = [cast(int, x[0]) for x in values(scene, binary, primitive["indices"])]
            material = scene["materials"][primitive["material"]]["name"]
            primitives.append((material, pos, normal, inds))
    report: AuditReport = {
        "asset": path.name,
        "fileBytes": size,
        "meshes": len(scene["meshes"]),
        "triangles": sum(len(p[3]) // 3 for p in primitives),
        "textures": len(scene.get("textures", [])),
        "labels": [],
    }
    focal = (1080 * 0.75) / (2 * math.tan(math.radians(66) / 2))
    for name, material, lo, hi, baseline, axis, support, direction in REGIONS:
        points, normals, triangles = [], [], 0
        for mat, pos, normal, inds in primitives:
            if material is not None and mat != material:
                continue
            selected = {i for i, point in enumerate(pos) if all(lo[d] <= point[d] <= hi[d] for d in range(3))}
            referenced = set()
            for start in range(0, len(inds), 3):
                tri = inds[start : start + 3]
                if all(i in selected for i in tri):
                    referenced.update(tri)
                    triangles += 1
            points.extend(pos[i] for i in referenced)
            normals.extend(normal[i] for i in referenced)
        if not points:
            report["labels"].append({"id": name, "found": False})
            continue
        minimum = [min(p[d] for p in points) for d in range(3)]
        maximum = [max(p[d] for p in points) for d in range(3)]
        cap = maximum[1] - baseline
        clearance = min(direction * (p[axis] - support) for p in points)
        report["labels"].append(
            {
                "id": name,
                "found": True,
                "triangles": triangles,
                "bounds": {"min": minimum, "max": maximum},
                "capHeightMeters": round(cap, 6),
                "backingClearanceMeters": round(clearance, 6),
                "planarityMeters": round(maximum[axis] - minimum[axis], 9),
                "minOutwardNormal": round(min(direction * n[axis] for n in normals), 6),
                "capPixelsAt1080LowDpr": {
                    str(distance) + "m": round(cap * focal / distance, 2) for distance in (2, 5, 8)
                },
            }
        )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", type=Path)
    args = parser.parse_args()
    sys.stdout.write(json.dumps(audit(args.glb), indent=2) + "\n")
