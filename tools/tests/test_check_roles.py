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
    found = rules(OTHER_CORE_FILE, form.format(p=package))
    assert found, (package, form)
    assert all(f"arena_core may never import {package}" in r for r in found)


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
    found = rules(OTHER_CORE_FILE, source)
    assert found, source
    assert all(r.startswith("google.genai imported outside") for r in found)


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
    found = rules(path, source)
    assert found, (path, source)
    assert all("google.adk imported" in r for r in found)


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
