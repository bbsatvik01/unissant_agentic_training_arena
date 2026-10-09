"""tools/pgtap_ban.py: the static half of "no skip, no todo" in the pgTAP suite (S4 sql/TESTS.md section 0; global
never-rig rule). pgTAP's skip and todo functions may not appear in any test or harness file in any spelling: bare,
schema-qualified, quoted, mixed case, or with whitespace or comments before the parenthesis. The words are reserved
in the suite; the one exception is the string literal 'skip' (ops.admit_unit's decision value)."""

from pathlib import Path

import pytest

from tools import pgtap_ban

UNREADABLE = 2  # pgtap_ban.main's exit status when it cannot scan (no files, or a file it cannot read)

CALLS = [
    "select skip('later', 1);",
    "select todo('later', 1);",
    "SELECT * FROM todo_start('x');",
    "perform Skip ('x');",
    "select todo_end();",
    "select extensions.skip('x', 1);",
    "select public.todo('x', 1);",
    "select \"skip\"('x', 1);",
    "select extensions.\"todo\"('x', 1);",
    'select "extensions"."SKIP"(\'x\', 1);',
    "select extensions . skip ('x', 1);",
    "select skip/* a comment */('x', 1);",
    "select skip/* nested /* comment */ */('x', 1);",
    "select skip -- a comment\n('x', 1);",
    "select skip\n('x', 1);",
    "select tests.as_role('arena_public', 'select skip(1)');",
    "create function tests.x() returns text language sql as $$ select todo('x', 1) $$;",
    "select 'x', skip(1);",
    "select '--', skip/**/(1);",
    "select U&\"\\0073kip\"('x', 1);",
    "execute E'select sk\\x69p(1)';",
]


@pytest.mark.gateproof
@pytest.mark.parametrize("sql", CALLS)
def test_every_spelling_of_a_skip_or_todo_call_is_found(sql: str) -> None:
    assert pgtap_ban.scan(f"begin;\nselect plan(1);\n{sql}\nrollback;\n") != []


@pytest.mark.parametrize(
    "sql",
    [
        "select case when x then 'skip' else 'admit' end;",
        "select (ops.admit_unit('global', 0.01) ->> 'decision') = 'skip';",
        "select tests.skip_count, skipped, todos, my_todo, todo_x, skip$1;",
        "select 'it''s fine';",
        "select e'plain \\n text';",
        "select ok(true, 'H-01 runs');",
    ],
)
def test_words_that_only_look_like_markers_pass(sql: str) -> None:
    assert pgtap_ban.scan(sql) == []


def test_hits_name_the_line() -> None:
    hits = pgtap_ban.scan("begin;\nselect 1;\nselect extensions.skip('x', 1);\n")
    assert hits == ["line 3: skip"]


@pytest.mark.gateproof
def test_main_fails_and_names_each_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    good = tmp_path / "001_good.sql"
    good.write_text("select ok(true, 'fine');\n")
    bad = tmp_path / "002_bad.sql"
    bad.write_text("select \"todo\"('x', 1);\n")
    assert pgtap_ban.main([str(good), str(bad)]) == 1
    err = capsys.readouterr().err
    assert "pgTAP skip/todo calls are forbidden in the suite" in err
    assert f"{bad}: line 1: todo" in err
    assert str(good) not in err


def test_main_passes_a_clean_suite(tmp_path: Path) -> None:
    good = tmp_path / "001_good.sql"
    good.write_text("select ok(true, 'fine');\n")
    assert pgtap_ban.main([str(good)]) == 0


@pytest.mark.gateproof
def test_main_fails_on_no_files_or_an_unreadable_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert pgtap_ban.main([]) == UNREADABLE
    assert pgtap_ban.main([str(tmp_path / "missing.sql")]) == UNREADABLE
    assert "could not scan" in capsys.readouterr().err
