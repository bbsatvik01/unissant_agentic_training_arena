"""Licence gate (S5 11.1 sec-check): deny AGPL/SSPL and undeclared licences.

  python -m tools.check_licenses python                   # every distribution in the running environment
  python tools/check_licenses.py python                   # same, for an environment without this repo installed
  python -m tools.check_licenses node <pnpm-licenses.json> # output of `pnpm licenses list --json`

Stdlib only, so it can run inside any locked environment. Fails closed on an undeclared license
unless tools/gates/deps-policy.toml records a version-specific, evidenced override.
"""

import argparse
import importlib.metadata
import json
import sys
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

POLICY_PATH = Path(__file__).resolve().parent / "gates" / "deps-policy.toml"


@dataclass(frozen=True)
class LicensePolicy:
    denied: tuple[str, ...]
    workspace: frozenset[str]
    overrides: dict[tuple[str, str], str]


def load_policy(text: str) -> LicensePolicy:
    table = tomllib.loads(text).get("licenses")
    if not isinstance(table, dict):
        msg = "deps-policy.toml has no [licenses] table"
        raise TypeError(msg)
    denied = table.get("denied")
    if not isinstance(denied, list) or not denied or not all(isinstance(d, str) and d for d in denied):
        msg = "licenses.denied must be a non-empty list of strings"
        raise ValueError(msg)
    overrides: dict[tuple[str, str], str] = {}
    for item in table.get("override", []):
        fields = [item.get(k) for k in ("package", "version", "license", "evidence")]
        if not all(isinstance(f, str) and f for f in fields):
            msg = f"license override needs package, version, license and evidence: {item!r}"
            raise ValueError(msg)
        overrides[(str(fields[0]).lower(), str(fields[1]))] = str(fields[2])
    workspace = table.get("workspace", [])
    return LicensePolicy(tuple(d.lower() for d in denied), frozenset(str(w).lower() for w in workspace), overrides)


PLACEHOLDERS = {"", "unknown", "none", "unlicensed", "see license", "see license file", "other", "other/proprietary"}
GENERIC_CLASSIFIERS = {"license :: osi approved", "license :: other/proprietary license", "license :: freeware"}


def meaningful(parts: list[str]) -> str:
    """Declared license text with placeholders and license-less generic classifiers removed."""
    kept = [
        p.strip()
        for p in parts
        if p.strip().lower() not in PLACEHOLDERS and p.strip().lower() not in GENERIC_CLASSIFIERS
    ]
    return " ".join(kept)


def verdict(name: str, version: str, declared: str, policy: LicensePolicy) -> str | None:
    """None when allowed, else the reason it fails."""
    text = meaningful([declared]) or policy.overrides.get((name.lower(), version), "")
    if not text:
        return f"{name} {version}: no declared license (add a verified, version-specific override)"
    hit = next((d for d in policy.denied if d in text.lower()), None)
    return f"{name} {version}: denied license {text!r} (matches {hit!r})" if hit else None


def python_errors(policy: LicensePolicy) -> list[str]:
    errors: list[str] = []
    for dist in importlib.metadata.distributions():
        meta = dist.metadata
        name = meta.get("Name") or "?"
        if name.lower() in policy.workspace:
            continue
        classifiers = [c for c in (meta.get_all("Classifier") or []) if c.startswith("License ::")]
        declared = meaningful([meta.get("License-Expression") or "", meta.get("License") or "", *classifiers])
        problem = verdict(name, meta.get("Version") or "?", declared, policy)
        if problem:
            errors.append(problem)
    return errors


def node_errors(report: Mapping[str, Sequence[Mapping[str, object]]], policy: LicensePolicy) -> list[str]:
    errors: list[str] = []
    for license_name, packages in report.items():
        for package in packages:
            versions = package.get("versions")
            for version in versions if isinstance(versions, list) else ["?"]:
                declared = meaningful([license_name])
                problem = verdict(str(package.get("name")), str(version), declared, policy)
                if problem:
                    errors.append(problem)
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ecosystem", choices=["python", "node"])
    parser.add_argument("report", nargs="?", type=Path, help="pnpm licenses list --json output (node only)")
    args = parser.parse_args(argv)
    if args.ecosystem == "node" and args.report is None:
        parser.error("node mode needs the pnpm licenses JSON report path")
    try:
        policy = load_policy(POLICY_PATH.read_text())
        if args.ecosystem == "python":
            errors = python_errors(policy)
        else:
            errors = node_errors(json.loads(args.report.read_text()), policy)
    except (OSError, TypeError, ValueError, tomllib.TOMLDecodeError) as exc:
        sys.stderr.write(f"licenses: FAIL: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"licenses: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write(f"licenses: OK ({args.ecosystem})\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
