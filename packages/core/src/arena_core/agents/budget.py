"""Maximal-context check (S2 2, D11, O-10; AT-PORT-3's case side): every call kind, rendered for a case at its caps,
fits its input limit with the repair allowance.

The input bound is bytes (D11). `request_bytes` is the one measure: the serialized request (system instruction,
contents, and the generation config with the `response_json_schema` a request carries, `providers.structured.
sent_schema`) as UTF-8 JSON; the agent port measures the same function (WP-05). `max_context(family, role)` renders
the worst case S2 2 fixes for one variant of an authored family: 12 exchanges; every investigator question at 600
characters and 1,800 normalized bytes (`untrusted.QUESTION_MAX_BYTES`); every answer at 1,800 bytes; every model or
finding field at its byte cap; every releasable record released; 33 earlier flags, the running finding and A1's deep
update; 36 flags, 12 follow-ups or investigator questions, the finding projection, 22 citations and every trigger
for the referee. Filler text is a CJK ideograph (3 bytes, NFKC-stable): it reaches each byte cap within each
character cap, and JSON serializes it unescaped exactly as `"` serializes escaped (2 bytes per character).
`over_limit(family)` lists every call kind whose worst case plus `REPAIR_BYTES` exceeds its limit; S1's authoring
validator calls it (D-014: a family that does not fit goes back to its author).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
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
    EarlierOutput,
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
from arena_core.contracts.common import MAX_TURNS
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.review import MAX_TRIGGERS, TriggerEntry
from arena_core.providers.structured import sent_schema

REPAIR_BYTES = 5_200  # S2 2: the most a repair adds to a request
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


def fill(n_bytes: int) -> str:
    """Text of exactly `n_bytes` UTF-8 bytes, stable under the renderer's normalization."""
    return _IDEOGRAPH * (n_bytes // 3) + "a" * (n_bytes % 3)


def request_bytes(prompt: Prompt, schema: Mapping[str, Any], max_output_tokens: int, thinking_level: str) -> int:
    """UTF-8 bytes of the serialized request (D11): the measure the reservation and the input bound use."""
    request = {
        "system_instruction": {"parts": [{"text": prompt.system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": prompt.user_message}]}],
        "generation_config": {
            "response_mime_type": "application/json",
            "response_json_schema": schema,
            "max_output_tokens": max_output_tokens,
            "thinking_config": {"thinking_level": thinking_level},
        },
    }
    return len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _sized(prompts: PromptSet, key: str, prompt: Prompt) -> int:
    limit = prompts.manifest.limits[_LIMIT_KEY.get(key, key)]
    schema = sent_schema(OUTPUT_MODELS[_SCHEMAS[key]])
    return request_bytes(prompt, schema, limit.max_output_tokens, limit.thinking_level)


# ---------------------------------------------------------------- worst-case pieces


def _turns(n: int) -> list[TranscriptTurn]:
    return [TranscriptTurn(turn_no=i, question=fill(QUESTION_MAX_BYTES), answer=fill(1_800)) for i in range(1, n + 1)]


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


def _deep() -> StoredDeepUpdate:
    return StoredDeepUpdate(
        schema_version="deep.v1",
        as_of_turn="t11",
        finding=_finding(MAX_TURNS - 1),
        evidence_coverage=[
            CoverageEntry(record_id=f"rec-0{k}", status="conflicts_with_account", turn_ids=["t08", "t09", "t10", "t11"])
            for k in range(1, 7)
        ],
        open_gaps=[OpenGap(missing_fact=fill(240), first_seen_turn="t11") for _ in range(4)],
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
    window = list(range(1, MAX_TURNS + 1))
    return [
        TriggerEntry(subcheck_id="3e", trigger_turns=[11, 12], trigger_record=None, question_turns=window)
        for _ in range(MAX_TRIGGERS)
    ]


# ---------------------------------------------------------------- per call kind


def max_context(family: Mapping[str, Any], role: str) -> dict[str, int]:
    """Worst-case request bytes (before the repair allowance) for every call kind on one variant, the largest over
    the official candidates of that kind."""
    variant = family["variants"][role]
    case = public_case(variant["public_packet"])
    sizes: dict[str, int] = {}
    coaches = [load_prompts(m) for m in official_manifests().values() if m.kind == "assistant"]
    subjects = [load_prompts(m) for m in official_manifests().values() if m.kind == "subject"]
    for call in ("card", "deep", "final"):
        view = PublicTrialView(
            call=call,
            case=case,
            released=_released(variant, MAX_TURNS - 1),
            transcript=_turns(MAX_TURNS),
            earlier=EarlierOutput(running_finding=_finding(MAX_TURNS - 1), flags=_flags(11), deep_update=_deep()),
            exchange=MAX_TURNS,
        )
        sizes[call] = max(
            _sized(p, call, build_coach_prompt(view, p, call, salt=SALT))
            for p in coaches
            if p.manifest.prompt is not None and call in p.manifest.prompt.assembly
        )
    packet = SubjectPacket.from_private_packet(variant["private_packet"], split=family["split"])
    state = SubjectTurnState(
        n=MAX_TURNS,
        transcript=_turns(MAX_TURNS - 1),
        question=fill(QUESTION_MAX_BYTES),
        released={r.record_id: 0 for r in _released(variant, 0)},
        opened_gates={g.id: 1 for g in packet.gates},
        first_disclosed={f.id: 1 for f in packet.facts},
    )
    sizes["subject"] = max(_sized(p, "subject", build_subject_prompt(packet, state, p, salt=SALT)) for p in subjects)
    referee = load_prompts(with_hash(referee_manifest()))
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
                question=fill(600) if mode == "assistant" else fill(QUESTION_MAX_BYTES),
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
