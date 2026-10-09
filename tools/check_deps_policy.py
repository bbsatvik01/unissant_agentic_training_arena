"""Dependency policy (S5 11.1 `deps-policy`; global pre-push bar): banned packages and extras, exact pins,
version floors.

Reads the committed lockfiles and manifests only (no network). Fails closed on a missing file,
a malformed policy, an unparseable version, or any violation.
"""

import argparse
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from tools import proc

POLICY_PATH = "tools/gates/deps-policy.toml"
PY_EXACT_PIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?==\d+(\.\d+)*$")
NODE_EXACT_PIN = re.compile(r"^\d+\.\d+\.\d+$")


class PolicyError(ValueError):
    """The policy file or a manifest is malformed."""


@dataclass(frozen=True)
class Floor:
    package: str
    minimum: str
    origin: str


@dataclass(frozen=True)
class Policy:
    python_locks: list[str]
    python_projects: list[str]
    node_manifests: list[str]
    py_banned: set[str] = field(default_factory=set)
    py_banned_extras: set[tuple[str, str]] = field(default_factory=set)
    py_exact: dict[str, str] = field(default_factory=dict)
    node_banned: set[str] = field(default_factory=set)
    node_floors: list[Floor] = field(default_factory=list)


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def version_tuple(version: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(\.\d+)*", version):
        msg = f"unsupported version {version!r} (release versions only)"
        raise PolicyError(msg)
    return tuple(int(part) for part in version.split("."))


def _str_list(raw: dict[str, object], key: str) -> list[str]:
    value = raw.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        msg = f"policy key {key} must be a list of strings"
        raise PolicyError(msg)
    return [str(v) for v in value]


def _table(raw: dict[str, object], key: str) -> dict[str, object]:
    value = raw.get(key, {})
    if not isinstance(value, dict):
        msg = f"policy key {key} must be a table"
        raise PolicyError(msg)
    return value


def _floor(raw: object) -> Floor:
    if not isinstance(raw, dict):
        msg = "node.floor entries must be tables"
        raise PolicyError(msg)
    package, minimum, origin = raw.get("package"), raw.get("minimum"), raw.get("origin")
    if not (isinstance(package, str) and isinstance(minimum, str) and isinstance(origin, str) and origin):
        msg = f"node.floor needs package, minimum and origin: {raw!r}"
        raise PolicyError(msg)
    version_tuple(minimum)
    return Floor(package, minimum, origin)


def _banned_extras(python: dict[str, object]) -> set[tuple[str, str]]:
    extras = python.get("banned_extras", [])
    if not isinstance(extras, list):
        msg = "python.banned_extras must be a list"
        raise PolicyError(msg)
    found: set[tuple[str, str]] = set()
    for item in extras:
        if not (isinstance(item, dict) and isinstance(item.get("package"), str) and isinstance(item.get("extra"), str)):
            msg = f"python.banned_extras entries need package and extra: {item!r}"
            raise PolicyError(msg)
        found.add((normalize(item["package"]), normalize(item["extra"])))
    return found


def parse_policy(text: str) -> Policy:
    raw = tomllib.loads(text)
    python, node = _table(raw, "python"), _table(raw, "node")
    exact = _table(python, "exact")
    if not all(isinstance(v, str) for v in exact.values()):
        msg = "python.exact values must be version strings"
        raise PolicyError(msg)
    floors = node.get("floor", [])
    if not isinstance(floors, list):
        msg = "node.floor must be an array of tables"
        raise PolicyError(msg)
    return Policy(
        python_locks=_str_list(raw, "python_locks"),
        python_projects=_str_list(raw, "python_projects"),
        node_manifests=_str_list(raw, "node_manifests"),
        py_banned={normalize(n) for n in _str_list(python, "banned")},
        py_banned_extras=_banned_extras(python),
        py_exact={normalize(k): str(v) for k, v in exact.items()},
        node_banned=set(_str_list(node, "banned")),
        node_floors=[_floor(f) for f in floors],
    )


def _dependency_entries(package: dict[str, object]) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for key in ("dependencies", "dev-dependencies", "optional-dependencies"):
        value = package.get(key)
        groups = list(value.values()) if isinstance(value, dict) else [value]
        for group in groups:
            if isinstance(group, list):
                entries.extend(dep for dep in group if isinstance(dep, dict))
    return entries


def check_python_lock(name: str, lock: dict[str, object], policy: Policy) -> list[str]:
    packages = lock.get("package")
    if not isinstance(packages, list) or not packages:
        return [f"{name}: no [[package]] entries"]
    errors: list[str] = []
    for package in packages:
        if not isinstance(package, dict):
            continue
        pkg = normalize(str(package.get("name", "")))
        version = str(package.get("version", ""))
        if pkg in policy.py_banned:
            errors.append(f"{name}: banned package {pkg} {version}")
        pinned = policy.py_exact.get(pkg)
        if pinned is not None and version != pinned:
            errors.append(f"{name}: {pkg} must be exactly {pinned}, lock has {version}")
        for dep in _dependency_entries(package):
            dep_name = normalize(str(dep.get("name", "")))
            dep_extras = dep.get("extra", [])
            errors.extend(
                f"{name}: banned extra {dep_name}[{extra}] required by {pkg}"
                for extra in (dep_extras if isinstance(dep_extras, list) else [])
                if (dep_name, normalize(str(extra))) in policy.py_banned_extras
            )
    return errors


def _group_lists(value: object) -> list[object]:
    if not isinstance(value, dict):
        return []
    return [item for group in value.values() if isinstance(group, list) for item in group]


def check_python_project(name: str, project: dict[str, object], workspace: set[str]) -> list[str]:
    """Runtime, optional, dependency-group and build requirements must all be exact pins."""
    deps: list[object] = []
    table = project.get("project", {})
    if isinstance(table, dict):
        if isinstance(table.get("dependencies"), list):
            deps.extend(table["dependencies"])
        deps.extend(_group_lists(table.get("optional-dependencies")))
    deps.extend(_group_lists(project.get("dependency-groups")))
    build = project.get("build-system", {})
    if isinstance(build, dict) and isinstance(build.get("requires"), list):
        deps.extend(build["requires"])
    return [
        f"{name}: dependency {spec!r} is not an exact pin (name==x.y.z)"
        for spec in map(str, deps)
        if normalize(spec) not in workspace and not PY_EXACT_PIN.match(spec)
    ]


def check_node_manifest(name: str, manifest: dict[str, object], policy: Policy) -> list[str]:
    errors: list[str] = []
    deps: dict[str, str] = {}
    for key in ("dependencies", "devDependencies", "optionalDependencies"):
        section = manifest.get(key, {})
        if isinstance(section, dict):
            deps.update({str(k): str(v) for k, v in section.items()})
    for package, spec in sorted(deps.items()):
        if package in policy.node_banned:
            errors.append(f"{name}: banned package {package}")
        if not NODE_EXACT_PIN.match(spec):
            errors.append(f"{name}: {package} {spec!r} is not an exact pin (x.y.z)")
    for floor in policy.node_floors:
        pinned = deps.get(floor.package)
        if pinned is None or not NODE_EXACT_PIN.match(pinned):
            continue
        if version_tuple(pinned) < version_tuple(floor.minimum):
            errors.append(f"{name}: {floor.package} {pinned} is below the floor {floor.minimum} ({floor.origin})")
    return errors


def _load_toml(root: Path, rel: str) -> dict[str, object]:
    return tomllib.loads((root / rel).read_text())


MANIFEST_NAMES = {"pyproject.toml": "python_projects", "uv.lock": "python_locks", "package.json": "node_manifests"}
# Lists that may never be empty: this repo always has Python projects and lockfiles. The node list stays empty
# until web/package.json exists (WP-18); a package.json the list does not name fails below either way.
NON_EMPTY_LISTS = ("python_projects", "python_locks")


def coverage_errors(root: Path, policy: Policy) -> list[str]:
    """Every manifest and lockfile in the repo must be listed, so none escapes the policy."""
    listed = {
        "python_projects": set(policy.python_projects),
        "python_locks": set(policy.python_locks),
        "node_manifests": set(policy.node_manifests),
    }
    errors = [f"policy list {key} is empty" for key in NON_EMPTY_LISTS if not listed[key]]
    for path in proc.repo_files(root):
        key = MANIFEST_NAMES.get(path.rsplit("/", 1)[-1])
        if key is not None and path not in listed[key]:
            errors.append(f"{path} is not listed in {POLICY_PATH} {key}")
    return errors


def run_checks(root: Path, policy: Policy) -> list[str]:
    errors: list[str] = coverage_errors(root, policy)
    projects = {rel: _load_toml(root, rel) for rel in policy.python_projects}
    workspace: set[str] = set()
    for project in projects.values():
        table = project.get("project", {})
        if isinstance(table, dict) and isinstance(table.get("name"), str):
            workspace.add(normalize(table["name"]))
    for rel in policy.python_locks:
        errors.extend(check_python_lock(rel, _load_toml(root, rel), policy))
    for rel, project in projects.items():
        errors.extend(check_python_project(rel, project, workspace))
    for rel in policy.node_manifests:
        errors.extend(check_node_manifest(rel, json.loads((root / rel).read_text()), policy))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        policy = parse_policy((root / POLICY_PATH).read_text())
        errors = run_checks(root, policy)
    except (OSError, ValueError, tomllib.TOMLDecodeError) as exc:
        sys.stderr.write(f"deps-policy: FAIL: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"deps-policy: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write("deps-policy: OK\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
