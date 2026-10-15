"""CodeQL security-extended gate (S5 11.1 sec-check: CodeQL, fail-closed), run locally with the pinned bundle.

For each language: build a database from the scoped source root, analyze it with the
security-extended suite, and count SARIF results. Fails closed: a missing, empty or malformed SARIF, a
failed database build (CodeQL refuses one with no source for the language) or analysis, or any result.

``--sarif FILE...`` only validates existing SARIF files with the same rules, for a report produced any
other way than this module's own ``--out`` path. CodeQL runs only locally, inside `make sec-check` --
never as a GitHub Actions workflow, since code-scanning upload needs a GitHub Advanced Security license
this private repo does not carry.
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from tools import proc


@dataclass(frozen=True)
class Language:
    name: str
    source_root: str
    config: str
    suite: str


# Python only until web/ exists: WP-18 adds the javascript-typescript entry (source root "web", its own
# paths-ignore config, the javascript-security-extended suite) together with the web tree, as TechnoMile has it.
LANGUAGES = (
    Language(
        "python", ".", "tools/codeql/python.yml", "codeql/python-queries:codeql-suites/python-security-extended.qls"
    ),
)


class CodeQLError(RuntimeError):
    """CodeQL could not produce a trustworthy result."""


def sarif_findings(sarif_path: Path) -> list[str]:
    """Every result in a SARIF file; a missing, empty or malformed report raises (never counts as zero)."""
    if not sarif_path.is_file():
        msg = f"no SARIF at {sarif_path}; refusing to pass"
        raise CodeQLError(msg)
    try:
        report = json.loads(sarif_path.read_text())
    except json.JSONDecodeError as exc:
        msg = f"SARIF at {sarif_path} is not valid JSON ({exc}); refusing to pass"
        raise CodeQLError(msg) from exc
    if not isinstance(report, dict):
        msg = f"SARIF at {sarif_path} is not a SARIF object; refusing to pass"
        raise CodeQLError(msg)
    runs = report.get("runs")
    if not isinstance(runs, list) or not runs:
        msg = f"SARIF at {sarif_path} has no runs; refusing to pass"
        raise CodeQLError(msg)
    findings: list[str] = []
    for index, run in enumerate(runs):
        if not isinstance(run, dict):
            msg = f"SARIF at {sarif_path}: run {index} is not an object; refusing to pass"
            raise CodeQLError(msg)
        results = run.get("results")
        # SARIF 2.1.0 3.14.23: an absent results array means the tool did not produce results.
        if not isinstance(results, list):
            msg = f"SARIF at {sarif_path}: run {index} has no results array; refusing to pass"
            raise CodeQLError(msg)
        findings.extend(_describe(result) for result in results)
    return findings


def _field(value: object, *keys: str) -> object:
    """``value[k1][k2]...`` through nested objects, or "?" where a level is missing or not an object."""
    for key in keys:
        value = value.get(key, "?") if isinstance(value, dict) else "?"
    return value


def _describe(result: object) -> str:
    """One line per result. Every result counts as a finding, however malformed its location is."""
    locations = _field(result, "locations")
    first = locations[0] if isinstance(locations, list) and locations else {}
    uri = _field(first, "physicalLocation", "artifactLocation", "uri")
    line = _field(first, "physicalLocation", "region", "startLine")
    return f"{_field(result, 'ruleId')} {uri}:{line} {_field(result, 'message', 'text')}"


def analyze(language: Language, root: Path, out_dir: Path) -> list[str]:
    database = out_dir / f"codeql-db-{language.name}"
    sarif = out_dir / f"codeql-{language.name}.sarif"
    out_dir.mkdir(parents=True, exist_ok=True)
    sarif.unlink(missing_ok=True)
    create = proc.run(
        "codeql",
        [
            "database",
            "create",
            str(database),
            f"--language={language.name}",
            f"--source-root={root / language.source_root}",
            f"--codescanning-config={root / language.config}",
            "--overwrite",
            "--threads=0",
            "--ram=3072",
        ],
    )
    if create.returncode != 0:
        msg = f"{language.name}: database create failed\n{create.stderr[-2000:]}"
        raise CodeQLError(msg)
    run = proc.run(
        "codeql",
        [
            "database",
            "analyze",
            str(database),
            language.suite,
            "--format=sarif-latest",
            f"--output={sarif}",
            "--threads=0",
            "--ram=3072",
        ],
    )
    if run.returncode != 0:
        msg = f"{language.name}: analysis failed\n{run.stderr[-2000:]}"
        raise CodeQLError(msg)
    return sarif_findings(sarif)


def validate_reports(paths: list[Path]) -> int:
    """The CI path: fail on any result, and on any missing, empty or malformed report."""
    failed = False
    for path in paths:
        try:
            findings = sarif_findings(path)
        except (CodeQLError, OSError) as exc:
            sys.stderr.write(f"codeql: FAIL: {exc}\n")
            failed = True
            continue
        for finding in findings:
            sys.stderr.write(f"codeql: FAIL: {path.name}: {finding}\n")
        failed = failed or bool(findings)
        sys.stdout.write(f"codeql: {path.name}: {len(findings)} findings\n")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--out", type=Path, default=Path(".gates"))
    parser.add_argument("--language", choices=[lang.name for lang in LANGUAGES], action="append")
    parser.add_argument("--sarif", type=Path, nargs="+", help="only validate these SARIF files (the CI path)")
    args = parser.parse_args(argv)
    if args.sarif:
        return validate_reports(args.sarif)
    root: Path = args.root.resolve()
    out: Path = args.out.resolve()
    selected = [lang for lang in LANGUAGES if not args.language or lang.name in args.language]
    failed = False
    for language in selected:
        try:
            findings = analyze(language, root, out)
        except (CodeQLError, LookupError, OSError, ValueError) as exc:
            sys.stderr.write(f"codeql: FAIL: {exc}\n")
            failed = True
            continue
        for finding in findings:
            sys.stderr.write(f"codeql: FAIL: {language.name}: {finding}\n")
        failed = failed or bool(findings)
        sys.stdout.write(f"codeql: {language.name}: {len(findings)} security-extended findings\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
