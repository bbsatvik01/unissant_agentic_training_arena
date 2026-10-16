"""Original compact courtyard design, runtime metadata and collision source of truth.

All geometry specifications use Blender coordinates (X east, Y north, Z up).
The original working module occupies Y 0..36; this annex occupies Y -20..0.
This module contains no Blender imports, I/O, or external state changes.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from copy import deepcopy

VARIANT_ID = "northstar-courtyard-v1"
ASSET = "precinct-courtyard.glb"
SOURCE = "assets-src/northstar-precinct-courtyard.blend"
CREDIT = (
    "Architectural reference: Old Patent Office Building, Washington, DC; Historic American Buildings Survey, "
    "HABS DC-130, sheets 1 and 3 of 8. Drawn by Hartman-Cox Architects. Library of Congress, Prints & Photographs "
    "Division. Drawing date not specified in the inspected record. Fictional training adaptation; not a "
    "representation of the building's current interior and not endorsed by the Smithsonian Institution."
)
REFERENCE_URLS = [
    "https://www.loc.gov/resource/hhh.dc0194.sheet/?sp=3&st=image",
    "https://www.loc.gov/pictures/item/dc0194.sheet.00001a/",
    "https://wwws.loc.gov/rr/print/res/114_habs.html",
]
# Exact prefixes from the original authoring script. Interior/entrance objects are not removed.
REMOVE_PREFIXES = (
    "South civic sidewalk",
    "Sidewalk score",
    "Roadway",
    "Far sidewalk",
    "Road lane marking",
    "Pedestrian crosswalk",
    "DC brick rowhouse",
    "Rowhouse ",
    "Civic limestone hall",
    "Civic column",
    "Civic capital",
    "Civic window",
    "Civic entablature",
    "Civic pediment",
    "DC streetlamp",
    "Streetlamp base",
    "Street tree",
)
PALETTE = {
    "Court limestone light": ("D5CCBA", 0.87, 0.0),
    "Court limestone shade": ("B7AD98", 0.91, 0.0),
    "Court bluestone": ("7D8B8C", 0.82, 0.0),
    "Court bluestone light": ("A2AAA4", 0.85, 0.0),
    "Court joint": ("6E746C", 0.95, 0.0),
    "Court roof slate": ("4B5B5B", 0.88, 0.0),
    "Court pale plaster": ("E6E0D2", 0.93, 0.0),
    "Court bronze": ("827559", 0.48, 0.65),
    "Court sage upholstery": ("829184", 0.94, 0.0),
    "Court planting sage": ("778A69", 0.97, 0.0),
    "Court planting dark": ("486D5C", 0.98, 0.0),
    "Court glazing": ("506A70", 0.31, 0.06),
}


def runtime(v: Sequence[float]) -> list[float]:
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def bounds(loc: Sequence[float], size: Sequence[float]) -> dict[str, list[float]]:
    lo = [loc[i] - size[i] / 2 for i in range(3)]
    hi = [loc[i] + size[i] / 2 for i in range(3)]
    return {
        "min": [round(lo[0], 4), round(lo[2], 4), round(-hi[1], 4)],
        "max": [round(hi[0], 4), round(hi[2], 4), round(-lo[1], 4)],
    }


def design() -> list[dict[str, object]]:
    """Return deterministic semantic objects; every solid obstacle includes its collider."""
    objects = []

    def box(
        name: str, loc: Sequence[float], size: Sequence[float], material: str, **options: bool | str | float
    ) -> None:
        objects.append(
            {
                "name": "Courtyard | " + name,
                "shape": "box",
                "loc": loc,
                "size": size,
                "material": material,
                "bevel": options.get("bevel", 0),
                "rotation": options.get("rotation", 0),
                "solid": options.get("solid", False),
            }
        )

    def cylinder(
        name: str, loc: Sequence[float], radius: float, depth: float, material: str, **options: bool | str | float
    ) -> None:
        objects.append(
            {
                "name": "Courtyard | " + name,
                "shape": "cylinder",
                "loc": loc,
                "radius": radius,
                "top_radius": options.get("top_radius", radius),
                "depth": depth,
                "material": material,
                "sides": options.get("sides", 24),
                "solid": options.get("solid", False),
                "size": [radius * 2, radius * 2, depth],
            }
        )

    def leaf(name: str, loc: Sequence[float], scale: Sequence[float], material: str) -> None:
        objects.append(
            {
                "name": "Courtyard | " + name,
                "shape": "foliage",
                "loc": loc,
                "size": scale,
                "material": material,
                "solid": False,
            }
        )

    _add_paving(box)
    _add_outer_walls(box)
    _add_colonnade(box, cylinder)
    _add_gardens(box, cylinder, leaf)
    _add_furniture(box, cylinder, objects)
    return objects


def _add_paving(box: Callable[..., None]) -> None:
    # Level paved floor and restrained large-format stone joints.
    box("level annex foundation", (0, -10, -0.10), (28, 20, 0.24), "Court bluestone light")
    for x in range(-13, 14):
        box(f"paving longitudinal joint {x}", (x, -10, 0.022), (0.012, 20, 0.003), "Court joint")
    for y in range(-19, 0):
        box(f"paving transverse joint {y}", (0, y, 0.022), (28, 0.012, 0.003), "Court joint")
    # Geometric garden field + broad level crossing axes. Surface geometry does not obstruct.
    box("garden paving field", (0, -9, 0.028), (18, 8, 0.01), "Court bluestone")
    box("north south axial walk", (0, -10, 0.037), (2.4, 20, 0.012), "Court limestone light")
    box("east west axial walk", (0, -9, 0.039), (28, 2.0, 0.012), "Court limestone light")
    for x in (-8.9, 8.9):
        box(f"garden side border {x}", (x, -9, 0.043), (0.16, 8.1, 0.012), "Court limestone light")
    for y in (-5.05, -12.95):
        box(f"garden end border {y}", (0, y, 0.043), (18, 0.16, 0.012), "Court limestone light")


def _add_outer_walls(box: Callable[..., None]) -> None:
    # Closed outer walls provide actual movement containment; walkBounds alone do not.
    for side in (-1, 1):
        x = side * 14
        box(
            f"outer {'west' if side < 0 else 'east'} wall",
            (x, -10, 2.0),
            (0.30, 20, 4.0),
            "Court limestone light",
            solid="wall",
        )
        box(f"side base course {side}", (x - side * 0.06, -10, 0.25), (0.42, 20, 0.50), "Court limestone shade")
        box(
            f"side cornice {side}",
            (x - side * 0.08, -10, 3.94),
            (0.54, 20.2, 0.23),
            "Court limestone light",
            bevel=0.025,
        )
        for z in (0.55, 1.15, 1.75, 2.35, 2.95, 3.55):
            box(f"side ashlar bed {side} {z}", (x - side * 0.155, -10, z), (0.012, 20, 0.012), "Court limestone shade")
        for y in (-2, -6, -10, -14, -18):
            # Recessed-looking, framed original windows; no photography or image textures.
            box(
                f"side window reveal {side} {y}",
                (x - side * 0.17, y, 2.00),
                (0.035, 1.68, 2.32),
                "Court limestone shade",
            )
            box(f"side window glass {side} {y}", (x - side * 0.195, y, 2.04), (0.026, 1.38, 2.02), "Court glazing")
            box(f"side window mullion {side} {y}", (x - side * 0.22, y, 2.04), (0.045, 0.055, 2.02), "Court bronze")
            for z in (1.55, 2.52):
                box(f"side window rail {side} {y} {z}", (x - side * 0.22, y, z), (0.045, 1.38, 0.045), "Court bronze")
            box(
                f"side window sill {side} {y}",
                (x - side * 0.25, y, 0.93),
                (0.32, 1.88, 0.13),
                "Court limestone light",
                bevel=0.015,
            )
    box("south outer wall", (0, -20, 2), (28, 0.30, 4), "Court limestone light", solid="wall")
    box("south base course", (0, -19.94, 0.25), (28, 0.42, 0.5), "Court limestone shade")
    for z in (0.55, 1.15, 1.75, 2.35, 2.95, 3.55):
        box(f"south ashlar bed {z}", (0, -19.843, z), (28, 0.012, 0.012), "Court limestone shade")
    for x in (-11, -7.5, -4, 4, 7.5, 11):
        box(f"south window reveal {x}", (x, -19.82, 2.0), (1.8, 0.035, 2.32), "Court limestone shade")
        box(f"south window glass {x}", (x, -19.79, 2.04), (1.48, 0.025, 2.02), "Court glazing")
        box(f"south window mullion {x}", (x, -19.76, 2.04), (0.055, 0.04, 2.02), "Court bronze")
        box(f"south window sill {x}", (x, -19.72, 0.93), (1.94, 0.3, 0.13), "Court limestone light", bevel=0.015)


def _add_colonnade(box: Callable[..., None], cylinder: Callable[..., None]) -> None:
    # Four shallow roofed wings surround an open sky rectangle, not one oversized hall.
    for name, loc, size in [
        ("north", (0, -2.05, 3.78), (28, 4.7, 0.20)),
        ("south", (0, -16.85, 3.78), (28, 6.7, 0.20)),
        ("west", (-11.75, -9, 3.78), (4.5, 9.4, 0.20)),
        ("east", (11.75, -9, 3.78), (4.5, 9.4, 0.20)),
    ]:
        box(f"{name} gallery soffit", loc, size, "Court pale plaster")
        box(f"{name} slate roof", (loc[0], loc[1], 4.04), (size[0] + 0.18, size[1] + 0.18, 0.14), "Court roof slate")
    for y in (-4.5, -13.5):
        box(f"axial colonnade entablature {y}", (0, y, 3.49), (19.4, 0.60, 0.36), "Court limestone light", bevel=0.025)
        box(f"axial colonnade cornice {y}", (0, y, 3.74), (19.65, 0.73, 0.14), "Court limestone light", bevel=0.018)
    for x in (-9.5, 9.5):
        box(
            f"lateral colonnade entablature {x}", (x, -9, 3.49), (0.60, 9.6, 0.36), "Court limestone light", bevel=0.025
        )
        box(f"lateral colonnade cornice {x}", (x, -9, 3.74), (0.73, 9.8, 0.14), "Court limestone light", bevel=0.018)
    positions = [(x, y) for y in (-4.5, -13.5) for x in (-9.5, -6.3, -3.15, 3.15, 6.3, 9.5)]
    positions += [(x, y) for x in (-9.5, 9.5) for y in (-7.5, -10.5)]
    for index, (x, y) in enumerate(positions):
        box(
            f"pier plinth {index}", (x, y, 0.13), (0.65, 0.65, 0.26), "Court limestone shade", solid="wall", bevel=0.018
        )
        cylinder(f"column torus base {index}", (x, y, 0.31), 0.30, 0.15, "Court limestone light", solid="wall")
        cylinder(
            f"column tapered shaft {index}",
            (x, y, 1.77),
            0.235,
            2.77,
            "Court limestone light",
            top_radius=0.195,
            solid="wall",
        )
        cylinder(f"column neck {index}", (x, y, 3.19), 0.25, 0.16, "Court limestone shade")
        box(f"column capital {index}", (x, y, 3.30), (0.63, 0.63, 0.16), "Court limestone light", bevel=0.02)
    # Rhythm on north-facing current wing, without modifying its glazing or entrance.
    for x in (-12, -8, -4, 4, 8, 12):
        box(f"north gallery ceiling beam {x}", (x, -2.0, 3.64), (0.10, 4.2, 0.12), "Court limestone shade")
    for x in (-11, -7.5, -4, 0, 4, 7.5, 11):
        box(f"south gallery ceiling beam {x}", (x, -16.8, 3.64), (0.11, 6.25, 0.12), "Court limestone shade")


def _add_gardens(box: Callable[..., None], cylinder: Callable[..., None], leaf: Callable[..., None]) -> None:
    # Paired circles echo the HABS fountain geometry as safe, planted raised islands.
    for index, x in enumerate((-4.5, 4.5)):
        cylinder(
            f"circular garden coping {index}",
            (x, -9, 0.24),
            0.93,
            0.43,
            "Court limestone light",
            solid="furniture",
            sides=40,
        )
        cylinder(f"circular garden soil {index}", (x, -9, 0.47), 0.79, 0.035, "Soil", sides=32)
        cylinder(f"garden tree trunk {index}", (x, -9, 1.7), 0.09, 2.5, "Walnut detail", sides=12)
        for j, (dx, dy, z, scale) in enumerate(
            [
                (-0.42, 0.04, 2.75, (1.05, 0.83, 0.81)),
                (0.42, 0.18, 3.02, (1.0, 0.88, 0.85)),
                (0, -0.24, 3.65, (0.87, 0.81, 0.76)),
            ]
        ):
            leaf(
                f"garden tree crown {index} {j}",
                (x + dx, -9 + dy, z),
                scale,
                "Court planting dark" if j % 2 else "Court planting sage",
            )
    # Four geometric parterres, always outside the centre and perimeter through paths.
    for x in (-4.5, 4.5):
        for y in (-6.15, -11.85):
            box(
                f"parterre border {x} {y}",
                (x, y, 0.18),
                (4.15, 1.18, 0.31),
                "Court limestone shade",
                solid="furniture",
                bevel=0.025,
            )
            box(f"parterre earth {x} {y}", (x, y, 0.35), (3.92, 0.96, 0.035), "Soil")
            for k in range(7):
                leaf(
                    f"parterre planting {x} {y} {k}",
                    (x - 1.65 + k * 0.55, y, 0.55),
                    (0.37, 0.38, 0.3),
                    "Court planting sage" if k % 2 else "Court planting dark",
                )


def _add_furniture(box: Callable[..., None], cylinder: Callable[..., None], objects: list[dict[str, object]]) -> None:
    def bench(name: str, x: float, y: float, length: float = 2.6, *, along_y: bool = False) -> None:
        width, depth = (0.64, length) if along_y else (length, 0.64)
        box(name + " oak seat", (x, y, 0.46), (width, depth, 0.12), "Oak natural", solid="furniture", bevel=0.035)
        if along_y:
            box(
                name + " back",
                (x + (-0.24 if x < 0 else 0.24), y, 0.75),
                (0.1, depth, 0.58),
                "Court sage upholstery",
                solid="furniture",
                bevel=0.03,
            )
        else:
            box(
                name + " back",
                (x, y - 0.25, 0.75),
                (width, 0.1, 0.58),
                "Court sage upholstery",
                solid="furniture",
                bevel=0.03,
            )
        for d in (-0.8, 0.8):
            xx, yy = (x, y + d) if along_y else (x + d, y)
            box(name + f" stone foot {d}", (xx, yy, 0.22), (0.32, 0.45, 0.4), "Court limestone shade")

    for x in (-12.8, 12.8):
        bench(f"quiet gallery bench {x}", x, -3.1, along_y=True)
        bench(f"south gallery bench {x}", x, -16.6, along_y=True)
        # A modest writing ledge with original paper and lamp, no simulated app UI.
        box(
            f"gallery writing ledge {x}", (x, -9, 0.77), (0.7, 2.7, 0.10), "Oak natural", solid="furniture", bevel=0.035
        )
        for y in (-10, -8):
            box(f"writing leg {x} {y}", (x, y, 0.38), (0.5, 0.12, 0.76), "Court bronze")
        box(f"writing paper {x}", (x, -8.6, 0.836), (0.3, 0.43, 0.012), "Paper ivory")
        cylinder(f"writing cup {x}", (x, -9.7, 0.93), 0.09, 0.20, "Court limestone light", sides=16)
    for x in (-6.4, 6.4):
        bench(f"arrival conversation bench {x}", x, -18.7, length=3.0)
        cylinder(
            f"arrival round side table {x}", (x, -17.4, 0.49), 0.46, 0.08, "Oak natural", solid="furniture", sides=28
        )
        cylinder(
            f"arrival side table stem {x}", (x, -17.4, 0.25), 0.15, 0.45, "Court bronze", solid="furniture", sides=16
        )
    # South-axis identity panel is understated civic wayfinding, not marketing signage.
    box("arrival bronze sign panel", (0, -19.79, 2.07), (4.9, 0.06, 1.10), "Deep petrol", bevel=0.015)
    for name, body, pos, size, width in [
        ("arrival name", "NORTHSTAR", (0, -19.747, 2.20), 0.36, 4.2),
        ("arrival subline", "TRAINING COURTYARD", (0, -19.742, 1.88), 0.14, 4.2),
    ]:
        objects.append(
            {
                "name": "Courtyard | " + name,
                "shape": "text",
                "body": body,
                "loc": pos,
                "font_size": size,
                "max_width": width,
                "material": "Paper ivory",
                "solid": False,
                "rotation_euler": [1.5707963267948966, 0, 3.141592653589793],
            }
        )


def annex_colliders(objects: list[dict[str, object]]) -> list[dict[str, object]]:
    result = []
    for index, spec in enumerate(objects):
        if not spec.get("solid"):
            continue
        b = bounds(spec["loc"], spec["size"])
        result.append({"id": f"courtyard-{index:04d}", "kind": spec["solid"], **b})
    return result


def build_manifest(baseline: dict[str, object], objects: list[dict[str, object]]) -> dict[str, object]:
    """Append compatible navigation without rebuilding or renumbering the original graph."""
    manifest = deepcopy(baseline)
    manifest["id"] = "northstar-investigation-precinct-courtyard"
    manifest["title"] = "Northstar Investigation Training Precinct · Courtyard"
    manifest["asset"] = ASSET
    manifest["sourceFile"] = SOURCE
    manifest["version"] = "1.0.0-courtyard"
    manifest["assetPending"] = True
    manifest["worldVariant"] = {
        "id": VARIANT_ID,
        "label": "Original compact courtyard adaptation",
        "baselineAsset": "precinct.glb",
        "baselineManifest": "precinct-manifest.json",
        "preservedModuleTransform": {"translation": [0, 0, 0], "rotationY": 0, "scale": 1},
        "courtFieldMeters": [18, 8],
        "annexEnvelopeMeters": [28, 20],
        "footprintBounds": {"min": [-14, 0, -36], "max": [14, 4.2, 20]},
        "optionalArrivalPose": {
            "position": [0, 0, 16.3],
            "eyeHeight": 1.65,
            "yaw": 0,
            "lookAt": [0, 1.65, 2.4],
            "activeByDefault": False,
        },
        "referenceCredit": CREDIT,
        "referenceUrls": REFERENCE_URLS,
        "referenceDrawingDate": "Not specified in the inspected record",
        "currentMuseumReplica": False,
    }
    manifest["provenance"]["architecturalReference"] = CREDIT
    manifest["provenance"]["externalImageTextures"] = False
    manifest["coordinates"]["footprintMeters"] = [28, 56]
    manifest["walkBounds"] = {"min": [-13.70, 0, -35.74], "max": [13.70, 3.45, 19.70]}
    manifest["colliders"].extend(annex_colliders(objects))
    rooms = [
        ("court_north_gallery", "North Courtyard Gallery", (-13.7, 0, 0.2), (13.7, 3.7, 4.5), (0, 0, 2.4)),
        ("courtyard", "Open-sky Courtyard", (-9.2, 0, 4.5), (9.2, 8, 13.5), (0, 0, 9)),
        ("court_west_gallery", "Quiet West Gallery", (-13.7, 0, 4.5), (-9.2, 3.7, 14), (-11.3, 0, 9)),
        ("court_east_gallery", "Quiet East Gallery", (9.2, 0, 4.5), (13.7, 3.7, 14), (11.3, 0, 9)),
        ("court_south_gallery", "South Arrival Arcade", (-13.7, 0, 14), (13.7, 3.7, 19.7), (0, 0, 16.3)),
    ]
    manifest["rooms"].extend(
        {
            "id": id_,
            "name": name,
            "bounds": {"min": list(lo), "max": list(hi)},
            "anchor": list(anchor),
            "description": (
                "Original level courtyard extension; existing training stations retain their original coordinates."
            ),
        }
        for id_, name, lo, hi, anchor in rooms
    )
    portal = {
        "id": "courtyard_lobby_portal",
        "connects": ["lobby", "court_north_gallery"],
        "center": [0, 1.4, 0],
        "width": 3.50,
        "height": 2.8,
        "axis": "x",
        "clearance": 0.2,
        "walkCenter": [0, 0, 0],
    }
    manifest["doors"].append(portal)
    nodes = manifest["navigationNodes"]
    by_id = {node["id"]: node for node in nodes}

    def node(id_: str, x: float, z: float) -> None:
        value = {"id": id_, "position": [x, 0, z], "neighbors": []}
        nodes.append(value)
        by_id[id_] = value

    def link(a: str, b: str) -> None:
        by_id[a]["neighbors"].append(b)
        by_id[b]["neighbors"].append(a)

    for id_, x, z in [
        ("courtyard_lobby_portal", 0, 0),
        ("court-north", 0, 2.4),
        ("court-center", 0, 9),
        ("court-south", 0, 16.3),
        ("court-northwest", -11.3, 2.4),
        ("court-northeast", 11.3, 2.4),
        ("court-west", -11.3, 9),
        ("court-east", 11.3, 9),
        ("court-southwest", -11.3, 16.3),
        ("court-southeast", 11.3, 16.3),
        ("court-upperwest", -7.7, 9),
        ("court-uppereast", 7.7, 9),
        ("court-northwest-cross", -7.7, 7.5),
        ("court-northeast-cross", 7.7, 7.5),
        ("court-southwest-cross", -7.7, 10.5),
        ("court-southeast-cross", 7.7, 10.5),
        ("court-center-north", 0, 7.5),
        ("court-center-south", 0, 10.5),
    ]:
        node(id_, x, z)
    edges = [
        ("arrival", "courtyard_lobby_portal"),
        ("courtyard_lobby_portal", "court-north"),
        ("court-north", "court-center-north"),
        ("court-center-north", "court-center"),
        ("court-center", "court-center-south"),
        ("court-center-south", "court-south"),
        ("court-north", "court-northwest"),
        ("court-north", "court-northeast"),
        ("court-northwest", "court-west"),
        ("court-west", "court-southwest"),
        ("court-northeast", "court-east"),
        ("court-east", "court-southeast"),
        ("court-southwest", "court-south"),
        ("court-southeast", "court-south"),
        ("court-west", "court-upperwest"),
        ("court-east", "court-uppereast"),
        ("court-upperwest", "court-northwest-cross"),
        ("court-upperwest", "court-southwest-cross"),
        ("court-uppereast", "court-northeast-cross"),
        ("court-uppereast", "court-southeast-cross"),
        ("court-northwest-cross", "court-center-north"),
        ("court-northeast-cross", "court-center-north"),
        ("court-southwest-cross", "court-center-south"),
        ("court-southeast-cross", "court-center-south"),
    ]
    for a, b in edges:
        link(a, b)
    manifest["navigation"]["nodes"] = deepcopy(nodes)
    manifest["navigation"]["portals"] = deepcopy(manifest["doors"])
    manifest["navigation"]["courtyardClearRouteWidth"] = 2.4
    manifest["navigation"]["note"] += " Original courtyard annex uses perimeter walls and a reciprocal appended loop."
    manifest["reviewCameras"].extend(
        [
            {"id": "courtyard-axial", "position": [0, 1.68, 16.3], "target": [0, 1.7, 2.4]},
            {"id": "courtyard-oblique", "position": [-11.3, 1.68, 15.8], "target": [3.0, 1.85, 6.7]},
            {"id": "courtyard-gallery", "position": [11.3, 1.68, 15.8], "target": [11.3, 1.7, 2.4]},
        ]
    )
    return manifest
