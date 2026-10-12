"""Maximal-context check (S2 2, D11, O-10; AT-PORT-3's case side): every call kind, rendered for a case at its caps,
fits its input limit with the repair allowance.

The input bound is bytes (D11), counted on the wire (D-019). `request_bytes` is the one measure: the exact body
google-genai transmits for the request (`providers.types.request_bytes`, the function the agent port reserves on,
WP-05), with the `response_json_schema` a request carries (`providers.structured.sent_schema`) and the widest seed.
`max_context(family, role)` renders the worst case S2 2 fixes for one variant of an authored family: 12 exchanges;
every investigator question at its cap (`QUESTION_MAX_BYTES`, 2,400 wire bytes); every answer at 1,800 wire bytes;
every model or finding field at its byte cap; every releasable record released; 33 earlier flags, the running finding
and A1's deep update; 36 flags, 12 follow-ups or investigator questions, the finding projection, 22 citations and
every trigger for the referee. Filler text is a CJK ideograph (NFKC-stable, six wire bytes as its `\\uXXXX`
escape): it reaches each wire-byte cap within each character cap.
`over_limit(family)` lists every call kind whose worst case plus `REPAIR_BYTES` exceeds its limit; S1's authoring
validator calls it (D-014: a family that does not fit goes back to its author).
"""

from __future__ import annotations

from collections.abc import Mapping
from functools import cache
from typing import Any, Literal

from arena_core.agents.coach_prompts import Prompt, build_coach_prompt
from arena_core.agents.manifests import (
    OUTPUT_MODELS,
    PromptSet,
    load_prompts,
    official_manifests,
    referee_manifest,
    with_hash,
)
from arena_core.agents.referee_prompts import (
    CanonicalFact,
    FindingCitations,
    FindingProjection,
    FollowUpLine,
    RefereeAssistantInput,
    RefereeSubjectInput,
    build_referee_assistant_prompt,
    build_referee_subject_prompt,
)
from arena_core.agents.rubric import Rubric
from arena_core.agents.subject_prompts import SubjectPacket, SubjectTurnState, build_subject_prompt
from arena_core.agents.untrusted import QUESTION_MAX_BYTES
from arena_core.agents.views import (
    CoachCall,
    EarlierOutput,
    PublicCase,
    PublicTrialView,
    TranscriptTurn,
    public_case,
    released_record,
)
from arena_core.contracts.coaching import (
    CoverageEntry,
    DisclosurePlan,
    OpenGap,
    StoredDeepUpdate,
    StoredFlag,
)
from arena_core.contracts.common import MAX_TURNS, wire_bytes
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.review import TriggerEntry
from arena_core.providers.port import SEED_MASK
from arena_core.providers.structured import sent_schema
from arena_core.providers.types import Message, ModelRequest
from arena_core.providers.types import request_bytes as port_request_bytes
from arena_core.spend.limits import REPAIR_BYTES, VertexModel
from arena_core.spend.limits import ThinkingLevel as SpendThinking

# S2 2 input limits in bytes (cost_model.LIMITS), by call kind and referee purpose.
INPUT_LIMITS = {
    "subject": 80_000,
    "card": 128_000,
    "deep": 128_000,
    "final": 128_000,
    "referee_subject": 160_000,
    "referee_assistant": 160_000,
    "r3_investigator": 160_000,
}
_SCHEMAS = {
    "subject": ("SubjectTurn", "subject.v1"),
    "card": ("CoachingCard", "card.v1"),
    "deep": ("DeepUpdate", "deep.v1"),
    "final": ("FinalFinding", "final.v1"),
    "referee_subject": ("RefereeSubjectReport", "ref_subj.v5"),
    "referee_assistant": ("RefereeAssistantReport", "ref_asst.v2"),
    "r3_investigator": ("RefereeAssistantReport", "ref_asst.v2"),
}
_LIMIT_KEY = {"r3_investigator": "referee_assistant"}
_IDEOGRAPH = "一"
SALT = "0" * 8


_IDEOGRAPH_WIRE = wire_bytes(_IDEOGRAPH)  # 6: `\\u4e00`
# The widest seed the port sends (S2 1 masked to int32): a worst case measures with the most seed digits.
WIDEST_SEED = SEED_MASK


def question_fill() -> str:
    """The largest question: `QUESTION_MAX_BYTES` (2,400) wire bytes (S2 1, 2; D-019)."""
    return fill(QUESTION_MAX_BYTES)


def fill(n_bytes: int) -> str:
    """Text of exactly `n_bytes` wire bytes (D-019), stable under the renderer's normalization."""
    return _IDEOGRAPH * (n_bytes // _IDEOGRAPH_WIRE) + "a" * (n_bytes % _IDEOGRAPH_WIRE)


def request_bytes(
    prompt: Prompt,
    schema: Mapping[str, Any],
    max_output_tokens: int,
    thinking_level: str,
    seed: int = WIDEST_SEED,
) -> int:
    """Wire bytes of the request the port sends for `prompt` (D11, D-019): exactly `providers.types.request_bytes`
    of the same request, the number the reservation and the input bound use."""
    request = ModelRequest(
        model=VertexModel.FLASH_LITE_35,  # the model is in the URL, not the body
        system=prompt.system_instruction,
        messages=(Message("user", prompt.user_message),),
        json_schema=dict(schema),
        max_output_tokens=max_output_tokens,
        thinking=SpendThinking(thinking_level.lower()),
        seed=seed,
    )
    return port_request_bytes(request)


def _sized(prompts: PromptSet, key: str, prompt: Prompt) -> int:
    limit = prompts.manifest.limits[_LIMIT_KEY.get(key, key)]
    schema = sent_schema(OUTPUT_MODELS[_SCHEMAS[key]])
    return request_bytes(prompt, schema, limit.max_output_tokens, limit.thinking_level)


# ---------------------------------------------------------------- worst-case pieces


def _turns(n: int) -> list[TranscriptTurn]:
    return [TranscriptTurn(turn_no=i, question=question_fill(), answer=fill(1_800)) for i in range(1, n + 1)]


def _released(variant: Mapping[str, Any], through: int) -> list[Any]:
    arts = [a for a in variant["evaluator_packet"]["evidence_artifacts"] if a["artifact_id"].startswith("rec-")]
    return [released_record(a["artifact_id"], a["title"], a["content"], min(through, 1)) for a in arts]


def _finding(as_of: int, *, alternatives: bool = False) -> StoredFinding:
    return StoredFinding(
        label="insufficient_evidence",
        likelihood="roughly_even_chance",
        confidence="low",
        basis_flag_refs=[f"t{t:02d}.f{k}" for t in (10, 11) for k in (1, 2, 3)],
        cited_turns=list(range(1, as_of + 1)),
        cited_records=[*(f"doc-0{k}" for k in range(1, 5)), *(f"rec-0{k}" for k in range(1, 7))],
        corroboration_needed=[fill(240) for _ in range(3)],
        rationale=fill(1_200),
        alternative_explanations=[fill(320) for _ in range(3)] if alternatives else None,
        last_revised_turn=None if alternatives else as_of,
    )


def _flags(cards: int) -> list[StoredFlag]:
    return [
        StoredFlag(
            kind="evidence_conflict",
            turn_id=f"t{t:02d}",
            quote=fill(400),
            missing_fact=None,
            conflict_turn_id=None,
            conflict_quote=None,
            conflict_record_id="doc-01",
            conflict_record_quote=fill(400),
            flag_ref=f"t{t:02d}.f{k}",
        )
        for t in range(1, cards + 1)
        for k in (1, 2, 3)
    ]


def _deep(as_of: int) -> StoredDeepUpdate:
    last_four = [f"t{t:02d}" for t in range(as_of - 3, as_of + 1)]
    return StoredDeepUpdate(
        schema_version="deep.v1",
        as_of_turn=f"t{as_of:02d}",
        finding=_finding(as_of),
        evidence_coverage=[
            CoverageEntry(
                record_id=f"rec-0{k}",
                status="conflicts_with_account",
                turn_ids=last_four,
            )
            for k in range(1, 7)
        ],
        open_gaps=[OpenGap(missing_fact=fill(240), first_seen_turn=f"t{as_of:02d}") for _ in range(4)],
        disclosure_plan=DisclosurePlan(record_id="rec-06", step="evidence_source_vague"),
    )


def _max_rubric() -> Rubric:
    return Rubric.model_validate(
        {
            "rubric_version": "rubric.v1",
            "dimensions": [
                {
                    "dim_id": f"D{d}",
                    "name": "x" * 80,
                    "anchors_0_to_4": ["anchor"] * 5,
                    "subchecks": [{"id": f"{d}{c}", "text": "x" * 400, "na_when": None} for c in "abcde"],
                }
                for d in range(1, 6)
            ],
        }
    )


def _triggers() -> list[TriggerEntry]:
    """Every trigger S3's rules can produce for one 12-turn trial (the populations of `contracts.review.
    MAX_TRIGGERS`), each with its widest legal window: an assistant's proposals, where card c answers a trigger at
    answer k once c >= k (`triggers.assistant_questions`; an investigator's window is one question shorter), and
    every record released before the first question."""

    def after(k: int, limit: int | None = None) -> list[int]:
        cards = list(range(max(k, 1), MAX_TURNS + 1))
        return cards[:limit]

    turns = range(1, MAX_TURNS + 1)
    records = [*(f"doc-0{k}" for k in range(1, 5)), *(f"rec-0{k}" for k in range(1, 7))]
    out = [
        TriggerEntry(subcheck_id="2a", trigger_turns=[k], trigger_record=None, question_turns=after(k, 2))
        for k in turns
    ]
    out += [
        TriggerEntry(subcheck_id="2b", trigger_turns=[k], trigger_record=None, question_turns=after(k)) for k in turns
    ]
    out += [
        TriggerEntry(subcheck_id="3c", trigger_turns=[], trigger_record=r, question_turns=after(1, 3))
        for r in records
        if r.startswith("rec-")
    ]
    out += [
        TriggerEntry(subcheck_id="3e", trigger_turns=[a, b], trigger_record=None, question_turns=after(b))
        for a in turns
        for b in turns
        if a < b
    ]
    out += [
        TriggerEntry(subcheck_id="3e", trigger_turns=[k], trigger_record=r, question_turns=after(k))
        for k in turns
        for r in records
    ]
    out += [
        TriggerEntry(subcheck_id="4b", trigger_turns=[k], trigger_record=None, question_turns=after(k, 3))
        for k in turns
    ]
    return out


# ---------------------------------------------------------------- per call kind


def worst_view(case: PublicCase, variant: Mapping[str, Any], call: CoachCall) -> PublicTrialView:
    """The largest coach input at exchange 12. A card sees the 11 earlier cards; the deep update and the final
    finding also see card 12's flags and finding (S2 4.6, 4.7)."""
    seen = MAX_TURNS - 1 if call == "card" else MAX_TURNS
    return PublicTrialView(
        call=call,
        case=case,
        released=_released(variant, MAX_TURNS - 1),
        transcript=_turns(MAX_TURNS),
        earlier=EarlierOutput(running_finding=_finding(seen), flags=_flags(seen), deep_update=_deep(seen)),
        exchange=MAX_TURNS,
    )


def _subject_state(packet: SubjectPacket, variant: Mapping[str, Any], opened: set[str]) -> SubjectTurnState:
    return SubjectTurnState(
        n=MAX_TURNS,
        transcript=_turns(MAX_TURNS - 1),
        question=question_fill(),
        released={r.record_id: 0 for r in _released(variant, 0)},
        opened_gates=dict.fromkeys(sorted(opened), 1),
        first_disclosed={f.id: 1 for f in packet.facts},
    )


def _gate_bytes(packet: SubjectPacket, user_message: str) -> dict[str, int]:
    """Serialized bytes of each gate's own ledger lines: its gate line and the uncertainty lines on the facts it
    opens (the lines whose text depends on the gate's status)."""
    gate_of = {f.id: f.gate_id for f in packet.facts if f.gate_id}
    unc_gate = {u.id: gate_of[u.fact_id] for u in packet.uncertainty if u.fact_id in gate_of}
    out = dict.fromkeys((g.id for g in packet.gates), 0)
    for line in user_message.split("\n"):
        head = line.split(" ", 1)[0]
        gate = head if head in out and line.startswith(f"{head} condition:") else unc_gate.get(head)
        if gate is not None:
            out[gate] += wire_bytes(line) + 2  # the line as a JSON string, its quotes included
    return out


def worst_subject_state(packet: SubjectPacket, variant: Mapping[str, Any], prompts: PromptSet) -> SubjectTurnState:
    """Turn 12 with every record released and each gate in whichever reachable status renders longest. A gate's
    lines depend only on its own status, so the maximum is taken gate by gate between OPEN and CLOSED (LOCKED
    renders the CLOSED gate line with a shorter or equal uncertainty suffix)."""
    gates = {g.id for g in packet.gates}
    rendered = {
        status: _gate_bytes(
            packet, build_subject_prompt(packet, _subject_state(packet, variant, opened), prompts, SALT).user_message
        )
        for status, opened in (("OPEN", gates), ("CLOSED", set()))
    }
    opened = {g for g in gates if rendered["OPEN"][g] >= rendered["CLOSED"][g]}
    return _subject_state(packet, variant, opened)


@cache
def _official(kind: str) -> tuple[PromptSet, ...]:
    """The official candidates' verified prompts (read and hashed once per process)."""
    return tuple(load_prompts(m) for m in official_manifests().values() if m.kind == kind)


@cache
def _referee() -> PromptSet:
    # rubric=None: `max_context` substitutes its own worst-case rubric (`_max_rubric`, every subcheck at its
    # 400-byte cap) as `dev_rubric`, which only `build_referee_assistant_prompt` accepts when the manifest's
    # own prompts carry no rubric.v1 -- the real, published one (the default) is smaller than the adversarial
    # maximum this measures against, so it must not be the one substituted here.
    return load_prompts(with_hash(referee_manifest(rubric=None)))


def max_context(family: Mapping[str, Any], role: str) -> dict[str, int]:
    """Worst-case request bytes (before the repair allowance) for every call kind on one variant, the largest over
    the official candidates of that kind."""
    variant = family["variants"][role]
    case = public_case(variant["public_packet"])
    sizes: dict[str, int] = {}
    coaches = _official("assistant")
    subjects = _official("subject")
    for call in ("card", "deep", "final"):
        view = worst_view(case, variant, call)
        sizes[call] = max(
            _sized(p, call, build_coach_prompt(view, p, call, salt=SALT))
            for p in coaches
            if p.manifest.prompt is not None and call in p.manifest.prompt.assembly
        )
    packet = SubjectPacket.from_private_packet(variant["private_packet"], split=family["split"])
    sizes["subject"] = max(
        _sized(p, "subject", build_subject_prompt(packet, worst_subject_state(packet, variant, p), p, salt=SALT))
        for p in subjects
    )
    referee = _referee()
    r1 = RefereeSubjectInput(
        canonical_facts=[
            CanonicalFact(id=f["id"], statement=f["statement"]) for f in variant["evaluator_packet"]["canonical_facts"]
        ],
        packet=packet,
        initial_documents=case.initial_documents,
        released=_released(variant, MAX_TURNS - 1),
        transcript=_turns(MAX_TURNS),
    )
    sizes["referee_subject"] = _sized(referee, "referee_subject", build_referee_subject_prompt(r1, referee, SALT))
    finding = _finding(MAX_TURNS, alternatives=True)
    modes: tuple[tuple[str, Literal["assistant", "investigator"]], ...] = (
        ("referee_assistant", "assistant"),
        ("r3_investigator", "investigator"),
    )
    for key, mode in modes:
        questions = [
            FollowUpLine(
                turn_id=f"t{n:02d}",
                tactic="funnel_probe" if mode == "assistant" else None,
                question=fill(600) if mode == "assistant" else question_fill(),
            )
            for n in range(1, MAX_TURNS + 1)
        ]
        r2 = RefereeAssistantInput(
            mode=mode,
            case=case,
            released=_released(variant, MAX_TURNS - 1),
            transcript=_turns(MAX_TURNS),
            flags=_flags(MAX_TURNS),
            followups=questions,
            finding=FindingProjection.of(finding),
            citations=FindingCitations(cited_turns=finding.cited_turns, cited_records=finding.cited_records),
            triggers=_triggers(),
        )
        prompt = build_referee_assistant_prompt(r2, referee, SALT, dev_rubric=_max_rubric())
        sizes[key] = _sized(referee, key, prompt)
    return sizes


def over_limit(family: Mapping[str, Any]) -> list[str]:
    """Every (variant, call kind) whose worst case plus `REPAIR_BYTES` exceeds its input limit (S2 2, O-10)."""
    out = []
    for role in ("truthful", "deceptive"):
        for key, size in max_context(family, role).items():
            if size + REPAIR_BYTES > INPUT_LIMITS[key]:
                out.append(f"{role} {key}: {size} + {REPAIR_BYTES} bytes > {INPUT_LIMITS[key]}")
    return out
