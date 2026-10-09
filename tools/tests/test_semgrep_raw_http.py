"""Gate proof for the raw-HTTP rule (S5 1.1/1.2): HTTP clients only in the agent port, the api's role
clients and the Phoenix read-back. Adapted from TechnoMile tools/tests/test_semgrep_raw_http.py
(ATTRIBUTIONS.md): same harness, this repo's allowed and forbidden paths."""

import json
import shutil
from pathlib import Path

import pytest

from tools import proc
from tools.tests.conftest import REPO_ROOT

RULES = REPO_ROOT / "tools" / "semgrep" / "rules.yml"
SEMGREP_ENV = REPO_ROOT / "tools" / "envs" / "semgrep"
RULE_ID = "arena-no-raw-http"

VIOLATIONS = {
    "httpx_get.py": "import httpx\n\n\ndef grab(url: str) -> bytes:\n    return httpx.get(url).content\n",
    "httpx_from.py": "from httpx import Client\n\nCLIENT = Client()\n",
    "httpx2_import.py": "import httpx2\n",
    "requests_import.py": "import requests\n\nrequests.get('https://example.com', timeout=5)\n",
    "urllib_open.py": "import urllib.request\n\nurllib.request.urlopen('https://example.com')\n",
    "urllib_from.py": "from urllib.request import urlopen\n",
    "urllib3_import.py": "import urllib3\n",
    "http_client.py": "import http.client\n\nhttp.client.HTTPSConnection('example.com')\n",
    "aiohttp_import.py": "import aiohttp\n",
}

ALLOWED_DIRS = ["packages/core/src/arena_core/providers"]
ALLOWED_FILES = [
    "packages/core/src/arena_core/observability/phoenix.py",
    "services/api/src/arena_api/subject_client.py",
    "services/api/src/arena_api/referee_client.py",
]
FORBIDDEN_DIRS = [
    "services/api/src/arena_api",
    "services/api/src/arena_api/routes",
    "services/api/tests",
    "services/subject/src/arena_subject",
    "services/referee/src/arena_referee",
    "services/tournament/src/arena_tournament",
    "packages/core/src/arena_core",
    "packages/core/src/arena_core/observability",
    "packages/core/tests",
    "tools",
    "tools/tests",
    "scripts",
]


def semgrep_json(target: Path, *, respect_git_ignore: bool) -> dict[str, object]:
    """Run the locked Semgrep with our rules; a zero exit status means the scan ran (findings are in the JSON)."""
    args = ["run", "--project", str(SEMGREP_ENV), "--locked", "semgrep", "scan", "--metrics=off"]
    args += ["--disable-version-check", "--config", str(RULES), "--json", "--quiet", "--max-target-bytes=0"]
    args += [] if respect_git_ignore else ["--no-git-ignore"]
    result = proc.run("uv", [*args, "."], cwd=target)
    assert result.returncode == 0, result.stderr
    parsed: dict[str, object] = json.loads(result.stdout)
    return parsed


@pytest.mark.gateproof
def test_raw_http_rule_flags_forbidden_paths_and_allows_the_port_and_role_clients(tmp_path: Path) -> None:
    shutil.copy(REPO_ROOT / ".semgrepignore", tmp_path / ".semgrepignore")
    for directory in FORBIDDEN_DIRS + ALLOWED_DIRS:
        for name, body in VIOLATIONS.items():
            path = tmp_path / directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)
    for allowed in ALLOWED_FILES:
        (tmp_path / allowed).write_text(VIOLATIONS["httpx_get.py"])

    results = semgrep_json(tmp_path, respect_git_ignore=False)["results"]
    assert isinstance(results, list)
    flagged = {(str(r["path"]), r["check_id"].rsplit(".", 1)[-1]) for r in results}

    for directory in FORBIDDEN_DIRS:
        for name in VIOLATIONS:
            assert (f"{directory}/{name}", RULE_ID) in flagged, f"missed {directory}/{name}"
    for directory in ALLOWED_DIRS:
        assert not [p for p, _ in flagged if p.startswith(directory + "/")], f"false positive in {directory}"
    for allowed in ALLOWED_FILES:
        assert (allowed, RULE_ID) not in flagged, f"false positive on {allowed}"


@pytest.mark.gateproof
def test_repo_itself_is_clean_under_the_rule() -> None:
    results = semgrep_json(REPO_ROOT, respect_git_ignore=True)["results"]
    assert results == []
