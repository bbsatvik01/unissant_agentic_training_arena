"""tools/check_roles.py (S5 1.2 item 2): seeded violations fail in every forbidden spot; a clean
arena_api/arena_subject/arena_core.providers.vertex module passes. Adapted from TechnoMile
tools/tests/test_check_adk_scope.py (same AST-walker shape; ATTRIBUTIONS.md); the rule set is new.
"""

import shlex
import shutil
from pathlib import Path

import pytest

from tools import check_roles as lint
from tools import proc
from tools.tests.conftest import REPO_ROOT, git_init

ARENA_API_FILE = "services/api/src/arena_api/subject_client.py"
ARENA_TOURNAMENT_FILE = "services/tournament/src/arena_tournament/roster.py"
ARENA_SUBJECT_FILE = "services/subject/src/arena_subject/answer.py"
ARENA_REFEREE_FILE = "services/referee/src/arena_referee/app.py"
VERTEX_ADAPTER = lint.VERTEX_ADAPTER
OTHER_CORE_FILE = "packages/core/src/arena_core/turns/orchestrator.py"


def rules(path: str, source: str) -> list[str]:
    return [f.rule for f in lint.check_source(path, source)]


def assert_only(found: list[str], needle: str) -> None:
    """The expected rule fired, and nothing else did except the dynamic-machinery rule (rule dyn), which a
    dynamic-import form in product code triggers as well."""
    assert any(needle in r for r in found), found
    assert all(needle in r or "dynamic import machinery" in r for r in found), found


# ---------------------------------------------------------------- rule a: api / tournament
@pytest.mark.gateproof
@pytest.mark.parametrize("path", [ARENA_API_FILE, ARENA_TOURNAMENT_FILE])
@pytest.mark.parametrize(
    "source",
    [
        "from arena_subject import answer\n",
        "import arena_subject.answer\n",
        "from arena_referee.routes import label\n",
        "from arena_core.agents.subject_prompts import build\n",
        "from arena_core.agents import referee_prompts\n",
    ],
)
def test_api_and_tournament_may_not_import_subject_or_referee(path: str, source: str) -> None:
    found = rules(path, source)
    assert found, (path, source)
    assert all("may never import" in r for r in found)


def test_api_may_import_its_own_modules() -> None:
    assert rules(ARENA_API_FILE, "from arena_api import app\nfrom arena_core.config import boot\n") == []


# ---------------------------------------------------------------- rule b: subject / referee
@pytest.mark.gateproof
def test_subject_may_not_import_referee() -> None:
    found = rules(ARENA_SUBJECT_FILE, "from arena_referee.routes import score\n")
    assert found, found
    assert all("arena_subject may never import arena_referee" in r for r in found)
    assert any(r.endswith("arena_referee.routes.score (S5 1.2 item 2)") for r in found)


def test_referee_may_import_whatever_it_likes_about_subject_rule() -> None:
    # Rule b binds arena_subject only; arena_referee has no forbidden-import entry.
    assert rules(ARENA_REFEREE_FILE, "import arena_subject\n") == []


# ---------------------------------------------------------------- arena_core: shared by every role
# arena_core is imported by all four roles, so a role import inside it would hand arena_api the subject's
# or the referee's code transitively and defeat rules a and b.
@pytest.mark.gateproof
@pytest.mark.parametrize("package", ["arena_api", "arena_subject", "arena_referee", "arena_tournament"])
@pytest.mark.parametrize(
    "form", ["import {p}\n", "from {p} import x\n", "import importlib\nm = importlib.import_module('{p}')\n"]
)
def test_core_may_not_import_any_role_package(package: str, form: str) -> None:
    assert_only(rules(OTHER_CORE_FILE, form.format(p=package)), f"arena_core may never import {package}")


def test_core_may_import_itself() -> None:
    assert rules(OTHER_CORE_FILE, "from arena_core.config import boot\nimport arena_core.ids\n") == []


# ---------------------------------------------------------------- rule c: google.genai
@pytest.mark.gateproof
@pytest.mark.parametrize(
    "source",
    [
        "import google.genai\n",
        "from google.genai import Client\n",
        "from google import genai\n",
        "import importlib\nm = importlib.import_module('google.genai')\n",
    ],
)
def test_genai_outside_the_vertex_adapter_fails(source: str) -> None:
    assert_only(rules(OTHER_CORE_FILE, source), "google.genai imported outside")


def test_genai_inside_the_vertex_adapter_passes() -> None:
    assert rules(VERTEX_ADAPTER, "from google.genai import Client\n") == []


# ---------------------------------------------------------------- rule d: google.adk (everywhere, no adapter)
@pytest.mark.gateproof
@pytest.mark.parametrize("path", [VERTEX_ADAPTER, OTHER_CORE_FILE, ARENA_API_FILE])
@pytest.mark.parametrize(
    "source",
    [
        "import google.adk\n",
        "from google.adk.agents import LlmAgent\n",
        "from google import adk\n",
        "m = __import__('google.adk')\n",
    ],
)
def test_adk_is_refused_everywhere_including_the_vertex_adapter(path: str, source: str) -> None:
    assert_only(rules(path, source), "google.adk imported")


def test_a_clean_file_passes() -> None:
    clean = "from dataclasses import dataclass\n\n\n@dataclass\nclass X:\n    y: int\n"
    assert rules(ARENA_API_FILE, clean) == []


def test_tracked_python_lists_the_real_tree() -> None:
    paths = lint.tracked_python(REPO_ROOT)
    assert ARENA_API_FILE in paths
    assert "tools/check_roles.py" in paths


def test_this_repository_is_clean() -> None:
    assert lint.main(["--root", str(REPO_ROOT)]) == 0


# ---------------------------------------------------------------- S5 1.4: `make check` fails on the seeded file
@pytest.mark.gateproof
def test_make_roles_fails_on_a_seeded_subject_import_in_services_api(tmp_path: Path) -> None:
    """Drives the real Makefile `roles` target (what `make check` and CI run) in a scratch repository."""
    git_init(tmp_path)
    (tmp_path / "tools").mkdir()
    for name in ("__init__.py", "check_roles.py", "proc.py"):
        shutil.copy(REPO_ROOT / "tools" / name, tmp_path / "tools" / name)
    api = tmp_path / "services" / "api" / "src" / "arena_api"
    api.mkdir(parents=True)
    (api / "clean.py").write_text("VALUE = 1\n")
    uv_run = f"UV_RUN=uv run --project {shlex.quote(str(REPO_ROOT))} --locked"
    makefile = str(REPO_ROOT / "Makefile")
    clean = proc.run("make", ["-f", makefile, "roles", uv_run], cwd=tmp_path)
    assert clean.returncode == 0, clean.stdout + clean.stderr
    (api / "leak.py").write_text("from arena_subject.answer import answer\n")
    seeded = proc.run("make", ["-f", makefile, "roles", uv_run], cwd=tmp_path)
    assert seeded.returncode != 0, seeded.stdout + seeded.stderr
    assert "services/api/src/arena_api/leak.py:1: arena_api may never import arena_subject" in seeded.stderr


# ---------------------------------------------------------------- dynamic imports (Codex round 1, finding 1)
# Rule: every module product code (arena_core or a role) loads is named by an import statement the lint can
# see. Dynamic loading machinery is refused in product packages outright, so an alias or a keyword argument
# cannot route around rules a, b and core; outside them, aliased and keyword dynamic imports still resolve.
PRODUCT_FILES = [ARENA_API_FILE, ARENA_TOURNAMENT_FILE, ARENA_SUBJECT_FILE, ARENA_REFEREE_FILE, OTHER_CORE_FILE]
MACHINERY = [
    "import importlib\n",
    "import importlib.util\n",
    "import importlib.metadata\n",
    "import importlib as il\n",
    "from importlib import import_module\n",
    "from importlib import import_module as load\n",
    "from importlib import util\n",
    "from importlib.util import spec_from_file_location\n",
    "from importlib.resources import files\n",
    "import runpy\n",
    "import pkgutil\n",
    "import builtins\n",
    "from builtins import __import__ as imp\n",
    "loader = __import__\n",
    "m = __import__('json')\n",
    "m = getattr(__builtins__, 'open')\n",
]


@pytest.mark.gateproof
@pytest.mark.parametrize("path", PRODUCT_FILES)
@pytest.mark.parametrize("source", MACHINERY)
def test_dynamic_import_machinery_is_refused_in_product_packages(path: str, source: str) -> None:
    found = rules(path, source)
    assert any("dynamic import machinery" in r for r in found), (path, source, found)


@pytest.mark.gateproof
def test_the_aliased_referee_import_from_the_review_is_caught() -> None:
    found = rules(ARENA_API_FILE, "from importlib import import_module as load\nload('arena_referee')\n")
    assert any("arena_api may never import arena_referee" in r for r in found), found
    assert any("dynamic import machinery" in r for r in found), found


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "source",
    [
        "from importlib import import_module as load\nload('google.genai')\n",
        "import importlib as il\nil.import_module('google.genai')\n",
        "import importlib\nimportlib.import_module(name='google.genai')\n",
        "from importlib import import_module\nimport_module(package='google', name='.genai')\n",
        "m = __import__(name='google.genai')\n",
        "import builtins\nbuiltins.__import__('google.genai')\n",
    ],
)
def test_aliased_and_keyword_dynamic_imports_resolve_outside_product_packages(source: str) -> None:
    found = rules("tools/some_tool.py", source)
    assert any(r.startswith("google.genai imported outside") for r in found), (source, found)


def test_importlib_metadata_from_imports_are_allowed_in_product_packages() -> None:
    source = "from importlib.metadata import version\nfrom importlib import metadata\n"
    assert rules(OTHER_CORE_FILE, source) == []


def test_tools_may_use_dynamic_imports_of_allowed_modules() -> None:
    assert rules("tools/some_tool.py", "import importlib\nm = importlib.import_module('json')\n") == []
