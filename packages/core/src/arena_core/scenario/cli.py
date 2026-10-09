"""Command line for the authoring loop (S1 8.2, 8.5): `python -m arena_core.scenario <command>`.

- `assemble SOURCE [--authoring AUTHORING.json] [--revise] [--out FAMILY]`: assemble a family source into a
  case-family file; with `--authoring` (seed spec, brief, model, date) the code-owned fields come from the
  seed (S1 8.3). Case IDs and canaries missing from the source are drawn (`draw_identifiers`) and recorded in
  the source file first; `--revise` makes the source the next revision with new ones (S1 8.6).
- `validate FAMILY...`: run V1-V4 on each family file and V5 across them.
- `bundle FAMILY --codex CODEX.json --dev-dir DIR [--hidden FAMILY... --sampler-record RECORD.json]
  [--out BUNDLE]`: the S4 `sealed.ingest_case_family` bundle of a valid family, with its source text and
  attestation (S1 10.5). CODEX.json is the passed Codex review (`CodexReview`); V5 compares the family with
  every development family file in DIR (`cases/dev`) and, for a hidden family, with the rest of the hidden
  split, which must be exactly the families the split's sampler record names (`load.corpus_issues`).

`--counts` (every command) prints one JSON object of outcome codes and counts and nothing else, on every
path: validator rule IDs, `INPUT.*` for unreadable or non-strict files, `SOURCE.*` and `AUTHORING.*` for a
source or authoring context that does not load or assemble, `OUTPUT.unwritable`, `USAGE.invalid` for a
command line that does not parse (argument values are never echoed). That is the only form in
which hidden-family results may leave the isolated authoring session (S1 L7); with `--counts`, a family or
bundle is written only to `--out`. Exit status: 0 when nothing was found, 1 otherwise, 2 for a usage error.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any, NoReturn

from pydantic import ValidationError

from arena_core.ids import StrictJSONError, canonical_json, read_json_text
from arena_core.scenario.assemble import assemble, draw_identifiers, dump_family, new_revision
from arena_core.scenario.brief import load_authoring
from arena_core.scenario.load import CodexReview, DevSplit, FamilyLoadError, ingest_bundle, read_family_file
from arena_core.scenario.source import SourceError, parse_source
from arena_core.scenario.validators import Issue, validate_families

USAGE_ERROR = 2  # argparse convention


class Report:
    """Collects outcome codes; writes details unless `counts` is set, then only the code counts."""

    def __init__(self, *, counts: bool) -> None:
        self.counts = counts
        self.codes: Counter[str] = Counter()

    def problem(self, code: str, detail: str, n: int = 1) -> None:
        self.codes[code] += n
        if not self.counts:
            sys.stderr.write(f"{detail}\n")

    def issues(self, issues: Sequence[Issue]) -> None:
        self.codes.update(i.rule for i in issues)
        if not self.counts:
            sys.stdout.writelines(f"{issue}\n" for issue in issues)

    def failure(self, exc: Exception, *, area: str, where: str) -> None:
        """Map an exception to one outcome code (and its detail line)."""
        if isinstance(exc, FamilyLoadError):
            self.issues(exc.issues)
        elif isinstance(exc, OSError):
            self.problem("INPUT.unreadable", f"{where}: cannot read: {exc}")
        elif isinstance(exc, StrictJSONError):
            self.problem("INPUT.not_strict_json", f"{where}: {exc}")
        elif isinstance(exc, json.JSONDecodeError):
            self.problem("INPUT.not_json", f"{where}: not JSON: {exc}")
        elif isinstance(exc, ValidationError):
            self.problem(f"{area}.model", f"{where}: {exc}", exc.error_count())
        elif isinstance(exc, SourceError):
            self.problem(f"{area}.problem", f"{where}: {exc}", len(exc.problems))
        else:
            self.problem("INPUT.not_an_object", f"{where}: {exc}")

    def finish(self) -> int:
        if self.counts:
            sys.stdout.write(canonical_json(dict(sorted(self.codes.items()))) + "\n")
        return 1 if self.codes else 0


def write_output(report: Report, out: Path | None, text: str) -> None:
    """`text` to stdout, or atomically to `out`: written to a temporary file of its own, created exclusively
    beside `out` (so two writers never share one), then renamed over `out`; removed if anything fails."""
    if out is None:
        sys.stdout.write(text)
        return
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=out.parent, prefix=f".{out.name}.", suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(text)
        temporary.replace(out)
    except OSError as exc:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        report.problem("OUTPUT.unwritable", f"cannot write {out}: {exc}")


def _source_object(path: Path) -> dict[str, Any]:
    raw = read_json_text(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        msg = f"{path.name}: a family source holds one JSON object"
        raise TypeError(msg)
    return raw


def _assemble(args: argparse.Namespace, report: Report) -> None:
    inputs = [p for p in (args.source, args.authoring) if p is not None]
    if args.out is not None and any(args.out.resolve() == p.resolve() for p in inputs):
        report.problem("OUTPUT.collides", f"--out {args.out} is an input of the command")
        return
    authoring = None
    if args.authoring is not None:
        try:
            authoring = load_authoring(args.authoring)
        except (OSError, ValueError) as exc:
            report.failure(exc, area="AUTHORING", where=str(args.authoring))
            return
    try:
        raw = _source_object(args.source)
        parse_source(raw)  # the source model holds before anything is drawn
        drawn = draw_identifiers(new_revision(raw) if args.revise else raw)
        family = assemble(parse_source(drawn), authoring)
    except (OSError, ValueError, TypeError) as exc:  # unreadable, not strict JSON, not a source, not assembled
        report.failure(exc, area="SOURCE", where=str(args.source))
        return
    # Nothing is written until the family is built; then the family first and the source last, so a failed
    # write never leaves a source whose new revision or identifiers belong to no family: a retry starts from
    # the unchanged source. Drawn identifiers are recorded so a rebuild reproduces the family (AC-S1-26).
    write_output(report, args.out, dump_family(family))
    if drawn != raw and not report.codes:
        write_output(report, args.source, canonical_json(drawn) + "\n")


def _validate(args: argparse.Namespace, report: Report) -> None:
    families: list[object] = []
    for path in args.families:
        try:
            families.append(read_json_text(path.read_text(encoding="utf-8")))
        except (OSError, ValueError) as exc:
            report.failure(exc, area="INPUT", where=str(path))
    if not report.codes:
        report.issues(validate_families(families))


def _bundle(args: argparse.Namespace, report: Report) -> None:
    try:
        codex = CodexReview.model_validate_json(canonical_json(read_json_text(args.codex.read_text(encoding="utf-8"))))
    except (OSError, ValueError) as exc:
        report.failure(exc, area="CODEX", where=str(args.codex))
        return
    try:
        dev = DevSplit.from_dir(args.dev_dir)
        hidden = [read_family_file(path) for path in args.hidden]
        record = read_family_file(args.sampler_record) if args.sampler_record is not None else None
        bundle = ingest_bundle(read_family_file(args.family), codex, dev, hidden, record)
    except (OSError, ValueError, TypeError) as exc:  # unreadable, not strict JSON, not an object, not loadable
        report.failure(exc, area="INPUT", where=str(args.family))
        return
    write_output(report, args.out, bundle.to_json() + "\n")


class _UsageError(Exception):
    def __init__(self, parser: argparse.ArgumentParser, message: str) -> None:
        super().__init__(message)
        self.parser = parser


class _Parser(argparse.ArgumentParser):
    """Raises instead of printing, so `main` decides what a usage error may show (codes only under
    --counts, S1 L7). Subcommand parsers are created with this class too (argparse's `parser_class`)."""

    def error(self, message: str) -> NoReturn:
        raise _UsageError(self, message)


def _counts_requested(raw: Sequence[str]) -> bool:
    """Whether the command line asks for counts mode in any spelling (`--counts`, `--counts=x`, `--count`,
    `--co`): a usage error is then shown as a code and a count only, even if the spelling was wrong."""
    for token in raw:
        name = token.split("=", 1)[0]
        if name.startswith("--co") and "--counts".startswith(name):
            return True
    return False


def build_parser() -> argparse.ArgumentParser:
    # allow_abbrev=False everywhere: `--count` is never taken for the privacy flag `--counts`.
    parser = _Parser(prog="python -m arena_core.scenario", description="S1 scenario engine", allow_abbrev=False)
    sub = parser.add_subparsers(dest="command", required=True)
    counts_help = "print outcome codes and counts only (S1 L7); output goes to --out only"
    assemble_cmd = sub.add_parser("assemble", help="assemble a family source into a family file", allow_abbrev=False)
    assemble_cmd.add_argument("source", type=Path)
    assemble_cmd.add_argument("--authoring", type=Path, default=None, help="seed spec, brief, model and date (JSON)")
    assemble_cmd.add_argument("--revise", action="store_true", help="next revision with new case IDs (S1 8.6)")
    assemble_cmd.add_argument("--out", type=Path, default=None)
    assemble_cmd.add_argument("--counts", action="store_true", help=counts_help)
    assemble_cmd.set_defaults(run=_assemble, needs_out=True)
    validate_cmd = sub.add_parser("validate", help="run V1-V4 per family and V5 across them", allow_abbrev=False)
    validate_cmd.add_argument("families", type=Path, nargs="+")
    validate_cmd.add_argument("--counts", action="store_true", help=counts_help)
    validate_cmd.set_defaults(run=_validate, needs_out=False)
    bundle_cmd = sub.add_parser("bundle", help="print the S4 ingest bundle of a family file", allow_abbrev=False)
    bundle_cmd.add_argument("family", type=Path)
    bundle_cmd.add_argument("--codex", type=Path, required=True, help="the passed Codex review (JSON)")
    bundle_cmd.add_argument("--dev-dir", type=Path, required=True, help="the development split (cases/dev)")
    bundle_cmd.add_argument("--hidden", type=Path, nargs="+", default=[], help="the rest of a hidden split")
    bundle_cmd.add_argument("--sampler-record", type=Path, default=None, help="the hidden split's sampler record")
    bundle_cmd.add_argument("--out", type=Path, default=None)
    bundle_cmd.add_argument("--counts", action="store_true", help=counts_help)
    bundle_cmd.set_defaults(run=_bundle, needs_out=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        args = parser.parse_args(raw)
        if args.counts and args.needs_out and args.out is None:
            parser.error("--counts writes nothing but codes and counts to the terminal; give --out")
    except _UsageError as exc:
        if _counts_requested(raw):  # an argument value may name hidden material: codes and counts only
            sys.stdout.write(canonical_json({"USAGE.invalid": 1}) + "\n")
        else:
            exc.parser.print_usage(sys.stderr)
            sys.stderr.write(f"{exc.parser.prog}: error: {exc}\n")
        raise SystemExit(USAGE_ERROR) from None
    report = Report(counts=args.counts)
    args.run(args, report)
    return report.finish()
