#!/usr/bin/env python3
"""Prove a typography-only rebuild preserves all runtime metadata but measured cost.

Usage: python assets-src/check_signage_preservation.py BEFORE_MANIFEST AFTER_MANIFEST
"""

import argparse
import json
import sys
from pathlib import Path


def require(condition: bool, message: object) -> None:
    """Keep validation active even when Python assertions are optimized away."""
    if not condition:
        raise ValueError(message)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
args = parser.parse_args()
before = json.loads(args.before.read_text())
after = json.loads(args.after.read_text())
# Full equality outside the generated performance block also preserves author,
# licensing, geometry coordinates, room labels, collision AABBs and route graph.
for obj in (before, after):
    obj.pop("performance", None)
require(before == after, "Non-performance manifest metadata changed; review before integrating.")
sys.stdout.write(
    "PASS: every non-performance manifest field is unchanged, including colliders/navigation/provenance.\n"
)
