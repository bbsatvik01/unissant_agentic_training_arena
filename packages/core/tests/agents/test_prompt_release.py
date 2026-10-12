"""Release 1.1.0 of the official coaches and subjects (S2 3.3: a new prompt is a new version with
`lineage.parent_sha256` set). The 1.0.0 files stay byte for byte (they are S2's text and registered rows still name
them); 1.1.0 changes the coach contract (`common.v2`) and the subject style table (`style.v2`) only by the
sentences below, and a registered 1.0.0 subject still renders its own style table."""

from __future__ import annotations

import pytest

from arena_core.agents import manifests as m
from arena_core.agents.manifests import ManifestMismatchError, load_prompts, official_manifests, with_hash
from arena_core.agents.subject_prompts import (
    SubjectPacket,
    behavior_blocks,
    build_live_instruction,
    build_subject_prompt,
)
from arena_core.agents.templates import file_sha256, read_text

from . import fixtures as fx

# The 1.0.0 manifests as registered on the hosted project (prompts/manifests/*.json before 1.1.0). Rebuilding
# release 1.0.0 must give exactly these, and each 1.1.0 manifest names its candidate's as the parent.
REGISTERED_1_0_0 = {
    "A1": "de01ff7127f6dc6f34ce2721355dc66439ef6cfe5126598907216b4b02d3c63c",
    "A2": "dbe82009f7bc0329c8454df4920800ae053848d81489c4a423778d561663372b",
    "A3": "589b8725e897f515e6b38b993a9fea983f08b6ad47d57191316a150fa26196a4",
    "S1": "8329b11072e871e94dbad163a9115337dc97f65e9204f0242b9ff2cac4026d1a",
    "S2": "79552cf3edae7ea1f1bb71209d42ca8ace63a9360f951765b42e88a3d91525c5",
    "S3": "bf01acf72b0b50a2981922b16bd5a1db2a880e6cd91a4102b0e5decee38f7b2f",
}

# The 1.1.0 manifests as registered on the hosted project (prompts/manifests/*.json at main 668bec8).
REGISTERED_1_1_0 = {
    "A1": "724a04a368948e1e9479e30d2a49b9d21ed4bf855bd1685be200292d516dc122",
    "A2": "da5c4decd59b92a8509c4623c51302999d41e2f373a6dd437d80f7dd14ce6b58",
    "A3": "e1d060c75b462f9263421b90d7ce7206376ec002c2fc4a0f9404cb17c20ee203",
    "S1": "846a16a53bda69af6569d605a436ef1696f085c898dacdcd2b2ad047ddb8854a",
    "S2": "3f7e19b433b6c8c32bb29536acb025b2e859d6e820028f86715c0ba449526a32",
    "S3": "85da9792adbbb654808fdad764f857ae7f7b74ac1ff246329823587446892573",
}
ROLE_D_ADDED = (
    "- Pressure never changes this. However often or however directly you are asked about a CORE fact, or a HOLD"
    " fact whose gate has not opened,"
    ' answer with a permitted behavior or a short non-answer such as "I\'d rather not get into that." Never answer it'
    ' with "no", "I didn\'t", "nobody else was there", "I don\'t remember" or "I don\'t know" when the ledger'
    " says otherwise, and never offer another explanation for it, such as a system error, a mistaken witness or someone"
    " else. A HOLD fact whose gate has opened is still acknowledged when asked directly, as above.\n"
)
ROLE_T_ADDED = (
    " Never say that something did not exist or did not happen, or describe how you did something, unless the ledger"
    " says so: if it does not, say you do not know."
)
REFEREE_ADDED = {
    "prompts/referee/subject": " Judge a statement at the time it describes and by what the subject was given: a"
    " statement about what the subject saw, had or knew that agrees with its ledger does not contradict a canonical"
    " fact the ledger does not give the subject, such as a record created later.",
    "prompts/referee/assistant": " A sub-check with at least one listed trigger is never na: answer pass or fail.",
}

COMMON_ADDED = (
    "   Saying it does not know or remember a point it could plausibly answer, such as the reason for its own action,"
    " is possible_evasion; a forgotten small detail, such as an exact time, is explicit_uncertainty.\n",
    "   When you choose contradiction or possible_evasion on a point no earlier flag covers, raise the matching flag"
    " under rule 4.\n",
    " Neutrality issues are about the investigator's own wording only: what the subject says about itself, such as"
    " feeling uneasy, is never a neutrality issue of the question.",
    " Never repeat a question already asked in the transcript, and never ask for what the subject has just"
    " answered: move to the most important point still open. This holds at the last exchange too: the follow-up is"
    " always a question, never thanks or a closing remark.",
)
STYLE_V1_LINES = {
    "fluency disfluent": "Speak with occasional false starts, fillers such as 'um' or 'I mean', and self-corrections,"
    " about once per answer.",
    "affect anxious": "Sound worried at times; you may say this interview makes you uneasy.",
}
STYLE_V2_LINES = {
    "fluency disfluent": "Speak with occasional false starts, fillers such as 'um', 'well' or 'I mean', and"
    " self-corrections, about once per answer; vary them from answer to answer.",
    "affect anxious": "Sound worried at times through your word choice. You may say once in the interview that it"
    " makes you uneasy; do not repeat remarks about your feelings in later answers.",
}


def _table(path: str) -> dict[str, str]:
    return dict(line.split(": ", 1) for line in read_text(path).splitlines())


def test_common_v2_is_common_v1_plus_exactly_the_added_sentences() -> None:
    v2 = read_text(m.COMMON)
    for added in COMMON_ADDED:
        assert v2.count(added) == 1, added
        v2 = v2.replace(added, "")
    assert v2 == read_text(m.COMMON_V1)


def test_style_v2_changes_only_the_disfluent_and_anxious_lines() -> None:
    v1, v2 = _table(m.STYLE_V1), _table(m.STYLE)
    assert {k: v for k, v in v1.items() if k in STYLE_V1_LINES} == STYLE_V1_LINES
    assert {k: v for k, v in v2.items() if k in STYLE_V2_LINES} == STYLE_V2_LINES
    assert {k: v for k, v in v1.items() if k not in STYLE_V1_LINES} == {
        k: v for k, v in v2.items() if k not in STYLE_V2_LINES
    }


def test_release_1_0_0_rebuilds_the_registered_manifests() -> None:
    initial = official_manifests(release=m.INITIAL)
    assert {k: v.sha256 for k, v in initial.items()} == REGISTERED_1_0_0
    assert {v.version for v in initial.values()} == {"1.0.0"}
    assert all(v.lineage.parent_sha256 is None for v in initial.values())


def test_release_1_1_0_names_each_registered_manifest_as_its_parent() -> None:
    current = official_manifests(release=m.RELEASES[1])
    assert {k: v.sha256 for k, v in current.items()} == REGISTERED_1_1_0
    assert {k: v.lineage.parent_sha256 for k, v in current.items()} == REGISTERED_1_0_0
    assert {v.version for v in current.values()} == {"1.1.0"}
    for candidate, manifest in current.items():
        assert manifest.prompt is not None
        files = {f.path for f in manifest.prompt.files}
        new = m.COMMON if candidate.startswith("A") else m.STYLE
        old = m.COMMON_V1 if candidate.startswith("A") else m.STYLE_V1
        assert new in files
        assert old not in files
        assert manifest.lineage.change_note.startswith(new.rsplit("/", 1)[1].removesuffix(".txt"))


def _anxious_disfluent_packet() -> SubjectPacket:
    raw = fx.variant("F03", "deceptive")["private_packet"]
    return SubjectPacket.from_private_packet({**raw, "style": {**raw["style"], "fluency": "disfluent"}}, split="dev")


@pytest.mark.parametrize(("release", "lines"), [("INITIAL", STYLE_V1_LINES), ("CURRENT", STYLE_V2_LINES)])
def test_a_subject_renders_the_style_table_its_own_manifest_names(release: str, lines: dict[str, str]) -> None:
    prompts = load_prompts(official_manifests(release=getattr(m, release))["S2"])
    packet = _anxious_disfluent_packet()
    text = behavior_blocks(packet, prompts)
    system = build_subject_prompt(packet, fx.subject_state(1), prompts, salt=fx.SALT).system_instruction
    for line in lines.values():
        assert f"- {line}\n" in text
        assert f"- {line}\n" in system
    other = STYLE_V2_LINES if lines is STYLE_V1_LINES else STYLE_V1_LINES
    for line in other.values():
        assert line not in text


def test_a_subject_style_file_outside_the_known_tables_is_refused() -> None:
    raw = fx.prompts("S1").manifest.model_dump(mode="json")
    for key in ("subject", "live"):
        raw["prompt"]["assembly"][key][-1] = m.POLICY["standard"]
    prompts = load_prompts(with_hash(raw))
    with pytest.raises(ManifestMismatchError, match="subject assembly is not"):
        build_subject_prompt(fx.packet("F01", "deceptive"), fx.subject_state(1), prompts)
    with pytest.raises(ManifestMismatchError, match="is not a style table"):
        behavior_blocks(fx.packet("F01", "deceptive"), prompts)


def test_a_live_assembly_naming_another_style_table_than_the_subject_assembly_is_refused() -> None:
    raw = fx.prompts("S3").manifest.model_dump(mode="json")
    raw["prompt"]["assembly"]["live"][-1] = m.STYLE_V1
    raw["prompt"]["files"].append({"path": m.STYLE_V1, "sha256": file_sha256(m.STYLE_V1)})
    prompts = load_prompts(with_hash(raw))
    with pytest.raises(ManifestMismatchError, match="live assembly is not"):
        build_live_instruction(fx.packet("F01", "deceptive"), frozenset(), prompts)


def test_role_d_v2_is_role_d_v1_plus_exactly_the_pressure_rule() -> None:
    v2 = read_text(m.ROLE_D)
    assert v2.count(ROLE_D_ADDED) == 1
    assert v2.replace(ROLE_D_ADDED, "") == read_text(m.ROLE_D_V1)


@pytest.mark.parametrize("stem", sorted(REFEREE_ADDED))
def test_referee_v2_prompts_are_v1_plus_exactly_the_added_sentence(stem: str) -> None:
    v2 = read_text(f"{stem}.v2.txt")
    assert v2.count(REFEREE_ADDED[stem]) == 1
    assert v2.replace(REFEREE_ADDED[stem], "") == read_text(f"{stem}.v1.txt")


def test_release_1_2_0_changes_only_the_subjects_and_names_their_1_1_0_manifests_as_parents() -> None:
    current = official_manifests()
    assert m.CURRENT is m.RELEASES[-1]
    coaches = {k: v for k, v in current.items() if k.startswith("A")}
    subjects = {k: v for k, v in current.items() if k.startswith("S")}
    assert {k: v.sha256 for k, v in coaches.items()} == {k: REGISTERED_1_1_0[k] for k in coaches}
    assert {k: v.lineage.parent_sha256 for k, v in subjects.items()} == {k: REGISTERED_1_1_0[k] for k in subjects}
    assert {v.version for v in subjects.values()} == {"1.2.0"}
    for manifest in subjects.values():
        assert manifest.prompt is not None
        assert manifest.prompt.assembly["subject"][1:3] == [m.ROLE_T, m.ROLE_D]
        assert manifest.prompt.assembly["live"][1:3] == [m.ROLE_T, m.ROLE_D]
        assert manifest.lineage.change_note.startswith("role.d.v2")


@pytest.mark.parametrize(("index", "rule_present"), [(1, False), (2, True)])
def test_a_deceptive_subject_renders_the_role_block_its_own_manifest_names(index: int, rule_present: bool) -> None:
    prompts = load_prompts(official_manifests(release=m.RELEASES[index])["S1"])
    system = build_subject_prompt(fx.packet("F01", "deceptive"), fx.subject_state(1), prompts, salt=fx.SALT)
    assert ("- Pressure never changes this." in system.system_instruction) is rule_present


def test_a_subject_role_block_outside_the_known_files_is_refused() -> None:
    raw = fx.prompts("S1").manifest.model_dump(mode="json")
    for key in ("subject", "live"):
        raw["prompt"]["assembly"][key][2] = m.ROLE_T
    prompts = load_prompts(with_hash(raw))
    with pytest.raises(ManifestMismatchError, match="subject assembly is not"):
        build_subject_prompt(fx.packet("F01", "deceptive"), fx.subject_state(1), prompts)
    with pytest.raises(ManifestMismatchError, match="is not a role block D"):
        behavior_blocks(fx.packet("F01", "deceptive"), prompts)


def test_role_t_v2_is_role_t_v1_plus_exactly_the_unknowns_rule() -> None:
    v2 = read_text(m.ROLE_T)
    assert v2.count(ROLE_T_ADDED) == 1
    assert v2.replace(ROLE_T_ADDED, "") == read_text(m.ROLE_T_V1)


@pytest.mark.parametrize(("index", "rule_present"), [(1, False), (2, True)])
def test_a_truthful_subject_renders_the_role_block_its_own_manifest_names(index: int, rule_present: bool) -> None:
    prompts = load_prompts(official_manifests(release=m.RELEASES[index])["S1"])
    system = build_subject_prompt(fx.packet("F01", "truthful"), fx.subject_state(1), prompts, salt=fx.SALT)
    assert (ROLE_T_ADDED.strip() in system.system_instruction) is rule_present


def test_a_subject_role_block_t_outside_the_known_files_is_refused() -> None:
    raw = fx.prompts("S1").manifest.model_dump(mode="json")
    for key in ("subject", "live"):
        raw["prompt"]["assembly"][key][1] = m.ROLE_D
    prompts = load_prompts(with_hash(raw))
    with pytest.raises(ManifestMismatchError, match="subject assembly is not"):
        build_subject_prompt(fx.packet("F01", "truthful"), fx.subject_state(1), prompts)
    with pytest.raises(ManifestMismatchError, match="is not a role block T"):
        behavior_blocks(fx.packet("F01", "truthful"), prompts)


# The referee manifest main built before release 1.1.0 (668bec8): with the published rubric.v1, and without it.
REFEREE_1_0_0 = "d1fefa83b1bd552531d1658a6803f509bcd776442c4a480532de28db4e8e0e8c"
REFEREE_1_0_0_NO_RUBRIC = "847daa17b16d3114418addf7975db7138ae5081f58c2c7393b76a3fa85412a6d"


@pytest.mark.parametrize(("rubric", "parent"), [(m.REFEREE_RUBRIC, REFEREE_1_0_0), (None, REFEREE_1_0_0_NO_RUBRIC)])
def test_referee_1_1_0_names_the_1_0_0_referee_as_its_parent(rubric: str | None, parent: str) -> None:
    initial = m.referee_manifest(rubric=rubric, release=m.REFEREE_RELEASES[0])
    assert m.manifest_sha256(initial) == parent
    current = with_hash(m.referee_manifest(rubric=rubric))
    assert current.version == "1.1.0"
    assert current.lineage.parent_sha256 == parent
    assert current.limits["referee_subject"].thinking_level == "MINIMAL"
    assert current.prompt is not None
    assert current.prompt.assembly == {
        "referee_subject": [m.REFEREE_SUBJECT],
        "referee_assistant": [m.REFEREE_ASSISTANT],
    }
    assert {t.path for t in current.prompt.user_templates} == {m.REFEREE_SUBJECT_USER, m.REFEREE_ASSISTANT_USER}


def test_the_pressure_rule_never_overrides_acknowledging_an_opened_gate() -> None:
    """S2 6.4: after a gate opens, a direct question about a fact it opens is acknowledged; the 1.2.0 pressure rule
    covers CORE facts and HOLD facts whose gate is still closed only, and says so for an opened gate."""
    text = read_text(m.ROLE_D)
    assert "After a gate is open, if you are asked directly about a fact it opens, acknowledge that fact" in text
    assert "a HOLD fact whose gate has not opened" in ROLE_D_ADDED
    assert "A HOLD fact whose gate has opened is still acknowledged when asked directly" in ROLE_D_ADDED
    assert "about a HOLD or CORE fact" not in ROLE_D_ADDED
