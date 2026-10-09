"""`python -m arena_core.scenario`: the commands the authoring loop runs (S1 8.2, 8.5), and `--counts`, which
lets nothing but outcome codes and counts leave the process (S1 L7)."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from arena_core.ids import canonical_sha256
from arena_core.scenario import __main__ as scenario_main
from arena_core.scenario import cli
from arena_core.scenario.cli import main
from tools.tests.subprocess_support import run_role_module

REPO_ROOT = Path(__file__).resolve().parents[4]
SEED_DIR = REPO_ROOT / "cases" / "dev"
SOURCE_DIR = SEED_DIR / "sources"
CORPUS = ["--dev-dir", str(SEED_DIR)]
CODEX = {"rounds": 1, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"}
ARGPARSE_USAGE_ERROR = 2
SECOND_REVISION = 2
HIDDEN_TEXT = "HIDDEN-CASE-TEXT"  # stands in for hidden case content
HIDDEN_NAME = "H0a1b2c3d4e.json"


def write_json(path: Path, obj: object) -> Path:
    path.write_text(json.dumps(obj), encoding="utf-8")
    return path


def nothing_leaked(out: str, err: str) -> bool:
    return all(marker not in out + err for marker in (HIDDEN_TEXT, "H0a1b2c3d4e"))


def dev_without_f02(tmp_path: Path) -> list[str]:
    """A dev-split directory without the committed F02 (the test edits a copy of it)."""
    directory = tmp_path / "dev-without-f02"
    directory.mkdir(exist_ok=True)
    for path in sorted(SEED_DIR.glob("F*.json")):
        if path.stem != "F02":
            (directory / path.name).write_bytes(path.read_bytes())
    return ["--dev-dir", str(directory)]


def review_file(tmp_path: Path, family_path: Path, **changes: object) -> Path:
    """A passed Codex review of the family file at `family_path` (bound by its canonical-JSON hash)."""
    family_hash = canonical_sha256(json.loads(family_path.read_text(encoding="utf-8")))
    return write_json(tmp_path / "codex.json", {**CODEX, "family_sha256": family_hash, **changes})


@pytest.fixture
def codex(tmp_path: Path) -> Path:
    return review_file(tmp_path, SEED_DIR / "F03.json")


def source_copy(tmp_path: Path, family_id: str) -> Path:
    """A committed source copied out of the repository, so no command can write back into it."""
    path = tmp_path / f"{family_id}.source.json"
    path.write_bytes((SOURCE_DIR / f"{family_id}.source.json").read_bytes())
    return path


def test_assemble_prints_the_family(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source = source_copy(tmp_path, "F01")
    assert main(["assemble", str(source)]) == 0
    assert capsys.readouterr().out == (SEED_DIR / "F01.json").read_text(encoding="utf-8")
    assert source.read_bytes() == (SOURCE_DIR / "F01.source.json").read_bytes()  # nothing drawn, nothing written


def test_assemble_writes_the_family_atomically(tmp_path: Path) -> None:
    source = source_copy(tmp_path, "F02")
    out = tmp_path / "F02.json"
    assert main(["assemble", str(source), "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8") == (SEED_DIR / "F02.json").read_text(encoding="utf-8")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["F02.json", "F02.source.json"]


def test_assemble_draws_and_records_missing_identifiers(
    tmp_path: Path, source_dict: Callable[[str], dict[str, Any]]
) -> None:
    """S1 8.3: case IDs and canaries are drawn once, written into the source, then reproduced."""
    data = source_dict("F02")
    for variant in data["variants"].values():
        del variant["case_id"], variant["canaries"]
    source = write_json(tmp_path / "F02.source.json", data)
    out = tmp_path / "F02.json"
    assert main(["assemble", str(source), "--out", str(out)]) == 0
    recorded = json.loads(source.read_text(encoding="utf-8"))
    assert source.read_text(encoding="utf-8").endswith("}\n")
    family = json.loads(out.read_text(encoding="utf-8"))
    for v in ("truthful", "deceptive"):
        assert family["variants"][v]["case_id"] == recorded["variants"][v]["case_id"]
        assert family["variants"][v]["private_packet"]["canary"] == recorded["variants"][v]["canaries"]["private"]
    first = out.read_text(encoding="utf-8")
    assert main(["assemble", str(source), "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8") == first


def test_assemble_revise_makes_the_next_revision(tmp_path: Path) -> None:
    source = source_copy(tmp_path, "F01")
    out = tmp_path / "F01.r2.json"
    assert main(["assemble", str(source), "--revise", "--out", str(out)]) == 0
    family = json.loads(out.read_text(encoding="utf-8"))
    original = json.loads((SEED_DIR / "F01.json").read_text(encoding="utf-8"))
    assert family["revision"] == json.loads(source.read_text(encoding="utf-8"))["family"]["revision"] == SECOND_REVISION
    old_ids = {original["variants"][v]["case_id"] for v in ("truthful", "deceptive")}
    assert {family["variants"][v]["case_id"] for v in ("truthful", "deceptive")}.isdisjoint(old_ids)
    assert main(["validate", str(SEED_DIR / "F01.json"), str(out)]) == 0


def test_assemble_refuses_a_source_that_is_not_an_object(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source = write_json(tmp_path / "list.source.json", [1, 2])
    assert main(["assemble", str(source)]) == 1
    assert "one JSON object" in capsys.readouterr().err
    assert json.loads(source.read_text(encoding="utf-8")) == [1, 2]


def test_assemble_reports_an_unwritable_source(
    tmp_path: Path, source_dict: Callable[[str], dict[str, Any]], capsys: pytest.CaptureFixture[str]
) -> None:
    data = source_dict("F02")
    del data["variants"]["truthful"]["case_id"]
    source_dir = tmp_path / "sources"
    source_dir.mkdir()
    source = write_json(source_dir / "F02.source.json", data)
    before = source.read_bytes()
    source_dir.chmod(0o555)  # no temporary file can be created beside the source
    try:
        out = tmp_path / "F02.json"
        report_code = main(["assemble", "--counts", "--out", str(out), str(source)])
    finally:
        source_dir.chmod(0o755)
    assert report_code == 1
    assert json.loads(capsys.readouterr().out) == {"OUTPUT.unwritable": 1}
    assert source.read_bytes() == before  # a retry draws again and rewrites both


@pytest.mark.parametrize("target", ["source", "authoring"])
def test_assemble_refuses_an_output_that_is_one_of_its_inputs(
    target: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = source_copy(tmp_path, "F01")
    before = source.read_bytes()
    authoring = write_json(tmp_path / "authoring.json", {"spec": {}})
    argv = ["assemble", str(source), "--counts", "--out", str(source if target == "source" else authoring)]
    if target == "authoring":
        argv += ["--authoring", str(authoring)]
    assert main(argv) == 1
    assert json.loads(capsys.readouterr().out) == {"OUTPUT.collides": 1}
    assert source.read_bytes() == before
    assert json.loads(authoring.read_text(encoding="utf-8")) == {"spec": {}}


def test_a_failed_revise_leaves_the_source_unchanged_for_a_retry(tmp_path: Path) -> None:
    """S1 8.6: a revise whose family cannot be written does not advance the source; the retry makes r2."""
    source = source_copy(tmp_path, "F01")
    before = source.read_bytes()
    assert main(["assemble", str(source), "--revise", "--out", str(tmp_path / "missing" / "F01.json")]) == 1
    assert source.read_bytes() == before
    out = tmp_path / "F01.r2.json"
    assert main(["assemble", str(source), "--revise", "--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["revision"] == SECOND_REVISION
    assert json.loads(source.read_text(encoding="utf-8"))["family"]["revision"] == SECOND_REVISION


def test_a_revise_that_does_not_assemble_writes_nothing(
    tmp_path: Path, source_dict: Callable[[str], dict[str, Any]]
) -> None:
    data = source_dict("F01")
    data["public"]["opening_question"] = "What did you do near Rack R2 that afternoon?"
    source = write_json(tmp_path / "F01.source.json", data)
    before = source.read_bytes()
    out = tmp_path / "F01.json"
    assert main(["assemble", str(source), "--revise", "--out", str(out)]) == 1
    assert (source.read_bytes(), out.exists()) == (before, False)


def test_assemble_reports_an_unwritable_output(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "missing-dir" / "F01.json"
    assert main(["assemble", str(source_copy(tmp_path, "F01")), "--out", str(out)]) == 1
    assert "cannot write" in capsys.readouterr().err
    assert not out.parent.exists()


def test_assemble_reports_a_bad_source(
    tmp_path: Path, source_dict: Callable[[str], dict[str, Any]], capsys: pytest.CaptureFixture[str]
) -> None:
    data = source_dict("F01")
    data["public"]["opening_question"] = "What did you do near Rack R2 that afternoon?"
    path = write_json(tmp_path / "bad.source.json", data)
    assert main(["assemble", str(path)]) == 1
    assert "public.opening_question: ['R2']" in capsys.readouterr().err
    assert main(["assemble", str(tmp_path / "missing.json")]) == 1
    assert "cannot read" in capsys.readouterr().err


def test_validate_passes_the_dev_families_silently(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["validate", *(str(SEED_DIR / f"F0{i}.json") for i in range(1, 10))]) == 0
    assert capsys.readouterr().out == ""


def test_validate_lists_issues_or_only_their_counts(
    tmp_path: Path, seed: Callable[[str], dict[str, Any]], capsys: pytest.CaptureFixture[str]
) -> None:
    family = seed("F01")
    family["variants"]["deceptive"]["private_packet"]["style"]["affect"] = "calm"
    path = write_json(tmp_path / "F01.json", family)
    assert main(["validate", str(path)]) == 1
    assert capsys.readouterr().out == "V2.style [F01/deceptive] private style differs from the family style (M6)\n"
    assert main(["validate", "--counts", str(path)]) == 1
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == ('{"V2.style":1}\n', "")


@pytest.mark.parametrize(
    ("content", "code"),
    [
        (f'{{"{HIDDEN_TEXT}": 1, "{HIDDEN_TEXT}": 2}}', "INPUT.not_strict_json"),
        (f'{{"note": "{HIDDEN_TEXT}"', "INPUT.not_json"),
    ],
)
def test_counts_mode_never_echoes_file_content_or_names(
    tmp_path: Path, content: str, code: str, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / HIDDEN_NAME
    path.write_text(content, encoding="utf-8")
    assert main(["validate", "--counts", str(path)]) == 1
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == (f'{{"{code}":1}}\n', "")
    assert nothing_leaked(captured.out, captured.err)
    assert main(["validate", "--counts", str(tmp_path / "missing" / HIDDEN_NAME)]) == 1
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == ('{"INPUT.unreadable":1}\n', "")


def test_counts_mode_covers_assembly_and_bundling(
    tmp_path: Path,
    seed: Callable[[str], dict[str, Any]],
    source_dict: Callable[[str], dict[str, Any]],
    capsys: pytest.CaptureFixture[str],
) -> None:
    data = source_dict("F01")
    data["public"]["opening_question"] = f"What did you do near Rack R2, {HIDDEN_TEXT}?"
    source = write_json(tmp_path / HIDDEN_NAME, data)
    out = tmp_path / "family.json"
    assert main(["assemble", "--counts", "--out", str(out), str(source)]) == 1
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == ('{"SOURCE.problem":1}\n', "")
    assert nothing_leaked(captured.out, captured.err)
    data["public"]["opening_question"] = HIDDEN_TEXT
    data["persona"]["tenure_years"] = "four"
    write_json(source, data)
    assert main(["assemble", "--counts", "--out", str(out), str(source)]) == 1
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == ('{"SOURCE.model":1}\n', "")
    assert nothing_leaked(captured.out, captured.err)
    family = seed("F02")
    family["variants"]["truthful"]["evaluator_packet"]["role"] = "deceptive"
    family["variants"]["truthful"]["evaluator_packet"]["synopsis"] += " " + HIDDEN_TEXT
    path = write_json(tmp_path / "F02.json", family)
    codex = review_file(tmp_path, path)  # the corpus leaves out the committed F02 this edits
    assert (
        main(
            [
                "bundle",
                "--counts",
                "--codex",
                str(codex),
                "--out",
                str(tmp_path / "bundle.json"),
                str(path),
                *dev_without_f02(tmp_path),
            ]
        )
        == 1
    )
    captured = capsys.readouterr()
    assert (json.loads(captured.out), captured.err) == ({"V2.correct_finding": 1, "V2.labels": 1}, "")
    assert nothing_leaked(captured.out, captured.err)


def test_counts_mode_writes_results_only_to_out(
    tmp_path: Path, codex: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "bundle.json"
    assert (
        main(["bundle", "--counts", "--codex", str(codex), "--out", str(out), str(SEED_DIR / "F03.json"), *CORPUS]) == 0
    )
    assert (capsys.readouterr().out, json.loads(out.read_text(encoding="utf-8"))["family_code"]) == ("{}\n", "F03")
    for argv in (["bundle", "--codex", str(codex), *CORPUS], ["assemble"]):
        path = SEED_DIR / "F03.json" if argv[0] == "bundle" else source_copy(tmp_path, "F03")
        with pytest.raises(SystemExit) as caught:
            main([*argv, "--counts", str(path)])
        assert caught.value.code == ARGPARSE_USAGE_ERROR


def test_bundle_prints_the_ingest_bundle(codex: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["bundle", str(SEED_DIR / "F03.json"), "--codex", str(codex), *CORPUS]) == 0
    bundle = json.loads(capsys.readouterr().out)
    assert bundle["family_code"] == "F03"
    assert bundle["attestation"]["codex"] == CODEX
    assert len(bundle["variants"]) == len(("truthful", "deceptive"))


def test_bundle_refuses_an_invalid_family(
    tmp_path: Path, codex: Path, seed: Callable[[str], dict[str, Any]], capsys: pytest.CaptureFixture[str]
) -> None:
    family = seed("F02")
    family["variants"]["truthful"]["evaluator_packet"]["role"] = "deceptive"
    path = write_json(tmp_path / "F02.json", family)
    assert main(["bundle", str(path), "--codex", str(codex), *dev_without_f02(tmp_path)]) == 1
    assert "V2.labels [F02/truthful]" in capsys.readouterr().out
    not_an_object = write_json(tmp_path / "list.json", [1, 2])
    assert main(["bundle", str(not_an_object), "--codex", str(codex), *CORPUS]) == 1
    assert "one JSON object" in capsys.readouterr().err


def test_bundle_reports_a_missing_dev_split_and_a_hidden_record(
    tmp_path: Path, codex: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = ["--counts", "--out", str(tmp_path / "b")]
    family = str(SEED_DIR / "F03.json")
    assert main(["bundle", family, "--codex", str(codex), "--dev-dir", str(tmp_path / "empty"), *out]) == 1
    assert json.loads(capsys.readouterr().out) == {"INPUT.unreadable": 1}
    record = write_json(tmp_path / "record.json", {"assignment": [{"family_id": "F03"}]})
    argv = ["bundle", family, "--codex", str(codex), *CORPUS, "--sampler-record", str(record), *out]
    assert main([*argv, "--hidden", str(SEED_DIR / "F01.json")]) == 1  # a dev family takes no hidden split
    assert json.loads(capsys.readouterr().out) == {"CORPUS.hidden_split": 1}


def test_bundle_refuses_a_codex_review_that_did_not_pass(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    failed = review_file(tmp_path, SEED_DIR / "F03.json", cx3="fail")
    assert (
        main(
            [
                "bundle",
                str(SEED_DIR / "F03.json"),
                "--codex",
                str(failed),
                "--counts",
                "--out",
                str(tmp_path / "b"),
                *CORPUS,
            ]
        )
        == 1
    )
    assert json.loads(capsys.readouterr().out) == {"CODEX.model": 1}
    assert main(["bundle", str(SEED_DIR / "F03.json"), "--codex", str(tmp_path / "missing.json"), *CORPUS]) == 1
    assert "cannot read" in capsys.readouterr().err


def test_an_unloadable_authoring_file_is_reported(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bad = write_json(tmp_path / "authoring.json", {"spec": {}})
    out = tmp_path / "family.json"
    source = source_copy(tmp_path, "F01")
    assert main(["assemble", str(source), "--authoring", str(bad), "--counts", "--out", str(out)]) == 1
    assert set(json.loads(capsys.readouterr().out)) == {"AUTHORING.model"}
    assert not out.exists()


def test_usage_errors_exit_2() -> None:
    with pytest.raises(SystemExit) as caught:
        main(["publish"])
    assert caught.value.code == ARGPARSE_USAGE_ERROR


def test_the_module_runs_as_a_program() -> None:
    """`python -m arena_core.scenario` is the CLI: a real process with no command exits with a usage error."""
    assert scenario_main.main is main
    result = run_role_module("arena_core.scenario", {})
    assert result.returncode == ARGPARSE_USAGE_ERROR
    assert result.stderr.startswith("usage: python -m arena_core.scenario")


@pytest.mark.parametrize(
    "argv",
    [
        ["validate", "--counts", HIDDEN_NAME, "--authoring", HIDDEN_NAME],
        ["bundle", HIDDEN_NAME, "--counts", "--bogus", HIDDEN_TEXT],
        ["assemble", "--counts", HIDDEN_NAME],
        ["--counts", "publish", HIDDEN_NAME],
        ["validate", "--count", HIDDEN_NAME, "--authoring", HIDDEN_NAME],
        ["validate", "--co", HIDDEN_NAME, "--authoring", HIDDEN_NAME],
        ["validate", "--counts=yes", HIDDEN_NAME],
    ],
)
def test_counts_mode_covers_usage_errors(argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    """S1 L7: with --counts even a usage error is a code and a count; no argument value is echoed."""
    with pytest.raises(SystemExit) as caught:
        main(argv)
    assert caught.value.code == ARGPARSE_USAGE_ERROR
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"USAGE.invalid": 1}
    assert captured.err == ""
    assert nothing_leaked(captured.out, captured.err)


def test_usage_errors_without_counts_explain_themselves(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as caught:
        main(["validate", "x.json", "--bogus"])
    assert caught.value.code == ARGPARSE_USAGE_ERROR
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "unrecognized arguments: --bogus" in captured.err
    assert captured.err.startswith("usage:")


def test_option_abbreviations_are_not_accepted(capsys: pytest.CaptureFixture[str]) -> None:
    """`--count` is not `--counts`: a privacy flag is spelled out, never guessed."""
    with pytest.raises(SystemExit):
        main(["validate", "--count", str(SEED_DIR / "F01.json")])
    assert json.loads(capsys.readouterr().out) == {"USAGE.invalid": 1}


def test_counts_mode_reports_a_deeply_nested_file_as_a_code(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    deep = tmp_path / HIDDEN_NAME
    deep.write_text("[" * 100_000 + "]" * 100_000, encoding="utf-8")
    assert main(["validate", "--counts", str(deep)]) == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"INPUT.not_strict_json": 1}
    assert nothing_leaked(captured.out, captured.err)


def test_counts_mode_reports_parseable_but_absurd_nesting_as_a_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    deep = tmp_path / HIDDEN_NAME
    deep.write_text("[" * 2000 + "]" * 2000, encoding="utf-8")
    assert main(["validate", "--counts", str(deep)]) == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"INPUT.not_strict_json": 1}
    assert nothing_leaked(captured.out, captured.err)


def test_each_write_uses_its_own_temporary_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two writers to one --out never share a temporary file: each publishes exactly what it wrote."""
    out = tmp_path / "family.json"
    staged: list[tuple[str, str]] = []
    real_replace = os.replace

    def record(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
        staged.append((Path(src).name, Path(src).read_text(encoding="utf-8")))
        real_replace(src, dst)

    monkeypatch.setattr(os, "replace", record)
    report = cli.Report(counts=True)
    cli.write_output(report, out, "first")
    cli.write_output(report, out, "second")
    assert [text for _name, text in staged] == ["first", "second"]
    assert staged[0][0] != staged[1][0]
    assert out.read_text(encoding="utf-8") == "second"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["family.json"]
    assert not report.codes


def test_a_failed_publish_leaves_no_temporary_file(tmp_path: Path) -> None:
    out = tmp_path / "family.json"
    out.mkdir()  # replacing a directory with a file fails
    report = cli.Report(counts=True)
    cli.write_output(report, out, "text")
    assert report.codes == {"OUTPUT.unwritable": 1}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["family.json"]
