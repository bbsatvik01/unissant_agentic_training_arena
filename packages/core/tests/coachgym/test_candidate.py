"""A challenger as a new coach manifest version through the existing manifest machinery."""

from __future__ import annotations

from pathlib import Path

import pytest

from arena_core.agents.manifests import (
    ManifestMismatchError,
    check_roster,
    committed_manifest,
    load_prompts,
)
from arena_core.coachgym.candidate import (
    GYM_PROMPT_DIR,
    PLAYBOOK,
    STRATEGY,
    CandidateError,
    build,
    components,
    layout,
    manifest_path,
    next_version,
    read_manifest,
    write,
)
from packages.core.tests.coachgym.support import REPO, gym_root

PLAY = "Coaching playbook.\n- Quote the answer before calling it evasive.\n"


def test_build_edits_only_the_strategy_and_adds_the_playbook() -> None:
    champion = load_prompts(committed_manifest("A1"), REPO)
    current = components(champion)
    assert current[PLAYBOOK] == ""
    challenger = build(champion, {STRATEGY: current[STRATEGY] + "\nNew line.", PLAYBOOK: PLAY}, "1.2.0", "note")
    m = challenger.manifest
    base = champion.manifest
    assert m.version == "1.2.0"
    assert m.lineage.parent_sha256 == base.sha256
    assert m.prompt is not None
    assert base.prompt is not None
    card = m.prompt.assembly["card"]
    assert card[0] == base.prompt.assembly["card"][0]  # the shared contract is untouched
    assert card[1].startswith(f"{GYM_PROMPT_DIR}/a1.strategy.")
    assert card[2].startswith(f"{GYM_PROMPT_DIR}/a1.playbook.")
    assert m.prompt.assembly["final"] == [*card, base.prompt.assembly["final"][-1]]
    assert m.prompt.assembly["deep"] == base.prompt.assembly["deep"]
    assert (m.limits, m.coaching_policy, m.prompt.output_schemas, m.prompt.user_templates) == (
        base.limits,
        base.coaching_policy,
        base.prompt.output_schemas,
        base.prompt.user_templates,
    )
    assert sorted(challenger.new_files) == sorted(card[1:])
    assert components(challenger.prompts) == {STRATEGY: current[STRATEGY] + "\nNew line.", PLAYBOOK: PLAY}
    assert challenger.version_id == "A1@1.2.0"


def test_written_challenger_verifies_and_freezes_with_the_official_roster(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    champion = load_prompts(committed_manifest("A1", root), root)
    challenger = build(champion, {STRATEGY: "Coach by evidence first.", PLAYBOOK: PLAY}, "1.2.0", "gym")
    paths = write(challenger, root)
    assert manifest_path(challenger.manifest) in paths
    frozen = read_manifest(manifest_path(challenger.manifest), root)
    assert frozen == challenger.manifest
    verified = load_prompts(frozen, root)  # S2 3.3: every file and the manifest hash as recorded
    assert verified.texts == challenger.prompts.texts
    others = [committed_manifest(c, root) for c in ("A2", "A3", "S1", "S2", "S3")]
    check_roster([frozen, *others])
    write(challenger, root)  # the same content again is fine
    (root / paths[0]).write_text("tampered", encoding="utf-8")
    with pytest.raises(ManifestMismatchError):
        load_prompts(frozen, root)
    with pytest.raises(CandidateError, match="different content"):
        write(challenger, root)


def test_an_unchanged_strategy_keeps_the_champion_file() -> None:
    champion = load_prompts(committed_manifest("A2"), REPO)
    same = build(champion, components(champion), "1.2.0", "no change")
    assert same.new_files == {}
    assert same.prompts.texts == champion.texts
    with pytest.raises(CandidateError, match="non-empty"):
        build(champion, {STRATEGY: "  "}, "1.2.0", "empty")


def test_only_coach_manifests_with_the_known_layout_are_edited() -> None:
    with pytest.raises(CandidateError, match="assistant"):
        layout(committed_manifest("S1"))


def test_next_version_skips_taken_numbers() -> None:
    assert next_version("1.1.0", []) == "1.2.0"
    assert next_version("1.1.0", ["1.2.0", "1.3.0"]) == "1.4.0"
    assert next_version("2.0.5", ["2.1.0"]) == "2.2.0"
