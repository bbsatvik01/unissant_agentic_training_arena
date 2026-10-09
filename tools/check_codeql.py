"""CodeQL security-extended gate (S5 11.1 sec-check: CodeQL, fail-closed), run locally with the pinned bundle.

For each language: build a database from the scoped source root, analyze it with the
security-extended suite, and count SARIF results. Fails closed: a missing or empty SARIF, a failed
database build (CodeQL refuses one with no source for the language) or analysis, or any result.
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
    if not sarif_path.is_file():
        msg = f"no SARIF at {sarif_path}; refusing to pass"
        raise CodeQLError(msg)
    runs = json.loads(sarif_path.read_text()).get("runs")
    if not isinstance(runs, list) or not runs:
        msg = f"SARIF at {sarif_path} has no runs; refusing to pass"
        raise CodeQLError(msg)
    findings: list[str] = []
    for run in runs:
        for result in run.get("results", []):
            location = result.get("locations", [{}])[0].get("physicalLocation", {})
            uri = location.get("artifactLocation", {}).get("uri", "?")
            line = location.get("region", {}).get("startLine", "?")
            text = result.get("message", {}).get("text", "")
            findings.append(f"{result.get('ruleId', '?')} {uri}:{line} {text}")
    return findings


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--out", type=Path, default=Path(".gates"))
    parser.add_argument("--language", choices=[lang.name for lang in LANGUAGES], action="append")
    args = parser.parse_args(argv)
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
