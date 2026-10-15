"""Coach Gym dataset shape (D-036): one example is the coach's input at one turn of a DEV-split trial and the
reference outcome the grader compares a card with.

- Input: the trial context a card call of turn n reads (`arena_core.turns.coach.coach_inputs`): the public
  packet, the records released so far and the transcript through turn n. The coach's own earlier output is left
  out on purpose, so an example means the same thing whichever coach ran the recorded trial.
- Reference: the variant's role (the case's ground truth), the turns through n the referee labeled `evasion`
  (R1, `sealed.judgments`), with a human calibration label (T-LAB) replacing R1's on the turns a human rated,
  and the turns where the two disagree (the playbook's input).
- Split: only `dev` trials ever become examples. The SQL that reads them filters on `split = 'dev'`
  (`scripts/coach_gym/data.py`); `build_examples` refuses any other split again, so a hidden trial cannot reach
  a dataset even through a wrong query.
- Partitions: a fixed dev holdout (whole families, `coachlab/holdout.json`, about a quarter of the dev families)
  that the optimizer and the playbook never see; the rest is split by example into GEPA's train pool and its
  validation set.
- Canaries (PROCTOR): a few deliberately unpassable train examples. Their reference names a turn the coach
  cannot see (n + 1) and carries a random token that only ever appears in the optimizer's feedback. A canary
  scored as passed means the grader or the harness is broken; the token turning up in a candidate's prompt or a
  lesson means the optimizer is memorizing references instead of learning to coach. Either blocks promotion.
"""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from arena_core.ids import canonical_sha256

Role = Literal["truthful", "deceptive"]
Partition = Literal["train", "val", "holdout"]
HOLDOUT_FILE = "coachlab/holdout.json"
CANARY_PREFIX = "CANARY-GYM-"
# One example in VAL_EVERY of the non-holdout pool is GEPA's validation set (chosen by example id, so stable).
VAL_EVERY = 4
_REVISION = re.compile(r"\.r[0-9]+$")


class HiddenSplitError(ValueError):
    """A trial that is not on the dev split reached the dataset builder; it is refused, never used."""


class Disagreement(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    turn: int
    referee: str
    human: str


class Reference(BaseModel):
    """What the grader compares a card with (never shown to the coach)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    role: Role
    evasion_turns: tuple[int, ...]  # turns <= n labeled evasion (human label first, else R1)
    labeled_turns: tuple[int, ...]  # turns <= n with any label
    disagreements: tuple[Disagreement, ...] = ()
    canary_token: str | None = None


class Example(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    example_id: str
    split: Literal["dev"]
    family: str
    case_id: str
    trial_id: str
    turn: int = Field(ge=1)
    partition: Partition
    context: dict[str, Any]
    reference: Reference

    @property
    def canary(self) -> bool:
        return self.reference.canary_token is not None


@dataclass(frozen=True)
class TrialRecord:
    """One dev trial as the dataset builder reads it (`scripts/coach_gym/data.py`)."""

    trial_id: str
    family_code: str
    split: str
    role: Role
    public_packet: Mapping[str, Any]
    released: Sequence[Mapping[str, Any]]  # record_id, title, content, after_exchanges
    transcript: Sequence[Mapping[str, Any]]  # turn_no, question, answer (answered turns only)
    referee_labels: Mapping[int, str] = field(default_factory=dict)
    human_labels: Mapping[int, str] = field(default_factory=dict)


def family_base(family_code: str) -> str:
    """`F01.r2` -> `F01`: a revision belongs to its family's partition."""
    return _REVISION.sub("", family_code)


def load_holdout(root: Path) -> frozenset[str]:
    raw = json.loads((root / HOLDOUT_FILE).read_text(encoding="utf-8"))
    families = raw.get("families") if isinstance(raw, dict) else None
    if not isinstance(families, list) or not families or not all(isinstance(f, str) for f in families):
        msg = f"{HOLDOUT_FILE}: needs a non-empty list of family codes under 'families'"
        raise ValueError(msg)
    return frozenset(families)


def partition_of(family: str, example_id: str, holdout: frozenset[str]) -> Partition:
    if family in holdout:
        return "holdout"
    return "val" if int(example_id[:8], 16) % VAL_EVERY == 0 else "train"


def _context(trial: TrialRecord, n: int) -> dict[str, Any]:
    """The trial context a card call of turn n reads (`coach_inputs`), without the coach's earlier output."""
    return {
        "public_packet": dict(trial.public_packet),
        "released_evidence": [
            {
                "record_id": r["record_id"],
                "title": r["title"],
                "content": r["content"],
                "after_exchanges": int(r["after_exchanges"]),
            }
            for r in trial.released
            if int(r["after_exchanges"]) <= n - 1
        ],
        "transcript": [
            {"turn_no": int(t["turn_no"]), "question": t["question"], "answer": t["answer"], "partial": False}
            for t in trial.transcript
            if int(t["turn_no"]) <= n
        ],
        "coaching": [],
    }


def _reference(trial: TrialRecord, n: int) -> Reference:
    labels = {**trial.referee_labels, **trial.human_labels}
    seen = {t: lab for t, lab in labels.items() if t <= n}
    disagreements = tuple(
        Disagreement(turn=t, referee=trial.referee_labels[t], human=h)
        for t, h in sorted(trial.human_labels.items())
        if t <= n and t in trial.referee_labels and trial.referee_labels[t] != h
    )
    return Reference(
        role=trial.role,
        evasion_turns=tuple(sorted(t for t, lab in seen.items() if lab == "evasion")),
        labeled_turns=tuple(sorted(seen)),
        disagreements=disagreements,
    )


def build_examples(trials: Iterable[TrialRecord], holdout: frozenset[str]) -> list[Example]:
    """One example per answered turn of every dev trial; identical inputs (a replay trial's copy of its corpus
    transcript) are kept once."""
    out: dict[str, Example] = {}
    for trial in trials:
        if trial.split != "dev":
            msg = f"trial {trial.trial_id} is on the {trial.split!r} split; only dev trials become examples"
            raise HiddenSplitError(msg)
        family = family_base(trial.family_code)
        for row in sorted(trial.transcript, key=lambda t: int(t["turn_no"])):
            n = int(row["turn_no"])
            context = _context(trial, n)
            reference = _reference(trial, n)
            example_id = canonical_sha256({"context": context, "reference": reference.model_dump(mode="json")})
            if example_id in out:
                continue
            out[example_id] = Example(
                example_id=example_id,
                split="dev",
                family=family,
                case_id=str(trial.public_packet.get("case_id", "")),
                trial_id=trial.trial_id,
                turn=n,
                partition=partition_of(family, example_id, holdout),
                context=context,
                reference=reference,
            )
    return sorted(out.values(), key=lambda e: (e.partition, e.family, e.trial_id, e.turn))


def with_canaries(examples: Sequence[Example], count: int = 2) -> list[Example]:
    """The examples plus `count` canaries drawn from the train pool (see the module docstring)."""
    pool = sorted((e for e in examples if e.partition == "train" and not e.canary), key=lambda e: e.example_id)
    canaries = []
    for source in pool[:count]:
        token = CANARY_PREFIX + secrets.token_hex(8)
        reference = Reference(
            role=source.reference.role,
            evasion_turns=(source.turn + 1,),
            labeled_turns=(source.turn + 1,),
            canary_token=token,
        )
        canaries.append(
            source.model_copy(
                update={"example_id": canonical_sha256([source.example_id, token]), "reference": reference}
            )
        )
    return [*examples, *canaries]


def partition(examples: Iterable[Example], name: Partition) -> list[Example]:
    return [e for e in examples if e.partition == name]


def dataset_sha256(examples: Sequence[Example], holdout: frozenset[str]) -> str:
    """The hash of every example in full (context, reference, partition) and of the holdout it was split by."""
    rows = [e.model_dump(mode="json") for e in sorted(examples, key=lambda e: e.example_id)]
    return canonical_sha256({"holdout": sorted(holdout), "examples": rows})


def _example_id(example: Example) -> str:
    return canonical_sha256({"context": example.context, "reference": example.reference.model_dump(mode="json")})


def check_partitions(examples: Sequence[Example], holdout: frozenset[str]) -> list[str]:
    """Every example where `build_examples` and `with_canaries` would have put it: a real example's id is the hash
    of its own input and reference, its partition follows its family and id; a canary sits in the train pool and
    names the unreachable turn. Returns the problems (example ids only)."""
    problems = []
    for e in examples:
        if e.canary:
            if e.partition != "train" or e.family in holdout or e.reference.evasion_turns != (e.turn + 1,):
                problems.append(f"canary {e.example_id[:16]} is not an unpassable train-pool example")
        elif _example_id(e) != e.example_id:
            problems.append(f"example {e.example_id[:16]} does not hash to its own id")
        elif e.partition != partition_of(e.family, e.example_id, holdout):
            where = f"is in the {e.partition} partition, not where its family puts it"
            problems.append(f"example {e.example_id[:16]} {where}")
    return problems


def write_jsonl(path: Path, examples: Sequence[Example]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(e.model_dump_json() + "\n" for e in examples), encoding="utf-8")


def read_jsonl(path: Path) -> list[Example]:
    """A dataset file; every line must parse as an `Example` (whose `split` can only be `dev`)."""
    return [Example.model_validate_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
