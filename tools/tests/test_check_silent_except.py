"""Silent-except gate proof (S5 11.1): a silent except fails; handled, logged, re-raised or labelled handlers pass.

Lifted from TechnoMile tools/tests/test_check_silent_except.py (ATTRIBUTIONS.md).
"""

from pathlib import Path

import pytest

from tools import check_silent_except as se
from tools.tests.conftest import git_init

SILENT = [
    "try:\n    f()\nexcept ValueError:\n    return None\n",
    "try:\n    f()\nexcept Exception:\n    pass\n",
    "try:\n    f()\nexcept KeyError as exc:\n    result = {}\n",
    "try:\n    f()\nexcept OSError:\n    continue\n",
    "try:\n    f()\nexcept OSError:\n    out.write('x')\n",
    "try:\n    f()\nexcept ValueError as exc:\n    str(exc)\n    return None\n",
    "try:\n    f()\nexcept ValueError as exc:\n    exc\n    return None\n",
    "try:\n    f()\nexcept ValueError as exc:\n    _ = exc\n    return None\n",
    "try:\n    f()\nexcept ValueError as exc:\n    if True:\n        len(str(exc))\n",
    "try:\n    f()\nexcept ValueError as exc:\n    if str(exc):\n        return 0\n    return 1\n",
    "try:\n    f()\nexcept OSError as exc:\n    if exc.errno == 2:\n        return None\n    cleanup()\n",
    "try:\n    f()\nexcept ValueError as exc:\n    message = str(exc)\n    if message:\n        return 0\n",
    "try:\n    f()\nexcept ValueError as exc:\n    last_error = exc\n",
    # Codex round 9: every path out of the handler must raise, report or hand the exception on; a branch
    # that does is not enough when another path leaves silently.
    "try:\n    f()\nexcept ValueError:\n    if strict:\n        raise\n    return None\n",
    "try:\n    f()\nexcept ValueError:\n    if debug:\n        logger.debug('bad input')\n    return None\n",
    "try:\n    f()\nexcept ValueError as exc:\n    if verbose:\n        errors.append(exc)\n",
    "try:\n    f()\nexcept ValueError:\n    if strict:\n        raise\n    else:\n        return None\n",
    "try:\n    f()\nexcept OSError as exc:\n    if exc.errno == 2:\n        return None\n    raise\n",
    "try:\n    f()\nexcept ValueError:\n    with lock:\n        if strict:\n            raise\n",
    "try:\n    f()\nexcept ValueError:\n    for item in items:\n        raise\n",
]
HANDLED = [
    "try:\n    f()\n# silent-ok: ENOENT means the file is gone, which is the answer\nexcept OSError as exc:\n"
    "    if exc.errno == 2:\n        return None\n    raise\n",
    "try:\n    f()\nexcept ValueError:\n    if strict:\n        raise\n    logger.warning('bad')\n    return None\n",
    "try:\n    f()\nexcept ValueError:\n    if strict:\n        raise\n    else:\n        logger.warning('bad')\n",
    "try:\n    f()\nexcept ValueError:\n    for item in items:\n        continue\n    raise\n",
    "try:\n    f()\nexcept ValueError:\n    with lock:\n        raise\n",
    "try:\n    f()\nexcept ValueError as exc:\n    def later() -> None:\n        return None\n"
    "    raise RuntimeError('x') from exc\n",
    "try:\n    f()\nexcept ValueError as exc:\n    self.last_error: object = exc\n",
    "try:\n    f()\nexcept ValueError as exc:\n    yield exc\n",
    "try:\n    f()\nexcept ValueError:\n    raise\n",
    "try:\n    f()\nexcept ValueError as exc:\n    raise RuntimeError('x') from exc\n",
    "try:\n    f()\nexcept ValueError:\n    logger.warning('bad input')\n",
    "try:\n    f()\nexcept ValueError:\n    warn('bad input')\n",
    "try:\n    f()\nexcept ValueError:\n    sys.stderr.write('bad')\n",
    "try:\n    f()\nexcept ValueError as exc:\n    errors.append(str(exc))\n",
    "try:\n    f()\nexcept ValueError as exc:\n    return Failure(exc)\n",
    "try:\n    f()\nexcept ValueError as exc:\n    message = f'bad: {exc}'\n    errors.append(message)\n",
    "try:\n    f()\nexcept ValueError as exc:\n    detail = str(exc)\n    return Failure(detail)\n",
    "try:\n    f()\nexcept ValueError as exc:\n    self.errors[key] = exc\n",
    "try:\n    f()\n# silent-ok: a torn trailing line is expected mid-write\nexcept ValueError:\n    pass\n",
    "try:\n    f()\nexcept ValueError:  # silent-ok: a torn trailing line is expected while writing\n    pass\n",
]


def _wrap(body: str) -> str:
    return "def g():\n    for _ in range(1):\n" + "".join(f"        {line}\n" for line in body.splitlines())


@pytest.mark.gateproof
@pytest.mark.parametrize("body", SILENT)
def test_silent_handlers_are_flagged(body: str) -> None:
    assert len(se.scan_source("m.py", _wrap(body))) == 1


@pytest.mark.parametrize("body", HANDLED)
def test_handled_handlers_pass(body: str) -> None:
    assert se.scan_source("m.py", _wrap(body)) == []


def test_label_without_a_reason_does_not_count() -> None:
    body = "try:\n    f()\nexcept ValueError:  # silent-ok:\n    pass\n"
    assert len(se.scan_source("m.py", _wrap(body))) == 1


@pytest.mark.gateproof
def test_main_scans_repo_roots_and_fails_on_a_new_silent_handler(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "services" / "api").mkdir(parents=True)
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "ignored.py").write_text(_wrap(SILENT[0]))
    assert se.main(["--root", str(tmp_path)]) == 0
    (tmp_path / "services" / "api" / "bad.py").write_text(_wrap(SILENT[0]))
    assert se.main(["--root", str(tmp_path)]) == 1
    (tmp_path / "services" / "api" / "bad.py").write_text("def broken(:\n")
    assert se.main(["--root", str(tmp_path)]) == 1


def test_this_repository_is_clean() -> None:
    assert se.main(["--root", str(Path(__file__).resolve().parents[2])]) == 0
