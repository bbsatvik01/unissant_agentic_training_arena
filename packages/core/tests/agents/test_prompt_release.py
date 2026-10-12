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
    current = official_manifests()
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
