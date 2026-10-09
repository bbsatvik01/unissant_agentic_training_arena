"""Global hard gate (never rig, soften or bypass CI/tests): thresholds only ever get stricter, and
configs may not drift from the ratchet file. Lifted from TechnoMile tools/tests/test_check_ratchet.py
(fully generic: ATTRIBUTIONS.md); only the two tests against this repo's own ratchet.toml are adapted."""

from collections.abc import Mapping
from pathlib import Path

import pytest

from tools import check_ratchet
from tools.tests.conftest import REPO_ROOT, git_commit_all, git_init

BASE_VALUES: dict[str, object] = {"coverage.min": 90, "warnings.max": 0, "strict.frozen": True, "vitest.lines": 90}
SOURCES = {
    "coverage.min": ("min", '{ file = "pyproject.toml", toml_key = "tool.coverage.report.fail_under" }'),
    "warnings.max": ("max", "{ file = \"Makefile\", regex = '^MAX_WARNINGS := (\\d+)$' }"),
    "strict.frozen": ("frozen", '{ file = "pyproject.toml", toml_key = "tool.mypy.strict" }'),
    "vitest.lines": ("min", '{ file = "package.json", json_key = "gate.lines" }'),
}


def _toml(value: object) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


def ratchet_text(
    overrides: Mapping[str, object] | None = None, *, drop: str = "", directions: dict[str, str] | None = None
) -> str:
    values = {**BASE_VALUES, **(overrides or {})}
    blocks = []
    for ident, (direction, source) in SOURCES.items():
        if ident == drop:
            continue
        chosen = (directions or {}).get(ident, direction)
        blocks.append(
            f'[[threshold]]\nid = "{ident}"\nvalue = {_toml(values[ident])}\ndirection = "{chosen}"\n'
            f'origin = "test"\nsource = {source}\n'
        )
    return "\n".join(blocks)


def write_configs(root: Path, overrides: Mapping[str, object] | None = None) -> None:
    values = {**BASE_VALUES, **(overrides or {})}
    root.mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text(
        f"[tool.coverage.report]\nfail_under = {values['coverage.min']}\n\n"
        f"[tool.mypy]\nstrict = {_toml(values['strict.frozen'])}\n"
    )
    (root / "Makefile").write_text(f"MAX_WARNINGS := {values['warnings.max']}\n")
    (root / "package.json").write_text(f'{{"gate": {{"lines": {values["vitest.lines"]}}}}}')


def errors_for(root: Path, current: str, base: str | None, configs: Mapping[str, object] | None = None) -> list[str]:
    write_configs(root, configs)
    parsed_base = None if base is None else check_ratchet.parse(base)
    return check_ratchet.check(check_ratchet.parse(current), parsed_base, root)


def test_identical_ratchet_and_matching_config_passes(tmp_path: Path) -> None:
    assert errors_for(tmp_path, ratchet_text(), ratchet_text()) == []


def test_first_introduction_without_base_passes(tmp_path: Path) -> None:
    assert errors_for(tmp_path, ratchet_text(), None) == []


@pytest.mark.gateproof
def test_lowering_a_minimum_fails(tmp_path: Path) -> None:
    lowered = {"coverage.min": 80}
    errors = errors_for(tmp_path, ratchet_text(lowered), ratchet_text(), lowered)
    assert errors == ["coverage.min: minimum loosened 90 -> 80"]


@pytest.mark.gateproof
def test_raising_a_maximum_fails(tmp_path: Path) -> None:
    raised = {"warnings.max": 3}
    errors = errors_for(tmp_path, ratchet_text(raised), ratchet_text(), raised)
    assert errors == ["warnings.max: maximum loosened 0 -> 3"]


@pytest.mark.gateproof
def test_changing_a_frozen_parameter_fails(tmp_path: Path) -> None:
    changed = {"strict.frozen": False}
    errors = errors_for(tmp_path, ratchet_text(changed), ratchet_text(), changed)
    assert errors == ["strict.frozen: frozen value changed True -> False"]


@pytest.mark.gateproof
def test_deleting_an_entry_fails(tmp_path: Path) -> None:
    errors = errors_for(tmp_path, ratchet_text(drop="vitest.lines"), ratchet_text())
    assert errors == ["vitest.lines: removed from the ratchet (entries may never be deleted)"]


@pytest.mark.gateproof
def test_changing_direction_fails(tmp_path: Path) -> None:
    errors = errors_for(tmp_path, ratchet_text(directions={"warnings.max": "min"}), ratchet_text())
    assert errors == ["warnings.max: direction changed from max to min"]


@pytest.mark.gateproof
def test_repointing_a_source_fails(tmp_path: Path) -> None:
    current = ratchet_text().replace('json_key = "gate.lines"', 'toml_key = "tool.coverage.report.fail_under"')
    current = current.replace('file = "package.json", toml_key', 'file = "pyproject.toml", toml_key')
    errors = errors_for(tmp_path, current, ratchet_text())
    assert len(errors) == 1
    assert errors[0].startswith("vitest.lines: source changed")


@pytest.mark.gateproof
def test_config_drift_from_ratchet_fails(tmp_path: Path) -> None:
    errors = errors_for(tmp_path, ratchet_text(), ratchet_text(), {"coverage.min": 70})
    assert errors == ["coverage.min: config drift, pyproject.toml has 70, ratchet says 90"]


@pytest.mark.gateproof
def test_type_change_counts_as_drift(tmp_path: Path) -> None:
    errors = errors_for(tmp_path, ratchet_text(), None, {"coverage.min": 90.0})
    assert errors == ["coverage.min: config drift, pyproject.toml has 90.0, ratchet says 90"]


def test_tightening_passes(tmp_path: Path) -> None:
    tighter = {"coverage.min": 95, "vitest.lines": 95, "warnings.max": 0}
    assert errors_for(tmp_path, ratchet_text(tighter), ratchet_text(), tighter) == []


def test_unreadable_sources_fail(tmp_path: Path) -> None:
    write_configs(tmp_path)
    (tmp_path / "Makefile").write_text("nothing here\n")
    (tmp_path / "package.json").unlink()
    (tmp_path / "pyproject.toml").write_text("[tool.coverage.report]\nfail_under = [90]\n")
    errors = check_ratchet.check(check_ratchet.parse(ratchet_text()), None, tmp_path)
    assert errors == [
        "coverage.min: key tool.coverage.report.fail_under in pyproject.toml is not a scalar",
        "warnings.max: regex '^MAX_WARNINGS := (\\\\d+)$' found no match in Makefile",
        "strict.frozen: key tool.mypy.strict is missing from pyproject.toml",
        "vitest.lines: source file package.json is missing",
    ]


def test_regex_values_coerce_to_int_float_or_string(tmp_path: Path) -> None:
    (tmp_path / "f").write_text("A := 3\nB := 2.5\nC := -ll -ii\n")
    for pattern, expected in (("^A := (.+)$", 3), ("^B := (.+)$", 2.5), ("^C := (.+)$", "-ll -ii")):
        entry = check_ratchet.Threshold("x", 0, "frozen", "o", {"file": "f", "regex": pattern})
        assert check_ratchet.read_live_value(entry, tmp_path) == expected


def test_numeric_threshold_turned_string_fails() -> None:
    old = check_ratchet.Threshold("x", 90, "min", "o", {"file": "f", "regex": "(.)"})
    new = check_ratchet.Threshold("x", "90", "min", "o", {"file": "f", "regex": "(.)"})
    assert check_ratchet.compare(old, new) == "x: a min threshold must stay numeric"


BAD_ENTRIES = {
    "string id": 'id=""\nvalue=1\ndirection="min"\norigin="o"\nsource={file="f",regex="(1)"}',
    "direction": 'id="x"\nvalue=1\ndirection="up"\norigin="o"\nsource={file="f",regex="(1)"}',
    "number, bool or string": (
        'id="x"\nvalue=1979-05-27\ndirection="frozen"\norigin="o"\nsource={file="f",regex="(1)"}'
    ),
    "invalid regex": 'id="x"\nvalue=1\ndirection="min"\norigin="o"\nsource={file="f",regex="(1"}',
    "one capture group": 'id="x"\nvalue=1\ndirection="min"\norigin="o"\nsource={file="f",regex="1"}',
    "numeric": 'id="x"\nvalue=true\ndirection="min"\norigin="o"\nsource={file="f",regex="(1)"}',
    "origin": 'id="x"\nvalue=1\ndirection="min"\nsource={file="f",regex="(1)"}',
    "source": 'id="x"\nvalue=1\ndirection="min"\norigin="o"\nsource={file="f"}',
}


@pytest.mark.parametrize(("problem", "body"), sorted(BAD_ENTRIES.items()))
def test_schema_errors_are_reported(problem: str, body: str) -> None:
    with pytest.raises(check_ratchet.RatchetError, match=problem):
        check_ratchet.parse(f"[[threshold]]\n{body}\n")


def test_duplicate_ids_are_rejected() -> None:
    entry = '[[threshold]]\nid="x"\nvalue=1\ndirection="min"\norigin="o"\nsource={file="f",regex="(1)"}\n'
    with pytest.raises(check_ratchet.RatchetError, match="duplicate"):
        check_ratchet.parse(entry + entry)


def test_this_repository_passes_against_head() -> None:
    assert check_ratchet.main(["--base", "HEAD", "--root", str(REPO_ROOT)]) == 0


@pytest.mark.gateproof
def test_main_fails_when_the_base_ratchet_was_stricter(tmp_path: Path) -> None:
    write_configs(tmp_path)
    (tmp_path / "tools" / "gates").mkdir(parents=True)
    ratchet_file = tmp_path / check_ratchet.RATCHET_PATH
    ratchet_file.write_text(ratchet_text())
    git_init(tmp_path)
    git_commit_all(tmp_path, "base")
    assert check_ratchet.main(["--base", "main", "--root", str(tmp_path)]) == 0

    lowered = {"coverage.min": 85}
    write_configs(tmp_path, lowered)
    ratchet_file.write_text(ratchet_text(lowered))
    assert check_ratchet.main(["--base", "main", "--root", str(tmp_path)]) == 1


def test_main_fails_closed_on_unknown_base_or_missing_file(tmp_path: Path) -> None:
    git_init(tmp_path)
    assert check_ratchet.main(["--base", "main", "--root", str(tmp_path)]) == 1  # no ratchet file
    write_configs(tmp_path)
    (tmp_path / "tools" / "gates").mkdir(parents=True)
    (tmp_path / check_ratchet.RATCHET_PATH).write_text(ratchet_text())
    assert check_ratchet.main(["--base", "no-such-ref", "--root", str(tmp_path)]) == 1


def test_first_commit_of_the_ratchet_passes_against_an_older_base(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "README").write_text("before the ratchet\n")
    git_commit_all(tmp_path, "before")
    write_configs(tmp_path)
    (tmp_path / "tools" / "gates").mkdir(parents=True)
    (tmp_path / check_ratchet.RATCHET_PATH).write_text(ratchet_text())
    assert check_ratchet.main(["--base", "main", "--root", str(tmp_path)]) == 0


def test_repo_ratchet_covers_the_core_gates() -> None:
    entries = check_ratchet.parse((REPO_ROOT / check_ratchet.RATCHET_PATH).read_text())
    ids = {e.id for e in entries}
    assert {"coverage.python.fail_under", "mypy.strict", "bandit.flags", "pytest.skip_guard"} <= ids


@pytest.mark.gateproof
def test_a_second_assignment_of_a_threshold_fails(tmp_path: Path) -> None:
    write_configs(tmp_path)
    (tmp_path / "Makefile").write_text("MAX_WARNINGS := 0\nMAX_WARNINGS := 5\n")
    errors = check_ratchet.check(check_ratchet.parse(ratchet_text()), None, tmp_path)
    assert errors == ["warnings.max: Makefile sets this threshold 2 times (lines [1, 2]); set it once"]


# ---------------------------------------------------------------- S5 11.3 against this repo's real files
RATCHETED_FILES = (
    "Makefile",
    "pyproject.toml",
    "conftest.py",
    "tools/envs/semgrep/pyproject.toml",
    check_ratchet.RATCHET_PATH,
)


def _real_repo(tmp_path: Path) -> Path:
    git_init(tmp_path)
    for rel in RATCHETED_FILES:
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text((REPO_ROOT / rel).read_text())
    git_commit_all(tmp_path, "base")
    return tmp_path


@pytest.mark.gateproof
def test_lowering_coverage_min_in_the_real_makefile_fails(tmp_path: Path) -> None:
    root = _real_repo(tmp_path)
    assert check_ratchet.main(["--base", "main", "--root", str(root)]) == 0
    makefile = root / "Makefile"
    makefile.write_text(makefile.read_text().replace("override COVERAGE_MIN := 90", "override COVERAGE_MIN := 80"))
    assert check_ratchet.main(["--base", "main", "--root", str(root)]) == 1  # drift from the ratchet file
    ratchet = root / check_ratchet.RATCHET_PATH
    lowered = ratchet.read_text().replace(
        'id = "coverage.python.cli_fail_under"\nvalue = 90', 'id = "coverage.python.cli_fail_under"\nvalue = 80'
    )
    assert lowered != ratchet.read_text()
    ratchet.write_text(lowered)
    assert check_ratchet.main(["--base", "main", "--root", str(root)]) == 1  # loosened versus the base ref


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("rel", "old", "new"),
    [
        ("Makefile", "override BANDIT_FLAGS := -ll -ii", "override BANDIT_FLAGS := -l"),
        ("Makefile", "override DIFF_COVER_MIN := 90", "override DIFF_COVER_MIN := 50"),
        ("Makefile", "override BANDIT_SECRET_TESTS := B105,B106,B107", "override BANDIT_SECRET_TESTS := B105"),
        ("pyproject.toml", 'exclude-newer = "7 days"', 'exclude-newer = "1 days"'),
        ("tools/envs/semgrep/pyproject.toml", 'exclude-newer = "7 days"', 'exclude-newer = "0 days"'),
        ("pyproject.toml", "strict = true", "strict = false"),
        ("conftest.py", 'pytest_plugins = ["tools.pytest_guard"]', "pytest_plugins = []"),
    ],
)
def test_loosening_any_real_threshold_fails(tmp_path: Path, rel: str, old: str, new: str) -> None:
    root = _real_repo(tmp_path)
    target = root / rel
    assert target.read_text().count(old) == 1, (rel, old)
    target.write_text(target.read_text().replace(old, new))
    assert check_ratchet.main(["--base", "main", "--root", str(root)]) == 1
