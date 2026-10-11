"""`answer()`: one structured subject call, the deterministic guard, `record_subject_turn` (S2 6.10, 6.9; S5 5.2).

The whole step is stateless end to end (AC-S1-31): every turn reconstructs `SubjectPacket` and
`SubjectTurnState` fresh from `subject.turn_context`'s row, never from anything held in the process between
calls, so gate and disclosure state always come from committed state and a restart between turns changes
nothing a caller can observe.

Division of labor with S5 5.2's orchestrator (`arena-api`, WP-13): `answer()` resolves the two S2 6.10 "G0"
outcomes itself (a schema failure surviving the one repair, or a provider block) into the same
`record_subject_turn` quarantine call a G1-G7 guard hit uses, because both are "no usable utterance" and S4
accepts them on one path. Every other agent-port failure (`BudgetRefused`, `KillSwitchOn`, `PolicyRefused`,
`InputTooLarge`, `ProviderFailed` and its `LedgerStalled`/`StepInProgress` subtypes) is *not* S2 6.10's G0: it
means no model call happened at all (or its outcome is unknown), and S5 5.2's `infra_failed` / `budget_truncated`
paths need `arena_public`'s `record_execution_failure`, a function `arena_subject` holds no grant on. `answer()`
raises `AnswerError` for these instead; the route maps it to an HTTP status, and the caller (not built until
WP-13) decides how to record the trial's execution state.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from pydantic import ValidationError

from arena_core.agents.manifests import CandidateManifest, ManifestMismatchError, load_prompts
from arena_core.agents.subject_prompts import SubjectPacket, SubjectTurnState, build_subject_prompt, subject_context
from arena_core.agents.views import TranscriptTurn
from arena_core.contracts.subject import SubjectTurn
from arena_core.db.subject import RecordResult, RecordSubjectTurn, TurnContext
from arena_core.providers.errors import (
    BudgetRefusedError,
    InputTooLargeError,
    KillSwitchOnError,
    LedgerStalledError,
    PolicyRefusedError,
    ProviderBlockedError,
    ProviderError,
    ProviderFailedError,
    StepInProgressError,
    StructuredOutputError,
)
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall, CallContext, Message
from arena_core.safety.guard import RecitalIndex, check_utterance, provider_blocked, schema_failure
from arena_core.spend.limits import CallType, ThinkingLevel, VertexModel

# S1 case families authored for this phase are development-split only, and nothing the text route renders
# depends on `split` beyond this literal check (it gates Live voice, WP-22, which never calls `answer()`).
# `subject.turn_context` does not surface the variant's family split; before a hidden-split trial can reach
# this route (WP-16/17), either the SQL view grows that field or arena-subject looks it up itself.
_TEXT_ROUTE_SPLIT: Literal["dev"] = "dev"

ContextReader = Callable[[UUID, UUID], Awaitable[TurnContext]]
TurnRecorder = Callable[[RecordSubjectTurn], Awaitable[RecordResult]]

# S5 5.5's route table has no response contract for `/internal/answer` yet, so this status mapping is WP-12's
# own choice pending WP-13's `subject_client.py`: a flag for the owner, not a blocker. Every one of these means
# no model call happened at all (or its outcome is unknown) - never S2 6.10's G0.
_INFRA_STATUS: tuple[tuple[type[ProviderError], str, int], ...] = (
    (BudgetRefusedError, "budget_refused", 503),
    (KillSwitchOnError, "kill_switch_on", 503),
    (StepInProgressError, "step_in_progress", 409),
    (LedgerStalledError, "ledger_stalled", 503),
    (PolicyRefusedError, "policy_refused", 500),
    (InputTooLargeError, "input_over_limit", 500),
)

# The S2 6.9 heading lines of `prompts/subject/user.turn.v1.txt`: the parts of the per-turn message that are
# never case data, so they belong in G6's reference set M regardless of which packet is rendered (6.9: "the
# ledger heading lines"). Case-specific text is excluded by subtracting it from the recital in
# `build_recital_index`, never by trimming this list.
LEDGER_HEADING_LINES: tuple[str, ...] = (
    "CASE LEDGER (private; read it again before every answer).",
    "FACTS",
    "UNCERTAINTY",
    "(An uncertainty entry describes the limits of what you know; it never permits disclosing a fact you may "
    "not yet speak about.)",
    "GATES",
    "WHAT YOU HAVE SAID SO FAR",
    "TRANSCRIPT SO FAR",
    "LATEST QUESTION",
    "Answer the latest question in character, following your rules, then fill the tag. Return only the JSON object.",
)


class AnswerError(Exception):
    """A terminal failure `answer()` cannot resolve into a `record_subject_turn` call. `code` and `status_code`
    are for the route to report; the caller (arena-api) owns deciding the trial's resulting execution state."""

    def __init__(self, code: str, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class AnswerOutcome:
    outcome: Literal["recorded", "quarantined"]
    turn_no: int
    transcript_version: int | None


def _strings(value: object) -> Iterator[str]:
    """Every string leaf of a JSON-like value (S2 6.9 G6: "the case's own public text or private fact text")."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def build_recital_index(
    system_instruction: str, private_packet: Mapping[str, Any], public_packet: Mapping[str, Any]
) -> RecitalIndex:
    """S2 6.9 G6's reference set M: the rendered system instruction plus the ledger heading lines, minus every
    8-gram the case's own public or private text also carries (in-world speech is never a recital hit). The raw
    authored packets are used for the subtraction, not the trimmed `SubjectPacket` (SG1-04: more case text here
    only narrows M, it never widens it)."""
    reference = [system_instruction, "\n".join(LEDGER_HEADING_LINES)]
    case_text = [*_strings(private_packet), *_strings(public_packet)]
    return RecitalIndex.build(reference, case_text)


def _released_map(released_evidence: list[dict[str, Any]]) -> dict[str, int]:
    """`SubjectTurnState.released`: `subject.turn_context` returns the trial's live released set, not a
    history, so every currently released `rec-NN` counts as released as of turn 0 - exact for every n >= 1
    (C-20: a release is permanent; nothing here ever needs to look "unreleased" again)."""
    return {str(r["record_id"]): 0 for r in released_evidence if str(r["record_id"]).startswith("rec-")}


def _opened_gates(disclosure_state: Mapping[str, Any]) -> dict[str, int]:
    return {str(g["gate_id"]): int(g["turn"]) for g in disclosure_state.get("gates_opened", [])}


def _first_disclosed(disclosure_state: Mapping[str, Any]) -> dict[str, int]:
    return {str(d["fact_id"]): int(d["first_turn"]) for d in disclosure_state.get("disclosed", [])}


def _state_from_context(ctx: TurnContext) -> SubjectTurnState:
    """`SubjectTurnState` for turn `ctx.turn_no`: turns 1..n-1 from the stored transcript (all answered), and
    the open turn n's own question (S2 6.7). `subject.turn_context` guarantees exactly this shape (S4
    `record_subject_turn`'s own precondition), so a mismatch here is a protocol error, not a case defect."""
    rows = sorted(ctx.transcript, key=lambda r: int(r["turn_no"]))
    if not rows or int(rows[-1]["turn_no"]) != ctx.turn_no or rows[-1].get("answer") is not None:
        msg = f"turn_context: no open question at turn {ctx.turn_no}"
        raise AnswerError("context_malformed", 500, msg)
    earlier, current = rows[:-1], rows[-1]
    if [int(r["turn_no"]) for r in earlier] != list(range(1, ctx.turn_no)):
        msg = f"turn_context: transcript gap before turn {ctx.turn_no}"
        raise AnswerError("context_malformed", 500, msg)
    try:
        return SubjectTurnState(
            n=ctx.turn_no,
            transcript=[
                TranscriptTurn(turn_no=int(r["turn_no"]), question=r["question"], answer=r["answer"]) for r in earlier
            ],
            question=current["question"],
            released=_released_map(ctx.released_evidence),
            opened_gates=_opened_gates(ctx.disclosure_state),
            first_disclosed=_first_disclosed(ctx.disclosure_state),
        )
    except ValidationError as exc:
        raise AnswerError("context_malformed", 500, str(exc)) from exc


def _infra_error(exc: ProviderError) -> AnswerError:
    for exc_type, code, status in _INFRA_STATUS:
        if isinstance(exc, exc_type):
            return AnswerError(code, status, str(exc))
    return AnswerError("provider_failed", 503, str(exc))  # ProviderFailedError and any other subtype


async def _finish(record: TurnRecorder, req: RecordSubjectTurn) -> AnswerOutcome:
    stored = await record(req)
    return AnswerOutcome(outcome=stored.outcome, turn_no=stored.turn_no, transcript_version=stored.transcript_version)


async def answer(
    trial_id: UUID,
    work_item_id: UUID,
    *,
    get_context: ContextReader,
    record: TurnRecorder,
    port: AgentPort,
) -> AnswerOutcome:
    """S5 5.2 step 4: `subject.turn_context` -> one structured call -> the guard -> `record_subject_turn`."""
    ctx = await get_context(trial_id, work_item_id)
    try:
        manifest = CandidateManifest.model_validate(ctx.subject_manifest)
        prompts = load_prompts(manifest)
    except (ValidationError, ManifestMismatchError) as exc:
        raise AnswerError("manifest_mismatch", 500, str(exc)) from exc

    packet = SubjectPacket.from_private_packet(ctx.private_packet, split=_TEXT_ROUTE_SPLIT)
    state = _state_from_context(ctx)
    prompt = build_subject_prompt(packet, state, prompts, salt=None)
    limit = manifest.limits["subject"]
    call = AgentCall(
        model=VertexModel(limit.model_id),
        thinking=ThinkingLevel(limit.thinking_level.lower()),
        system=prompt.system_instruction,
        messages=(Message("user", prompt.user_message),),
        schema=SubjectTurn,
        context=CallContext(
            call_type=CallType.SUBJECT,
            purpose="subject.answer",
            # The work item is this call's whole identity: one subject_answer item names exactly one subject
            # turn (S5 5.1), so its id is a stable, unique step key across any retry of this route call.
            step_key=str(work_item_id),
            work_item_id=work_item_id,
            trial_id=trial_id,
            turn_no=state.n,
            split=packet.split,
            data_class="subject_private",
            # arena-subject is the sole owner of this work item's model-call step: a reservation already open
            # under this step key can only be a previous attempt at this same request that never finished
            # (S5 4.10).
            recover=True,
        ),
        timeout_s=limit.attempt_timeout_ms / 1000,
        deadline_s=limit.deadline_ms / 1000,
        validation_context=subject_context(packet, state),
        salt=prompt.salt,
    )

    try:
        result = await port.run(call)
    # silent-ok: S2 6.10's G0_schema carries no detail beyond its rule tag; the quarantine itself is the record.
    except StructuredOutputError:
        g0 = schema_failure().as_record()
        req = RecordSubjectTurn(trial_id=trial_id, work_item_id=work_item_id, utterance="", tag=None, guard_result=g0)
        return await _finish(record, req)
    # silent-ok: same as above (S2 6.10's G0_blocked carries no further detail either).
    except ProviderBlockedError:
        g0 = provider_blocked().as_record()
        req = RecordSubjectTurn(trial_id=trial_id, work_item_id=work_item_id, utterance="", tag=None, guard_result=g0)
        return await _finish(record, req)
    except (BudgetRefusedError, KillSwitchOnError, PolicyRefusedError, InputTooLargeError, ProviderFailedError) as exc:
        raise _infra_error(exc) from exc

    recital = build_recital_index(prompt.system_instruction, ctx.private_packet, ctx.public_packet)
    guard_result = check_utterance(result.value.utterance, recital)
    req = RecordSubjectTurn(
        trial_id=trial_id,
        work_item_id=work_item_id,
        utterance=result.value.utterance,
        tag=result.value.tag.model_dump(mode="json"),
        guard_result=guard_result.as_record(),
    )
    return await _finish(record, req)
