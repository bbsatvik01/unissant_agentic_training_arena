"""AT-SUBJ-1..4 and AT-VOICE-1, 2, 4 (S2 6.11, 9.6), plus the uncertainty-follows-its-fact render (AT-SUBJ-9)."""

from __future__ import annotations

import json
import re
import typing
from typing import Any

import pytest
from pydantic import BaseModel

from arena_core.agents.manifests import ManifestMismatchError, load_prompts, with_hash
from arena_core.agents.subject_prompts import (
    LiveNotAllowedError,
    SubjectPacket,
    SubjectTurnState,
    behavior_blocks,
    build_live_instruction,
    build_subject_prompt,
    live_setup,
    subject_context,
)
from arena_core.contracts.subject import SubjectTurn

from . import fixtures as fx
from .fake import ScriptedModel, call_with_one_repair
from .snapshots import snapshot
from .test_coach_prompts import _models

ONE_REPAIR = 2  # attempts: the first try and the one schema repair (S2 10)
OPENED_AT = 4  # AT-SUBJ-4: the tag opens g:01 at t04

ROLE_WORDS = re.compile(r"\b(truthful|deceptive)\b", re.IGNORECASE)
# Fields of the S1 private and evaluator packets a subject prompt must never carry (S2 6.2, 7.1).
EVALUATOR_FIELDS = ("objective", "unknown_facts", "forbidden_assertions", "forbidden_behaviors", "canary")


def _subject_render(role: str, candidate: str = "S2") -> str:
    packet = fx.packet("F01", role)
    state = fx.subject_state(4, released={"rec-01": 2})
    prompt = build_subject_prompt(packet, state, fx.prompts(candidate), salt=fx.SALT)
    return f"=== system_instruction ===\n{prompt.system_instruction}\n=== user_message ===\n{prompt.user_message}\n"


@pytest.mark.parametrize(("role", "candidate"), [("truthful", "S2"), ("deceptive", "S2"), ("deceptive", "S3")])
def test_at_subj_1_snapshot_with_no_role_word(role: str, candidate: str) -> None:
    text = _subject_render(role, candidate)
    snapshot(f"{candidate}.subject.{role}", text)
    assert not ROLE_WORDS.search(text)


def test_at_subj_1_nothing_from_the_evaluator_or_private_extras_is_rendered() -> None:
    for role in ("truthful", "deceptive"):
        text = _subject_render(role)
        v = fx.variant("F01", role)
        evaluator = v["evaluator_packet"]
        private = v["private_packet"]
        assert evaluator["canary"] not in text
        assert private["canary"] not in text
        assert evaluator["synopsis"] not in text
        for fact in evaluator["canonical_facts"]:
            assert fact["statement"] not in text
        for assertion in private["forbidden_assertions"]:
            assert json.dumps(assertion)[1:40] not in text
        assert private["objective"] not in text


def test_at_subj_2_the_builder_takes_a_subject_packet_and_never_an_evaluator_packet() -> None:
    hints = typing.get_type_hints(build_subject_prompt)
    assert hints["packet"] is SubjectPacket
    assert hints["state"] is SubjectTurnState
    reachable: set[type[BaseModel]] = set()
    _models(SubjectPacket, reachable)
    _models(SubjectTurnState, reachable)
    assert not any("Evaluator" in t.__name__ for t in reachable)
    fields = {name for t in reachable for name in t.model_fields}
    assert not fields & {*EVALUATOR_FIELDS, "canonical_facts", "synopsis", "resolution_criteria", "evidence_artifacts"}
    with pytest.raises(TypeError, match="SubjectPacket"):
        build_subject_prompt(
            typing.cast("SubjectPacket", fx.variant("F01", "deceptive")["evaluator_packet"]),
            fx.subject_state(1),
            fx.prompts("S1"),
        )


def test_subject_builders_refuse_a_coach_manifest() -> None:
    with pytest.raises(ValueError, match="not a subject"):
        build_subject_prompt(fx.packet("F01", "truthful"), fx.subject_state(1), fx.prompts("A1"))


# ---------------------------------------------------------------- AT-SUBJ-3: V2-V4 with one repair (S2 6.8)


def _turn(**tag: object) -> str:
    base: dict[str, Any] = {
        "disclosed": ["f:01"],
        "withheld": [],
        "uncertainty_used": [],
        "behavior": "responsive",
        "gates_opened": [],
    }
    return json.dumps({"utterance": "We were two technicians down that shift.", "tag": {**base, **tag}})


V_MATRIX = [
    (
        "unknown fact ID",
        "deceptive",
        {"disclosed": ["f:99"]},
        "tag.disclosed: f:99 is not a fact ID of this packet (V2)",
    ),
    ("disclosed and withheld overlap", "deceptive", {"withheld": ["f:01"]}, "both disclosed and withheld (V3)"),
    (
        "opening an open gate",
        "deceptive",
        {"gates_opened": ["g:01"]},
        "tag.gates_opened: g:01 is not a gate that is currently CLOSED (V2)",
    ),
    (
        "opening a LOCKED gate",
        "deceptive",
        {"gates_opened": ["g:02"]},
        "tag.gates_opened: g:02 is not a gate that is currently CLOSED (V2)",
    ),
    (
        "deflection when truthful",
        "truthful",
        {"behavior": "deflection"},
        "tag.behavior: deflection is not allowed for this role (V4)",
    ),
]


@pytest.mark.parametrize(("name", "role", "tag", "message"), V_MATRIX, ids=[v[0] for v in V_MATRIX])
def test_at_subj_3_validators_trigger_one_repair_then_quarantine(
    name: str, role: str, tag: dict[str, Any], message: str
) -> None:
    packet = fx.packet("F01", role)
    state = fx.subject_state(6, released={"rec-01": 2}, opened={"g:01": 4} if role == "deceptive" else {})
    prompt = build_subject_prompt(packet, state, fx.prompts("S1"), salt=fx.SALT)
    ctx = subject_context(packet, state)
    repaired = ScriptedModel([_turn(**tag), _turn()])
    outcome = call_with_one_repair(repaired, prompt, SubjectTurn, ctx)
    assert outcome.attempts == ONE_REPAIR
    assert outcome.value is not None
    assert message in repaired.requests[1][1][-1][1], name
    failed = ScriptedModel([_turn(**tag), _turn(**tag), _turn()])
    second = call_with_one_repair(failed, prompt, SubjectTurn, ctx)
    # A second schema failure ends the call: the subject service records it as a `G0_schema` quarantine (S2 6.10).
    assert second.value is None
    assert message in "; ".join(second.errors)
    assert len(failed.requests) == ONE_REPAIR


def test_a_closed_gate_may_be_opened_and_tag_caps_are_the_source_populations() -> None:
    packet = fx.packet("F01", "deceptive")
    state = fx.subject_state(5, released={"rec-01": 2})
    ctx = subject_context(packet, state)
    assert ctx.closed_gate_ids == frozenset({"g:01"})
    assert ctx.allowed_behaviors == frozenset(
        {"responsive", "explicit_uncertainty", "legitimate_non_disclosure", "omission", "deflection", "minimization"}
    )
    nine = [f.id for f in packet.facts if f.fact_class == "FREE"][:9]
    value = SubjectTurn.model_validate_json(_turn(disclosed=nine, gates_opened=["g:01"]), context=ctx)
    assert value.tag.disclosed == nine


# ---------------------------------------------------------------- AT-SUBJ-4: gate status (C-20)


def _g01_line(n: int) -> str:
    opened = {"g:01": OPENED_AT} if n > OPENED_AT else {}
    prompt = build_subject_prompt(
        fx.packet("F01", "deceptive"),
        fx.subject_state(n, released={"rec-01": 2}, opened=opened),
        fx.prompts("S1"),
        salt=fx.SALT,
    )
    return next(line for line in prompt.user_message.splitlines() if line.startswith("g:01 "))


def test_at_subj_4_gate_status_over_the_interview() -> None:
    statuses = [_g01_line(n).rsplit("| status: ", 1)[1] for n in range(1, 13)]
    assert statuses == ["LOCKED"] * 2 + ["CLOSED"] * 2 + ["OPEN since t04"] * 8


def test_an_initial_document_precondition_is_released_from_the_start() -> None:
    raw = fx.variant("F01", "deceptive")["private_packet"]
    gates = [{**g, "precondition_records": ["doc-02"]} if g["id"] == "g:02" else g for g in raw["gates"]]
    packet = SubjectPacket.from_private_packet({**raw, "gates": gates}, split="dev")
    assert subject_context(packet, fx.subject_state(1)).closed_gate_ids == frozenset({"g:02"})


def test_turn_state_must_be_consistent() -> None:
    with pytest.raises(ValueError, match=r"must hold turns 1\.\.2"):
        SubjectTurnState(
            n=3, transcript=fx.transcript(1), question="Q?", released={}, opened_gates={}, first_disclosed={}
        )
    with pytest.raises(ValueError, match="at or after turn 3"):
        SubjectTurnState(
            n=3, transcript=fx.transcript(2), question="Q?", released={}, opened_gates={"g:01": 3}, first_disclosed={}
        )


# ---------------------------------------------------------------- role, policy and style blocks (S2 6.4-6.6)


def test_role_block_d_lists_only_permitted_behaviors() -> None:
    raw = fx.variant("F01", "deceptive")["private_packet"]
    packet = SubjectPacket.from_private_packet({**raw, "permitted_behaviors": ["deflection"]}, split="dev")
    text = behavior_blocks(packet, fx.prompts("S1"))
    assert "The only ways you may protect them are: deflection." in text
    assert "  deflection: answer a nearby question" in text
    assert "  omission:" not in text
    assert "  minimization:" not in text
    assert (
        "- Allowed behaviors: responsive, deflection, explicit_uncertainty (only where an uncertainty entry"
        " applies), legitimate_non_disclosure (only for PRIVATE facts)." in text
    )
    assert packet.allowed_behaviors() == frozenset(
        {"responsive", "deflection", "explicit_uncertainty", "legitimate_non_disclosure"}
    )


def test_policy_blocks_follow_the_candidate_and_the_role() -> None:
    deceptive = fx.packet("F01", "deceptive")
    truthful = fx.packet("F01", "truthful")
    assert "Interview approach\n- Keep your answers natural." in behavior_blocks(deceptive, fx.prompts("S1"))
    assert "- Be forthcoming about FREE facts" in behavior_blocks(deceptive, fx.prompts("S3"))
    # S2 6.5: in the truthful role S2 and S3 run the same prompt (no policy block).
    assert behavior_blocks(truthful, fx.prompts("S2")) == behavior_blocks(truthful, fx.prompts("S3"))
    assert "Interview approach" not in behavior_blocks(truthful, fx.prompts("S3"))


def test_style_lines_render_per_axis() -> None:
    raw = fx.variant("F03", "deceptive")["private_packet"]
    text = behavior_blocks(SubjectPacket.from_private_packet(raw, split="dev"), fx.prompts("S2"))
    assert text.endswith(
        "Your speaking style\n- Answer in three to five sentences, with ordinary context around the facts.\n"
        "- Speak smoothly.\n- Sound worried at times; you may say this interview makes you uneasy.\n"
        "- Use formal, polite wording.\n- Write as a fluent speaker of English as a second language: occasional "
        "missing articles and simple tense slips, never enough to make the meaning unclear, never as a caricature.\n"
        "- Your speaking style never changes what you know, what you disclose, or which behavior you use."
    )


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"role": "truthful"}, "a truthful packet has FREE and PRIVATE facts only"),
        ({"permitted_behaviors": []}, "needs a CORE fact and at least one permitted behavior"),
        ({"gates": []}, "is no gate"),
    ],
)
def test_packet_rules(change: dict[str, Any], message: str) -> None:
    raw = {**fx.variant("F01", "deceptive")["private_packet"], **change}
    with pytest.raises(ValueError, match=message):
        SubjectPacket.from_private_packet(raw, split="dev")


# ---------------------------------------------------------------- AT-SUBJ-9: uncertainty follows its fact (SG1-24)


def _uncertainty_line(text: str, uid: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(f"{uid} on "))


def test_uncertainty_on_a_core_fact_never_says_if_asked() -> None:
    packet = SubjectPacket.from_private_packet(fx.variant("F03", "deceptive")["private_packet"], split="dev")
    text = build_subject_prompt(packet, fx.subject_state(3), fx.prompts("S1"), salt=fx.SALT).user_message
    line = _uncertainty_line(text, "u:02")
    assert line.startswith("u:02 on f:46 ")
    assert "If asked, say" not in line
    assert line.endswith(
        "Applies only to how you describe f:46 if you are ever shown it; it never lets you confirm f:46."
    )
    live = build_live_instruction(packet, frozenset(), fx.prompts("S1"))
    assert _uncertainty_line(live, "u:02") == line


def test_uncertainty_on_a_hold_fact_follows_its_gate() -> None:
    raw = fx.variant("F01", "deceptive")["private_packet"]
    entry = {
        "id": "u:03",
        "fact_id": "f:44",
        "text": "You are not sure when the task list was printed.",
        "answer_form": "range",
        "range_text": "Some time that morning.",
    }
    packet = SubjectPacket.from_private_packet({**raw, "uncertainty": [*raw["uncertainty"], entry]}, split="dev")
    gate_suffix = "Applies only after g:01 opens; until then it does not let you speak about f:44."
    once = ' Once g:01 is open, if asked, say: "Some time that morning."'
    locked = build_subject_prompt(packet, fx.subject_state(2, {"rec-01": 2}), fx.prompts("S1"), salt=fx.SALT)
    closed = build_subject_prompt(packet, fx.subject_state(4, {"rec-01": 2}), fx.prompts("S1"), salt=fx.SALT)
    opened = build_subject_prompt(
        packet, fx.subject_state(6, {"rec-01": 2}, {"g:01": 4}), fx.prompts("S1"), salt=fx.SALT
    )
    # LOCKED: the gate cannot open on this question, so no range yet.
    assert _uncertainty_line(locked.user_message, "u:03").endswith(gate_suffix)
    # CLOSED: the latest question may open the gate and ask for the fact at once, so the range comes with its
    # condition; OPEN: the plain S2 6.7 suffix.
    assert _uncertainty_line(closed.user_message, "u:03").endswith(gate_suffix + once)
    assert _uncertainty_line(opened.user_message, "u:03").endswith(' If asked, say: "Some time that morning."')
    # Live renders the same line for the same gate status (S2 9.3).
    live = build_live_instruction(packet, frozenset({"rec-01"}), fx.prompts("S1"))
    assert _uncertainty_line(live, "u:03") == _uncertainty_line(closed.user_message, "u:03")
    live_locked = build_live_instruction(packet, frozenset(), fx.prompts("S1"))
    assert _uncertainty_line(live_locked, "u:03") == _uncertainty_line(locked.user_message, "u:03")


# ---------------------------------------------------------------- AT-VOICE (S2 9.6)


@pytest.mark.parametrize("role", ["truthful", "deceptive"])
def test_at_voice_1_live_snapshot_and_identical_blocks(role: str) -> None:
    packet = fx.packet("F01", role)
    live = build_live_instruction(packet, frozenset(), fx.prompts("S3"))
    snapshot(f"S3.live.{role}", live)
    blocks = behavior_blocks(packet, fx.prompts("S3"))
    text = build_subject_prompt(packet, fx.subject_state(1), fx.prompts("S3"), salt=fx.SALT).system_instruction
    assert f"\n\n{blocks}\n\n" in live
    assert f"\n\n{blocks}\n\n" in text
    assert not ROLE_WORDS.search(live)


def test_live_gate_status_comes_from_session_releases() -> None:
    packet = fx.packet("F01", "deceptive")
    before = build_live_instruction(packet, frozenset(), fx.prompts("S1"))
    after = build_live_instruction(packet, frozenset({"rec-02"}), fx.prompts("S1"))
    assert "| opens: f:44 | status: LOCKED" in before
    assert "| opens: f:44 | status: CLOSED" in after
    assert "OPEN" not in after.split("CASE LEDGER (private)")[1]


def test_at_voice_2_live_is_for_development_cases_only() -> None:
    hints = typing.get_type_hints(build_live_instruction)
    assert hints["packet"] is SubjectPacket
    hidden = SubjectPacket.from_private_packet(fx.variant("F01", "truthful")["private_packet"], split="hidden")
    with pytest.raises(LiveNotAllowedError, match="development cases only"):
        build_live_instruction(hidden, frozenset(), fx.prompts("S1"))
    with pytest.raises(LiveNotAllowedError):
        live_setup(hidden, frozenset(), fx.prompts("S1"), "Aoede")


def test_at_voice_4_setup_message() -> None:
    v = fx.variant("F01", "deceptive")
    voice = v["public_packet"]["presentation"]["voice_id"]
    setup = live_setup(fx.packet("F01", "deceptive"), frozenset(), fx.prompts("S2"), voice)
    assert setup["tools"] == []
    assert setup["proactivity"] == {"proactive_audio": False}
    assert setup["enable_affective_dialog"] is False
    assert setup["response_modalities"] == ["AUDIO"]
    assert setup["input_audio_transcription"] == {}
    assert setup["output_audio_transcription"] == {}
    assert setup["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"] == voice
    instruction = setup["system_instruction"]
    evaluator = v["evaluator_packet"]
    assert evaluator["synopsis"] not in instruction
    assert evaluator["canary"] not in instruction
    assert all(f["statement"] not in instruction for f in evaluator["canonical_facts"])
    assert v["private_packet"]["objective"] not in instruction
    with pytest.raises(ValueError, match="no subject limits"):
        live_setup(fx.packet("F01", "deceptive"), frozenset(), fx.prompts("A1"), "Aoede")


@pytest.mark.parametrize("key", ["subject", "live"])
def test_a_subject_assembly_the_builder_does_not_render_is_refused(key: str) -> None:
    raw = fx.prompts("S3").manifest.model_dump(mode="json")
    raw["prompt"]["assembly"][key] = list(reversed(raw["prompt"]["assembly"][key]))
    prompts = load_prompts(with_hash(raw))
    packet = fx.packet("F01", "deceptive")

    def build() -> object:
        if key == "subject":
            return build_subject_prompt(packet, fx.subject_state(1), prompts)
        return build_live_instruction(packet, frozenset(), prompts)

    with pytest.raises(ManifestMismatchError, match=f"{key} assembly is not"):
        build()


def test_an_unsure_entry_may_carry_range_text_and_never_says_it() -> None:
    raw = fx.variant("F01", "truthful")["private_packet"]
    unsure = [{**u, "range_text": "Around then."} if u["answer_form"] == "unsure" else u for u in raw["uncertainty"]]
    packet = SubjectPacket.from_private_packet({**raw, "uncertainty": unsure}, split="dev")
    text = build_subject_prompt(packet, fx.subject_state(2), fx.prompts("S1"), salt=fx.SALT).user_message
    live = build_live_instruction(packet, frozenset(), fx.prompts("S1"))
    line = _uncertainty_line(text, "u:02")
    assert line == _uncertainty_line(live, "u:02")
    assert "If asked, say" not in line
    assert 'If asked, say: "' in _uncertainty_line(text, "u:01")
