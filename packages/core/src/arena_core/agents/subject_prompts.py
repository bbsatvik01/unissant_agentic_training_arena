"""Subject prompt builders: text turn and Live voice instruction (S2 6, 9.3; AT-SUBJ-1..4, AT-VOICE-1, 2, 4).

Imported by `arena_subject` and `arena_referee` only (`tools/check_roles.py` refuses it in `arena_api` and
`arena_tournament`).

- `SubjectPacket` is S2 6.2's rendering contract, built from an authored private packet (S1 private-packet schema;
  `from_private_packet` keeps only the fields S2 renders, so the objective, unknown facts, forbidden assertions,
  evidence levels and canary never reach a subject prompt).
- `gate_status` is the C-20 rule (S1 6.4): LOCKED while none of a gate's `precondition_records` is released
  (initial documents count as released from the start), CLOSED once one is, OPEN once a validated tag opened it;
  gates are monotonic.
- `build_subject_prompt` renders the system instruction (base, role, policy and style blocks; 6.3-6.6) and the
  per-turn ledger message (6.7) for one turn; `subject_context` gives the V2-V4 validation context (6.8) for the
  same turn, so the gate a tag may open is exactly a gate the ledger showed CLOSED.
- `build_live_instruction` renders `live.v1.txt` from the same packet and blocks (9.3), for development cases only,
  with gate status from the session's releases; `live_setup` is the session configuration of 9.2.

No role word is rendered: the role selects the role block and nothing else (6.2, AT-SUBJ-1).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.agents.coach_prompts import Prompt
from arena_core.agents.manifests import (
    POLICY,
    ROLE_D,
    ROLE_T,
    STYLE,
    SUBJECT_LIVE,
    SUBJECT_SYSTEM,
    ManifestMismatchError,
    PromptSet,
)
from arena_core.agents.render import transcript
from arena_core.agents.templates import TemplateError, join_blocks, render, require
from arena_core.agents.untrusted import check_salt, clean, new_salt
from arena_core.agents.views import TranscriptTurn
from arena_core.contracts.common import Contract, Exchanges, FactId, GateId, TurnNo, UncertaintyId, turn_id
from arena_core.contracts.subject import SubjectContext

FactClass = Literal["FREE", "HOLD", "CORE", "PRIVATE"]
Permitted = Literal["omission", "deflection", "minimization"]
PERMITTED_ORDER: tuple[str, ...] = ("omission", "deflection", "minimization")
BASE_BEHAVIORS = frozenset({"responsive", "explicit_uncertainty", "legitimate_non_disclosure"})
STYLE_AXES = ("verbosity", "fluency", "affect", "register", "language")
GateStatus = Literal["LOCKED", "CLOSED", "OPEN"]

Text = Annotated[str, StringConstraints(min_length=1, max_length=400)]
SourceId = Annotated[str, StringConstraints(pattern=r"^(doc|rec)-[0-9]{2}$")]


class Persona(Contract):
    name: Text
    position: Text
    organization: Text
    background: Text


class LedgerFact(Contract):
    id: FactId
    fact_class: Annotated[FactClass, Field(alias="class")]
    text: Text
    gate_id: GateId | None = None

    @model_validator(mode="after")
    def _gate(self) -> Self:
        if (self.fact_class == "HOLD") != (self.gate_id is not None):
            msg = "gate_id: set exactly for HOLD facts"
            raise ValueError(msg)
        return self


class UncertaintyEntry(Contract):
    id: UncertaintyId
    fact_id: FactId
    text: Text
    answer_form: Literal["range", "unsure"]
    range_text: Text | None = None


class Gate(Contract):
    id: GateId
    condition: Text
    opens: Annotated[list[FactId], Field(min_length=1, max_length=4)]
    precondition_records: Annotated[list[SourceId], Field(min_length=1, max_length=10)]


class Style(Contract):
    """S1's style axes (SCN-3). `register` is held as `register_` (a Pydantic model already has a `register`)."""

    verbosity: Literal["terse", "moderate", "expansive"]
    fluency: Literal["fluent", "disfluent"]
    affect: Literal["calm", "anxious"]
    register_: Annotated[Literal["formal", "informal"], Field(alias="register")]
    language: Literal["native", "second_language"]

    def level(self, axis: str) -> str:
        """The level on one axis, by S1's axis name."""
        levels: dict[str, str] = {"verbosity": self.verbosity, "fluency": self.fluency, "affect": self.affect}
        levels |= {"register": self.register_, "language": self.language}
        return levels[axis]


class SubjectPacket(Contract):
    """S2 6.2 `SubjectPacket`. `split` is the family's split: the Live builder serves development cases only."""

    case_id: Annotated[str, StringConstraints(pattern=r"^C-[0-9A-HJKMNP-TV-Z]{8}$")]
    split: Literal["dev", "hidden"]
    role: Literal["truthful", "deceptive"]
    persona: Persona
    matter: Annotated[str, StringConstraints(min_length=1, max_length=600)]
    facts: Annotated[list[LedgerFact], Field(min_length=1, max_length=30)]
    uncertainty: Annotated[list[UncertaintyEntry], Field(max_length=4)]
    gates: Annotated[list[Gate], Field(max_length=6)]
    permitted_behaviors: Annotated[list[Permitted], Field(max_length=3)]
    style: Style

    @model_validator(mode="after")
    def _rules(self) -> Self:
        errors: list[str] = []
        facts = {f.id: f for f in self.facts}
        gates = {g.id for g in self.gates}
        if len(facts) != len(self.facts):
            errors.append("facts: duplicate ID")
        classes = {f.fact_class for f in self.facts}
        if self.role == "truthful" and (classes - {"FREE", "PRIVATE"} or self.gates or self.permitted_behaviors):
            errors.append("a truthful packet has FREE and PRIVATE facts only, no gates and no permitted behaviors")
        if self.role == "deceptive" and ("CORE" not in classes or not self.permitted_behaviors):
            errors.append("a deceptive packet needs a CORE fact and at least one permitted behavior")
        errors += [
            f"facts.{f.id}.gate_id: {f.gate_id} is no gate" for f in self.facts if f.gate_id and f.gate_id not in gates
        ]
        errors += [
            f"uncertainty.{u.id}.fact_id: {u.fact_id} is no fact" for u in self.uncertainty if u.fact_id not in facts
        ]
        errors += [
            f"uncertainty.{u.id}.range_text: required for a range"
            for u in self.uncertainty
            if u.answer_form == "range" and u.range_text is None
        ]
        errors += [
            f"gates.{g.id}.opens: {o} is not a HOLD fact"
            for g in self.gates
            for o in g.opens
            if o not in facts or facts[o].fact_class != "HOLD"
        ]
        if errors:
            raise ValueError("; ".join(errors))
        return self

    @classmethod
    def from_private_packet(cls, packet: Mapping[str, Any], split: str) -> SubjectPacket:
        """The S2 6.2 fields of an authored private packet (S1 schema v1.0)."""
        persona = packet["persona"]
        return cls.model_validate(
            {
                "case_id": packet["case_id"],
                "split": split,
                "role": packet["role"],
                "persona": {k: persona[k] for k in ("name", "position", "organization", "background")},
                "matter": packet["matter"],
                "facts": [{k: f[k] for k in ("id", "class", "text", "gate_id") if k in f} for f in packet["facts"]],
                "uncertainty": [
                    {k: u[k] for k in ("id", "fact_id", "text", "answer_form", "range_text") if k in u}
                    for u in packet["uncertainty"]
                ],
                "gates": [
                    {k: g[k] for k in ("id", "condition", "opens", "precondition_records")} for g in packet["gates"]
                ],
                "permitted_behaviors": list(packet["permitted_behaviors"]),
                "style": dict(packet["style"]),
            },
            by_alias=True,
        )

    def allowed_behaviors(self) -> frozenset[str]:
        """Role block T or D after `permitted_behaviors` filtering (S2 6.4; V4)."""
        return BASE_BEHAVIORS | frozenset(self.permitted_behaviors)


class SubjectTurnState(Contract):
    """Code-held trial state for turn `n` (S2 6.7): earlier exchanges, the latest question, released records
    with the exchange they were released after, and what earlier validated tags opened and disclosed."""

    n: TurnNo
    transcript: Annotated[list[TranscriptTurn], Field(max_length=11)]
    question: Annotated[str, StringConstraints(min_length=1, max_length=600)]
    released: Annotated[
        dict[Annotated[str, StringConstraints(pattern=r"^rec-[0-9]{2}$")], Exchanges], Field(max_length=6)
    ]
    opened_gates: Annotated[dict[GateId, TurnNo], Field(max_length=6)]
    first_disclosed: Annotated[dict[FactId, TurnNo], Field(max_length=30)]

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if [t.turn_no for t in self.transcript] != list(range(1, self.n)):
            msg = f"transcript: must hold turns 1..{self.n - 1}"
            raise ValueError(msg)
        late = sorted(k for k, v in [*self.opened_gates.items(), *self.first_disclosed.items()] if v >= self.n)
        if late:
            msg = f"{late}: opened or disclosed at or after turn {self.n}"
            raise ValueError(msg)
        return self


def _is_released(record: str, released: frozenset[str]) -> bool:
    return record.startswith("doc-") or record in released


def gate_status(gate: Gate, released: frozenset[str], opened_at: int | None = None) -> GateStatus:
    """C-20: LOCKED until one precondition record is released (initial documents are), CLOSED after, OPEN once a
    validated tag opened it."""
    if opened_at is not None:
        return "OPEN"
    return "CLOSED" if any(_is_released(r, released) for r in gate.precondition_records) else "LOCKED"


def released_by(state: SubjectTurnState) -> frozenset[str]:
    """Records released before question n (`released_after <= n - 1`)."""
    return frozenset(r for r, after in state.released.items() if after <= state.n - 1)


# ---------------------------------------------------------------- blocks (S2 6.4-6.6)


ALLOWED_PREFIX = "- Allowed behaviors: "


def role_block(packet: SubjectPacket, prompts: PromptSet) -> str:
    """Role block T, or role block D with only the packet's permitted behaviors listed (S2 6.4)."""
    if packet.role == "truthful":
        return prompts.text(ROLE_T)
    permitted = [b for b in PERMITTED_ORDER if b in packet.permitted_behaviors]
    text = render(prompts.text(ROLE_D), {"permitted_behaviors_rendered": ", ".join(permitted)})
    dropped = set(PERMITTED_ORDER) - set(permitted)
    out = []
    for line in text.split("\n"):
        if line.startswith("  ") and line.strip().split(":", 1)[0] in dropped:
            continue
        if line.startswith(ALLOWED_PREFIX):
            items = line.removeprefix(ALLOWED_PREFIX).removesuffix(".").split(", ")
            out.append(ALLOWED_PREFIX + ", ".join(i for i in items if i.split(" ", 1)[0] not in dropped) + ".")
        else:
            out.append(line)
    return "\n".join(out)


def policy_block(packet: SubjectPacket, prompts: PromptSet) -> str:
    """S2 6.5: the candidate's policy block in the deceptive role; empty in the truthful role."""
    if packet.role == "truthful":
        return ""
    policy = prompts.manifest.subject_policy
    if policy is None:
        msg = f"manifest {prompts.manifest.candidate_id} is not a subject"
        raise TemplateError(msg)
    return prompts.text(POLICY[policy.policy])


def style_block(style: Style, prompts: PromptSet) -> str:
    """S2 6.6: a heading, one line per axis, the closing line."""
    table: dict[str, str] = {}
    for line in prompts.text(STYLE).splitlines():
        key, _, value = line.partition(": ")
        table[key] = value
    lines = [table["heading"]]
    lines += [f"- {table[f'{axis} {style.level(axis)}']}" for axis in STYLE_AXES]
    lines.append(f"- {table['closing']}")
    return "\n".join(lines)


def behavior_blocks(packet: SubjectPacket, prompts: PromptSet) -> str:
    return join_blocks([role_block(packet, prompts), policy_block(packet, prompts), style_block(packet.style, prompts)])


def _persona(packet: SubjectPacket) -> dict[str, str]:
    p = packet.persona
    return {
        "persona.name": clean(p.name),
        "persona.position": clean(p.position),
        "persona.organization": clean(p.organization),
    }


# ---------------------------------------------------------------- ledger (S2 6.7)


@dataclass(frozen=True)
class LedgerView:
    """How a ledger is rendered: gate status by gate ID (`None` omits the status, as for the referee), and
    whether each gate line ends with the records it is openable after (referee only, S2 7.2)."""

    status: Mapping[str, tuple[GateStatus, int | None]] | None
    openable_after: bool = False
    # Live (S2 9.3) and the referee (7.2) never show a gate OPEN (the Live model tracks openings itself; the referee
    # decides them), so a HOLD fact's range must be stated with its condition rather than withheld for good.
    tracks_openings: bool = False


def _fact_line(fact: LedgerFact) -> str:
    line = f"{fact.id} {fact.fact_class.ljust(7)} {clean(fact.text)}"
    return f"{line}   (opened by {fact.gate_id})" if fact.gate_id else line


def _uncertainty_line(entry: UncertaintyEntry, packet: SubjectPacket, view: LedgerView) -> str:
    """SG1-24: the suffix depends on the class of the fact the entry qualifies and, for HOLD, its gate's status."""
    fact = next(f for f in packet.facts if f.id == entry.fact_id)
    # S2 6.7: the range is said only for answer_form `range`; an `unsure` entry's optional range_text is not.
    say = f' If asked, say: "{clean(entry.range_text)}"' if entry.answer_form == "range" and entry.range_text else ""
    if fact.fact_class == "CORE":
        suffix = (
            f" Applies only to how you describe {fact.id} if you are ever shown it;"
            f" it never lets you confirm {fact.id}."
        )
    elif fact.fact_class == "HOLD":
        open_now = view.status is not None and view.status.get(fact.gate_id or "", ("LOCKED", None))[0] == "OPEN"
        gate = f" Applies only after {fact.gate_id} opens; until then it does not let you speak about {fact.id}."
        if open_now:
            suffix = say
        elif view.tracks_openings and say:
            suffix = f'{gate} Once {fact.gate_id} is open, if asked, say: "{clean(entry.range_text or "")}"'
        else:
            suffix = gate
    else:
        suffix = say
    return f"{entry.id} on {entry.fact_id} {clean(entry.text)}{suffix}"


def _gate_line(gate: Gate, view: LedgerView) -> str:
    line = f"{gate.id} condition: {clean(gate.condition)} | opens: {', '.join(gate.opens)}"
    if view.status is not None:
        status, since = view.status[gate.id]
        line += f" | status: {status}" + (f" since {turn_id(since)}" if since is not None else "")
    if view.openable_after:
        line += f" | openable after: {', '.join(gate.precondition_records)}"
    return line


def ledger(packet: SubjectPacket, view: LedgerView) -> str:
    """The FACTS, UNCERTAINTY and GATES sections (S2 6.7), shared by the text turn, the Live instruction and the
    referee's ledger block (S2 7.2)."""
    uncertainty = [_uncertainty_line(u, packet, view) for u in packet.uncertainty]
    gates = [_gate_line(g, view) for g in packet.gates]
    return "\n".join(
        [
            "FACTS",
            *[_fact_line(f) for f in packet.facts],
            "",
            "UNCERTAINTY",
            *(uncertainty or ["none"]),
            "(An uncertainty entry describes the limits of what you know; it never permits disclosing a fact you may"
            " not yet speak about.)",
            "",
            "GATES",
            *(gates or ["none"]),
        ]
    )


def turn_status(packet: SubjectPacket, state: SubjectTurnState) -> dict[str, tuple[GateStatus, int | None]]:
    released = released_by(state)
    out: dict[str, tuple[GateStatus, int | None]] = {}
    for g in packet.gates:
        opened = state.opened_gates.get(g.id)
        out[g.id] = (gate_status(g, released, opened), opened)
    return out


def _check(packet: SubjectPacket, prompts: PromptSet, key: Literal["subject", "live"]) -> None:
    """The input is a `SubjectPacket`, and the manifest's assembly for `key` is exactly the composition this
    builder renders (S2 3.1: the hashed assembly describes the instruction; any other assembly is refused rather
    than silently rendered the standard way)."""
    require(packet, SubjectPacket, "subject prompt builder (S2 6.2)")
    manifest = prompts.manifest
    if manifest.kind != "subject" or manifest.subject_policy is None or manifest.prompt is None:
        msg = f"manifest {manifest.candidate_id} is not a subject"
        raise TemplateError(msg)
    base = SUBJECT_SYSTEM if key == "subject" else SUBJECT_LIVE
    expected = [base, ROLE_T, ROLE_D, POLICY[manifest.subject_policy.policy], STYLE]
    if manifest.prompt.assembly.get(key) != expected:
        msg = f"manifest {manifest.candidate_id}: {key} assembly is not {expected}"
        raise ManifestMismatchError(msg)


def build_subject_prompt(
    packet: SubjectPacket, state: SubjectTurnState, prompts: PromptSet, salt: str | None = None
) -> Prompt:
    """The subject's request for turn `state.n` (S2 6.3-6.7)."""
    _check(packet, prompts, "subject")
    salt = check_salt(salt or new_salt())
    system = render(
        prompts.text(SUBJECT_SYSTEM), {**_persona(packet), "behavior_blocks": behavior_blocks(packet, prompts)}
    )
    said = [
        f"{fid} first said at {turn_id(t)}"
        for fid, t in sorted(state.first_disclosed.items(), key=lambda x: (x[1], x[0]))
    ]
    user = render(
        prompts.user_template("user.turn.v1.txt"),
        {
            **_persona(packet),
            "persona.background": clean(packet.persona.background),
            "n": str(state.n),
            "turn": turn_id(state.n),
            "matter": clean(packet.matter),
            "ledger": ledger(packet, LedgerView(status=turn_status(packet, state))),
            "said_so_far": "\n".join(said) or "nothing yet",
            "salt": salt,
            "transcript": transcript(state.transcript, answer_label="You"),
            "question": clean(state.question),
        },
    )
    return Prompt(system_instruction=system, user_message=user, salt=salt)


def subject_context(packet: SubjectPacket, state: SubjectTurnState) -> SubjectContext:
    """The V2-V4 validation context for turn n: the tag may open only a gate the ledger showed CLOSED (C-20)."""
    status = turn_status(packet, state)
    return SubjectContext(
        fact_ids=frozenset(f.id for f in packet.facts),
        uncertainty_ids=frozenset(u.id for u in packet.uncertainty),
        closed_gate_ids=frozenset(g for g, (s, _) in status.items() if s == "CLOSED"),
        allowed_behaviors=packet.allowed_behaviors(),
    )


# ---------------------------------------------------------------- Live voice (S2 9)


class LiveNotAllowedError(Exception):
    """Live voice serves development cases only (D-006, S2 9; AT-VOICE-2)."""


def build_live_instruction(packet: SubjectPacket, released: frozenset[str], prompts: PromptSet) -> str:
    """`live.v1.txt` for a development case, with gate status from the session's releases at render time:
    LOCKED or CLOSED, never OPEN (the model tracks openings itself, S2 9.3)."""
    _check(packet, prompts, "live")
    if packet.split != "dev":
        msg = f"case {packet.case_id} is not a development case; Live voice serves development cases only"
        raise LiveNotAllowedError(msg)
    status: dict[str, tuple[GateStatus, int | None]] = {g.id: (gate_status(g, released), None) for g in packet.gates}
    return render(
        prompts.text(SUBJECT_LIVE),
        {
            **_persona(packet),
            "behavior_blocks": behavior_blocks(packet, prompts),
            "ledger": ledger(packet, LedgerView(status, tracks_openings=True)),
        },
    )


def live_setup(packet: SubjectPacket, released: frozenset[str], prompts: PromptSet, voice_id: str) -> dict[str, Any]:
    """S2 9.2 session configuration: audio out, both transcriptions on, no tools, proactivity and affective
    dialog off, the public packet's voice. Plain data; only `arena_core.providers.vertex` builds SDK types."""
    limit = prompts.manifest.limits.get("subject")
    if limit is None:
        msg = f"manifest {prompts.manifest.candidate_id} has no subject limits"
        raise TemplateError(msg)
    return {
        "system_instruction": build_live_instruction(packet, released, prompts),
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "tools": [],
        "proactivity": {"proactive_audio": False},
        "enable_affective_dialog": False,
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": clean(voice_id)}}},
    }
