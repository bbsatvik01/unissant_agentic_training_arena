"""AT-MAN-1..6 (S2 3.5) and the committed official manifests."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from arena_core.agents import manifests as m
from arena_core.agents.templates import REPO_ROOT
from tools import proc

USAGE = 2  # the CLI exit status for a usage error
ROSTER = ("A1", "A2", "A3", "S1", "S2", "S3")


@pytest.fixture(scope="module")
def official() -> dict[str, m.CandidateManifest]:
    return m.official_manifests()


def _raw(manifest: m.CandidateManifest) -> dict[str, Any]:
    return manifest.model_dump(mode="json")


def _reordered(obj: object) -> object:
    """Every object's keys in reverse order (list order is data and stays)."""
    if isinstance(obj, dict):
        return {k: _reordered(obj[k]) for k in reversed(list(obj))}
    if isinstance(obj, list):
        return [_reordered(v) for v in obj]
    return obj


def test_at_man_1_same_hash_in_two_processes_with_keys_reordered(official: dict[str, m.CandidateManifest]) -> None:
    raw = _raw(official["A1"])
    shuffled = _reordered(raw)
    assert json.dumps(shuffled) != json.dumps(raw)
    code = (
        "import json, sys\n"
        "from arena_core.agents.manifests import manifest_sha256\n"
        "print(manifest_sha256(json.load(sys.stdin)))\n"
    )
    # A second process hashes the reordered manifest.
    out = proc.run("python", ["-c", code], stdin=json.dumps(shuffled), check=True).stdout.strip()
    assert out == m.manifest_sha256(raw) == official["A1"].sha256


def test_hash_ignores_sha256_and_frozen_at_and_covers_everything_else(
    official: dict[str, m.CandidateManifest],
) -> None:
    raw = _raw(official["A2"])
    base = m.manifest_sha256(raw)
    assert m.manifest_sha256({**raw, "sha256": "0" * 64, "frozen_at": "2026-10-22T00:00:00Z"}) == base
    assert m.manifest_sha256({**raw, "display_name": "Other"}) != base
    raw["prompt"]["files"][0]["sha256"] = "f" * 64
    assert m.manifest_sha256(raw) != base


@pytest.fixture
def prompt_copy(tmp_path: Path) -> Path:
    shutil.copytree(REPO_ROOT / "prompts", tmp_path / "prompts")
    return tmp_path


@pytest.mark.parametrize("candidate", ROSTER)
def test_official_manifests_verify_against_the_prompt_files(
    official: dict[str, m.CandidateManifest], candidate: str
) -> None:
    prompts = m.load_prompts(official[candidate])
    assert set(prompts.texts) == set(_all_files(official[candidate]))


def _all_files(manifest: m.CandidateManifest) -> list[str]:
    assert manifest.prompt is not None
    return [f.path for f in [*manifest.prompt.files, *manifest.prompt.user_templates]]


@pytest.mark.parametrize("candidate", ROSTER)
def test_at_man_2_one_changed_byte_in_any_prompt_file_is_refused(
    official: dict[str, m.CandidateManifest], prompt_copy: Path, candidate: str
) -> None:
    manifest = official[candidate]
    m.load_prompts(manifest, prompt_copy)
    for rel in _all_files(manifest):
        path = prompt_copy / rel
        original = path.read_bytes()
        path.write_bytes(original[:-2] + bytes([original[-2] ^ 1]) + original[-1:])
        with pytest.raises(m.ManifestMismatchError, match="manifest_mismatch") as exc:
            m.load_prompts(manifest, prompt_copy)
        assert rel in str(exc.value)
        assert exc.value.reason == "manifest_mismatch"
        path.write_bytes(original)


def test_a_missing_file_or_a_tampered_manifest_is_refused(
    official: dict[str, m.CandidateManifest], prompt_copy: Path
) -> None:
    (prompt_copy / m.FINAL).unlink()
    with pytest.raises(m.ManifestMismatchError, match="unreadable"):
        m.load_prompts(official["A3"], prompt_copy)
    tampered = official["A2"].model_copy(update={"display_name": "Swapped"})
    with pytest.raises(m.ManifestMismatchError, match="manifest sha256"):
        m.load_prompts(tampered)


def test_a_changed_output_schema_is_refused(official: dict[str, m.CandidateManifest]) -> None:
    raw = _raw(official["S1"])
    raw["prompt"]["output_schemas"][0]["sha256"] = "a" * 64
    raw["sha256"] = None
    with pytest.raises(m.ManifestMismatchError, match="output schema SubjectTurn"):
        m.load_prompts(m.CandidateManifest.model_validate(raw))


def test_a_cr_line_ending_is_refused(official: dict[str, m.CandidateManifest], prompt_copy: Path) -> None:
    path = prompt_copy / m.COMMON
    path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n", 1))
    with pytest.raises(m.ManifestMismatchError, match="unreadable"):
        m.load_prompts(official["A1"], prompt_copy)


def test_the_official_roster_freezes(official: dict[str, m.CandidateManifest]) -> None:
    m.check_roster([official[c] for c in ROSTER])


def test_at_man_4_unequal_card_output_limit_refuses_the_freeze(official: dict[str, m.CandidateManifest]) -> None:
    raw = _raw(official["A3"])
    raw["limits"]["card"]["max_output_tokens"] = 1500
    roster = [official["A1"], official["A2"], m.CandidateManifest.model_validate(raw)]
    with pytest.raises(m.RosterRefusedError, match=r"unequal limits\.card"):
        m.check_roster(roster)


@pytest.mark.parametrize(
    ("candidate", "path", "value", "message"),
    [
        ("S2", ("limits", "subject", "attempt_timeout_ms"), 9_000, r"unequal limits\.subject"),
        ("A2", ("limits", "final", "deadline_ms"), 29_000, r"unequal limits\.final"),
        ("A2", ("coaching_policy", "max_flags_per_card"), 2, "unequal max_flags_per_card"),
        ("A2", ("limits", "card", "max_output_tokens"), 2_000, "above the card ceiling"),
        ("A2", ("limits", "card", "attempt_timeout_ms"), 7_000, "attempt timeout above"),
        ("A2", ("limits", "card", "model_id"), "gemini-3.8-flash", "not in the card allowlist"),
        ("A2", ("limits", "card", "thinking_level"), "LOW", "allowlist says MINIMAL"),
        ("A2", ("official",), False, "only official"),
    ],
)
def test_freeze_refuses_unequal_or_over_ceiling_limits(
    official: dict[str, m.CandidateManifest], candidate: str, path: tuple[str, ...], value: object, message: str
) -> None:
    raw = _raw(official[candidate])
    node = raw
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    roster = [official[c] for c in ROSTER if c != candidate] + [m.CandidateManifest.model_validate(raw)]
    with pytest.raises(m.RosterRefusedError, match=message):
        m.check_roster(roster)


def test_models_may_differ_between_assistants(official: dict[str, m.CandidateManifest]) -> None:
    assert official["A1"].limits["card"].model_id != official["A3"].limits["card"].model_id
    m.check_roster([official["A1"], official["A3"]])


def test_at_man_5_a_negative_control_refuses_the_freeze(official: dict[str, m.CandidateManifest]) -> None:
    raw = {**_raw(official["A2"]), "kind": "negative_control", "candidate_id": "NC-DEM", "sha256": None}
    control = m.CandidateManifest.model_validate(raw)
    with pytest.raises(m.RosterRefusedError, match="negative_control cannot be on a tournament roster"):
        m.check_roster([official["A1"], control])


def test_the_referee_cannot_freeze_without_rubric_v1() -> None:
    referee = m.with_hash(m.referee_manifest())
    m.load_prompts(referee)
    with pytest.raises(m.RosterRefusedError, match=r"rubric\.v1\.json"):
        m.check_referee_freeze(referee)
    with pytest.raises(m.RosterRefusedError, match="cannot be on a tournament roster"):
        m.check_roster([referee])


def test_the_referee_freezes_with_rubric_v1(tmp_path: Path) -> None:
    shutil.copytree(REPO_ROOT / "prompts", tmp_path / "prompts")
    (tmp_path / "rubrics").mkdir()
    (tmp_path / "rubrics" / "rubric.v1.json").write_text('{"rubric_version": "rubric.v1"}\n')
    referee = m.with_hash(m.referee_manifest(tmp_path, rubric="rubrics/rubric.v1.json"))
    m.check_referee_freeze(referee)
    assert m.load_prompts(referee, tmp_path).text("rubrics/rubric.v1.json").startswith("{")


@pytest.mark.parametrize(
    "path",
    [("limits", "card", "max_output_tokens"), ("coaching_policy", "deep_update", "every_n_exchanges"), ("version",)],
)
def test_at_man_6_a_float_is_a_validation_error(
    official: dict[str, m.CandidateManifest], path: tuple[str, ...]
) -> None:
    raw = _raw(official["A1"])
    node = raw
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = 3.0
    with pytest.raises(ValidationError, match="a float"):
        m.CandidateManifest.model_validate(raw)


def test_float_paths_names_every_float() -> None:
    assert m.float_paths({"a": [1, 2.5], "b": {"c": 0.0}, "d": "1.0"}) == ["manifest.a[1]", "manifest.b.c"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"tools": []}, "tools: exactly"),
        ({"coaching_policy": None}, "coaching_policy: set exactly"),
        ({"subject_policy": {"policy": "standard"}}, "subject_policy: set exactly"),
        ({"prompt": None}, "required for an in_process"),
        ({"temperature": 0}, "Extra inputs"),
    ],
)
def test_kind_rules(official: dict[str, m.CandidateManifest], change: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        m.CandidateManifest.model_validate({**_raw(official["A2"]), **change})


def test_limits_keys_follow_the_kind_and_the_design(official: dict[str, m.CandidateManifest]) -> None:
    raw = _raw(official["A2"])
    raw["limits"]["deep"] = raw["limits"]["final"]
    with pytest.raises(ValidationError, match=r"limits\.deep: exists exactly"):
        m.CandidateManifest.model_validate(raw)
    raw = _raw(official["S1"])
    raw["limits"]["card"] = raw["limits"]["subject"]
    with pytest.raises(ValidationError, match="are not the call kinds of a subject"):
        m.CandidateManifest.model_validate(raw)


def test_assembly_paths_must_be_named_files(official: dict[str, m.CandidateManifest]) -> None:
    raw = _raw(official["A2"])
    raw["prompt"]["assembly"]["card"].append("prompts/coach/a1.strategy.v1.txt")
    with pytest.raises(ValidationError, match=r"not in prompt\.files"):
        m.CandidateManifest.model_validate(raw)
    raw = _raw(official["A2"])
    raw["prompt"]["files"][0]["path"] = "prompts/../secrets.txt"
    with pytest.raises(ValidationError, match="not a repository-relative prompt path"):
        m.CandidateManifest.model_validate(raw)


def test_two_stage_needs_a_deep_policy(official: dict[str, m.CandidateManifest]) -> None:
    raw = _raw(official["A1"])
    raw["coaching_policy"]["deep_update"] = None
    with pytest.raises(ValidationError, match="deep_update: set exactly for two_stage"):
        m.CandidateManifest.model_validate(raw)


def test_committed_manifests_match_the_prompt_files(official: dict[str, m.CandidateManifest]) -> None:
    assert m.main(["check"]) == 0
    for candidate in ROSTER:
        committed = m.committed_manifest(candidate)
        assert committed == official[candidate]
        assert committed.sha256 == m.manifest_sha256(committed)


def test_check_reports_a_stale_manifest_and_write_fixes_it(prompt_copy: Path) -> None:
    path = prompt_copy / m.COMMON
    path.write_text(path.read_text() + "12. Be brief.\n")
    assert m.main(["check"], prompt_copy) == 1
    assert m.main(["write"], prompt_copy) == 0
    assert m.main(["check"], prompt_copy) == 0
    assert m.main(["nonsense"], prompt_copy) == USAGE


def test_prompt_set_refuses_unknown_paths_and_assemblies(official: dict[str, m.CandidateManifest]) -> None:
    prompts = m.load_prompts(official["A2"])
    with pytest.raises(m.ManifestMismatchError, match="not a file of manifest A2"):
        prompts.text(m.DEEP)
    with pytest.raises(m.ManifestMismatchError, match="no assembly for deep"):
        prompts.assembly("deep")
