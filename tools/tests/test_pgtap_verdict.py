"""pgtap_verdict.py: the db-test gate passes a pgTAP file only on an exactly well-formed, all-ok TAP stream with no
skip or TODO (S4 sql/TESTS.md section 0; the global never-rig rule). Every failure rule has a gateproof."""

import io

import pytest

from tools import pgtap_verdict as pv

OK = "1..2\nok 1 - first\nok 2 - second\n"


def test_a_well_formed_stream_passes_among_psql_output() -> None:
    output = 'BEGIN\nCREATE FUNCTION\n1..2\n{"turn_no": 1}\nok 1 - first\n# a diagnostic\nok 2 - second\nROLLBACK\n'
    verdict = pv.judge(output, 0)
    assert (verdict.passed, verdict.planned, verdict.ran, verdict.problems) == (True, 2, 2, ())


def test_a_trailing_plan_passes() -> None:
    assert pv.judge("ok 1 - first\nok 2 - second\n1..2\n", 0).passed


def test_lines_that_only_resemble_tap_are_ignored() -> None:
    assert pv.judge(OK + "okay\nok1\nnotok 3\n", 0).passed


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("output", "psql_exit", "problem"),
    [
        (OK, 3, "psql exited 3"),
        ("1..2\nok 1 - first\nnot ok 2 - second\n", 0, "failed: not ok 2 - second"),
        ("1..2\nok 1 - first\nok 2 - second # SKIP later\n", 0, "skip/todo directive: ok 2 - second # SKIP later"),
        ("1..2\nok 1 - first\nok 2 # skip\n", 0, "skip/todo directive: ok 2 # skip"),
        ("1..2\nok 1 - first\nok 2 - x # Skipped: no db\n", 0, "skip/todo directive: ok 2 - x # Skipped: no db"),
        ("1..2\nok 1 - first\nnot ok 2 - second # TODO later\n", 0, "skip/todo directive: not ok 2 - second # TODO"),
        ("1..2\nok 1 - first\nok 1 - first again\n", 0, "test numbers [1, 1] do not run 1..2"),
        ("1..2\nok 2 - second\nok 1 - first\n", 0, "test numbers [2, 1] do not run 1..2"),
        ("1..2\nok 1 - first\nok 3 - third\n", 0, "test numbers [1, 3] do not run 1..2"),
        ("1..2\nok 1 - first\n", 0, "test numbers [1] do not run 1..2"),
        ("1..1\nok 1 - first\nok 2 - extra\n", 0, "test numbers [1, 2] do not run 1..1"),
        ("1..2\nok 1 - first\nok - second\n", 0, "unnumbered test line: ok - second"),
        ("1..2\nok 1 - first\nok\n", 0, "unnumbered test line: ok"),
        ("1..2\nok 1 - first\nok 02 - second\n", 0, "unnumbered test line: ok 02 - second"),
        (OK + "Bail out! the database went away\n", 0, "bail out: Bail out! the database went away"),
        (OK + "# Looks like you failed 1 test of 2\n", 0, "Looks like you failed 1 test of 2"),
        (OK + "psql:/repo with space/001_a.sql:9: ERROR:  boom\n", 0, "error: psql:/repo with space/001_a.sql:9"),
        (OK + "FATAL:  terminating connection\n", 0, "error: FATAL:  terminating connection"),
        ("ok 1 - first\nok 2 - second\n", 0, "0 plan lines (need exactly one)"),
        (OK + "1..2\n", 0, "2 plan lines (need exactly one)"),
        ("1..0\n", 0, "plan 1..0 runs no test"),
        ("1..0 # Skipped: nothing to do\n", 0, "plan with a directive: 1..0 # Skipped: nothing to do"),
        ("", 0, "0 plan lines (need exactly one)"),
    ],
)
def test_a_malformed_failing_or_skipped_stream_fails(output: str, psql_exit: int, problem: str) -> None:
    verdict = pv.judge(output, psql_exit)
    assert not verdict.passed
    assert any(problem in p for p in verdict.problems), verdict.problems


def test_main_reports_a_pass(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(OK))
    assert pv.main(["--name", "001_a.sql", "--psql-exit", "0"]) == 0
    assert capsys.readouterr().out == "PASS 001_a.sql (2/2)\n"


@pytest.mark.gateproof
def test_main_reports_a_failure_with_its_lines(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("1..2\nok 1 - first\nnot ok 2 - second\n# Failed test 2\nBEGIN\n"))
    assert pv.main(["--name", "001_a.sql", "--psql-exit", "0"]) == 1
    out = capsys.readouterr().out
    assert out.startswith("FAIL 001_a.sql: failed: not ok 2 - second\n")
    assert "  # Failed test 2\n" in out
    assert "BEGIN" not in out


@pytest.mark.gateproof
def test_main_shows_at_most_a_bounded_number_of_lines(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    lines = "".join(f"not ok {n} - x\n" for n in range(1, 200))
    monkeypatch.setattr("sys.stdin", io.StringIO(f"1..199\n{lines}"))
    assert pv.main(["--name", "big.sql", "--psql-exit", "0"]) == 1
    assert len(capsys.readouterr().out.splitlines()) == 1 + pv.MAX_SHOWN


def test_a_long_number_list_is_abbreviated() -> None:
    numbers = "".join(f"ok {n} - x\n" for n in range(1, 100))
    verdict = pv.judge(f"1..98\n{numbers}", 0)
    assert any(p.endswith(", ...] do not run 1..98 once each, in order") for p in verdict.problems)
