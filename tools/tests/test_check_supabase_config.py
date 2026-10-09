"""check_supabase_config.py (S4 2.1, Q9; WI-S4-01): no arena schema is ever exposed through the Data API."""

from pathlib import Path

import pytest

from tools import check_supabase_config as sc
from tools.tests.conftest import REPO_ROOT

GOOD = """
project_id = "unissant-arena"
[api]
enabled = false
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
"""


def test_the_committed_config_passes() -> None:
    assert sc.main(["--root", str(REPO_ROOT)]) == 0


def test_a_config_exposing_only_supabase_schemas_passes() -> None:
    assert sc.check(GOOD) == []


@pytest.mark.gateproof
@pytest.mark.parametrize("schema", sorted(sc.ARENA_SCHEMAS))
def test_exposing_any_arena_schema_fails(schema: str) -> None:
    config = GOOD.replace('"graphql_public"]', f'"graphql_public", "{schema}"]')
    assert sc.check(config) == [f"[api].schemas exposes {schema!r} through the Data API (S4 2.1)"]


@pytest.mark.gateproof
def test_case_and_spacing_do_not_hide_an_arena_schema() -> None:
    config = GOOD.replace('"graphql_public"]', '"graphql_public", " Sealed "]')
    assert sc.check(config) == ["[api].schemas exposes ' Sealed ' through the Data API (S4 2.1)"]


@pytest.mark.gateproof
def test_an_arena_schema_on_the_api_search_path_fails() -> None:
    config = GOOD.replace('extra_search_path = ["public", "extensions"]', 'extra_search_path = ["public", "ops"]')
    assert sc.check(config) == ["[api].extra_search_path puts 'ops' on the Data API search path (S4 2.1)"]


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("config", "error"),
    [
        ('project_id = "x"\n', "[api] is missing: the exposed-schema list must be explicit"),
        ("[api]\nenabled = false\n", "[api].schemas must be an explicit list of schema names"),
        ('[api]\nschemas = "public"\n', "[api].schemas must be an explicit list of schema names"),
        ('[api]\nschemas = ["public", 7]\n', "[api].schemas must be an explicit list of schema names"),
        (
            '[api]\nschemas = ["public"]\nextra_search_path = "ops"\n',
            "[api].extra_search_path must be a list of schema names",
        ),
    ],
)
def test_an_implicit_or_malformed_api_section_fails(config: str, error: str) -> None:
    assert sc.check(config) == [error]


@pytest.mark.gateproof
def test_unparseable_toml_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "supabase").mkdir()
    (tmp_path / sc.CONFIG_PATH).write_text("[api\nschemas = [\n")
    assert sc.main(["--root", str(tmp_path)]) == 1
    assert "supabase-config: FAIL" in capsys.readouterr().err


@pytest.mark.gateproof
def test_a_missing_config_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert sc.main(["--root", str(tmp_path)]) == 1
    assert "supabase-config: FAIL" in capsys.readouterr().err


@pytest.mark.gateproof
def test_main_reports_an_exposed_schema(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "supabase").mkdir()
    (tmp_path / sc.CONFIG_PATH).write_text(GOOD.replace('"graphql_public"]', '"graphql_public", "arena"]'))
    assert sc.main(["--root", str(tmp_path)]) == 1
    assert "supabase-config: FAIL: [api].schemas exposes 'arena'" in capsys.readouterr().err
