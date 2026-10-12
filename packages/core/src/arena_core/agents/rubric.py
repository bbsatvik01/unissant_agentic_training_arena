"""Spec S3's `rubric.v1` as S2 7.4 fixes its form, and the one way the referee reads it: from the verified bytes of
the file its manifest hashes (`manifest_rubric`), so the rubric rendered into J4's prompt is the one the manifest
hash certifies (S2 3.2, 7.4). Spec S3 owns the content; `canonical_rubric` builds it from S3's own published text
and `rubric_text` is its committed form -- `prompts/referee/rubric.v1.json` (`manifests.referee_manifest`'s
default `rubric=`, S2 3.4/7.4) -- so a manifest built with no override freezes on the real rubric, never a
placeholder. `referee_manifest(rubric=None)` still builds the pre-publication shape a few tests exercise, where
J4 runs on a development placeholder and the manifest cannot freeze (`manifests.check_referee_freeze`).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.contracts.common import ByteLimit, Contract, wire_bytes
from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.contracts.rendered import clean, rendered_overruns
from arena_core.ids import read_json_text
from arena_core.scoring.rubric import (
    CHECK_APPLICABILITY,
    CHECK_NAME,
    CHECK_PASSES_WHEN,
    CHECKS,
    DIMENSION_ANCHORS,
    DIMENSION_NAMES,
)

if TYPE_CHECKING:
    from arena_core.agents.manifests import PromptSet

RUBRIC_FILE = "rubric.v1.json"
MAX_SUBCHECKS = 30  # S2 7.4: at most 30 sub-checks in total
MAX_SUBCHECK_TEXT_BYTES = 400  # RubricSubcheck.text's ByteLimit below (D11)


class RubricSubcheck(Contract):
    id: Annotated[str, StringConstraints(pattern=r"^[1-5][a-e]$")]
    # Rendered into J4's prompt: at most 400 bytes as rendered (D11), so the maximal-context check bounds it.
    text: Annotated[str, StringConstraints(min_length=1, max_length=400), ByteLimit(400)]
    na_when: Annotated[str, StringConstraints(min_length=1, max_length=400)] | None


class RubricDimension(Contract):
    dim_id: Literal["D1", "D2", "D3", "D4", "D5"]
    name: Annotated[str, StringConstraints(min_length=1, max_length=80), ByteLimit(80)]
    anchors_0_to_4: Annotated[list[str], Field(min_length=5, max_length=5)]
    subchecks: Annotated[list[RubricSubcheck], Field(min_length=2, max_length=8)]


class Rubric(Contract):
    """Spec S3's `rubric.v1` as S2 7.4 fixes its form."""

    rubric_version: Literal["rubric.v1"]
    dimensions: Annotated[list[RubricDimension], Field(min_length=5, max_length=5)]

    @model_validator(mode="after")
    def _ids(self) -> Self:
        overruns = rendered_overruns(self)
        if overruns:
            raise ValueError("; ".join(overruns))
        ids = [s.id for d in self.dimensions for s in d.subchecks]
        if len(ids) > MAX_SUBCHECKS or len(set(ids)) != len(ids):
            msg = f"dimensions: at most {MAX_SUBCHECKS} distinct sub-check IDs"
            raise ValueError(msg)
        if [d.dim_id for d in self.dimensions] != ["D1", "D2", "D3", "D4", "D5"]:
            msg = "dimensions: D1 to D5, in order (EVL-7)"
            raise ValueError(msg)
        wrong = sorted(s.id for d in self.dimensions for s in d.subchecks if s.id[0] != d.dim_id[1])
        missing = sorted(PER_QUESTION_SUBCHECKS - set(ids))
        if wrong or missing:
            msg = f"dimensions: sub-checks {wrong} under another dimension, per-question sub-checks {missing} missing"
            raise ValueError(msg)
        return self


def rubric_path(files: list[str]) -> str | None:
    """The manifest file that is `rubric.v1`, if any."""
    found = [f for f in files if f.rsplit("/", 1)[-1] == RUBRIC_FILE]
    return found[0] if found else None


def parse_rubric(text: str) -> Rubric:
    """A `rubric.v1` file's text, read strictly (no duplicate keys, no non-finite numbers)."""
    return Rubric.model_validate(read_json_text(text))


def manifest_rubric(prompts: PromptSet) -> Rubric | None:
    """The rubric the manifest hashes, parsed from the verified text; None when the manifest names none."""
    prompt = prompts.manifest.prompt
    path = rubric_path([f.path for f in prompt.files]) if prompt else None
    return parse_rubric(prompts.text(path)) if path else None


def _subcheck_text(check_id: str) -> tuple[str, str | None]:
    """One check's rendered `text` and `na_when` (S2 7.3, 7.4), composed from `arena_core.scoring.rubric`'s
    canonical S3 2.3-2.7 text: the check's name, then (when it fits the 400-byte prompt cap, D11) its verbatim
    "Applicable" cell, then its verbatim "Passes when" cell. The frozen referee prompt (`prompts/referee/
    assistant.v1.txt`) tells the model to answer a sub-check `na` "only where the sub-check text says when it
    does not apply", so the applicability clause is included whenever it fits -- every "N/A unless" check
    except 3e, whose clause alone (237 characters) leaves no room beside its "Passes when" text. That omission
    is harmless: every "N/A unless" check but 3d already has its applicability pre-filtered by a code-built
    trigger the prompt lists separately (`arena_core.agents.triggers.derive_triggers`; `arena_referee.scoring.
    _applicable` refuses the model's own `na` whenever code already found one), so 3d is the only check whose
    own `na` answer is load-bearing without a trigger list, and its clause (one short sentence) always fits."""
    name = CHECK_NAME[check_id]
    applicability = CHECK_APPLICABILITY.get(check_id)
    passes_when = CHECK_PASSES_WHEN[check_id]
    na_when = applicability
    with_applicability = f"{name}. {applicability}. {passes_when}." if applicability else f"{name}. {passes_when}."
    text = with_applicability
    if wire_bytes(clean(text)) > MAX_SUBCHECK_TEXT_BYTES:
        text = f"{name}. {passes_when}."
    if wire_bytes(clean(text)) > MAX_SUBCHECK_TEXT_BYTES:
        msg = f"{check_id}: rubric.v1 text exceeds {MAX_SUBCHECK_TEXT_BYTES} rendered bytes even without 'Applicable'"
        raise ValueError(msg)
    return text, na_when


def canonical_rubric() -> Rubric:
    """rubric.v1 (S2 7.4): the 22 checks and five dimensions' anchors exactly as spec S3 2.3-2.7 defines them,
    read from `arena_core.scoring.rubric`'s canonical text -- the one source that module's rubric-hash lineage
    (S3 2.11) and this builder both read, so the published spec table and the rendered rubric cannot drift (a
    parser test over the spec's own markdown asserts this, `test_rubric_spec_text.py`). Replaces the
    development placeholder (`services/referee.scoring.default_dev_rubric`'s former `"placeholder text of
    {id}"`) now that S3 publishes the real text."""
    return Rubric.model_validate(
        {
            "rubric_version": "rubric.v1",
            "dimensions": [
                {
                    "dim_id": dim,
                    "name": DIMENSION_NAMES[dim],
                    "anchors_0_to_4": list(DIMENSION_ANCHORS[dim]),
                    "subchecks": [
                        {"id": cid, "text": text, "na_when": na_when}
                        for cid in ids
                        for text, na_when in (_subcheck_text(cid),)
                    ],
                }
                for dim, ids in CHECKS.items()
            ],
        }
    )


def rubric_text() -> str:
    """The committed form of `prompts/referee/rubric.v1.json` (S2 7.4): `canonical_rubric()` as pretty, sorted-key
    JSON with a final newline -- the same style a candidate manifest's committed file uses
    (`manifests.manifest_text`), so the file a referee manifest hashes by default is always exactly what
    `canonical_rubric()` builds, never hand-edited out of step with it. `manifests.main` (`check`/`write`)
    verifies and regenerates it the same way it does `prompts/manifests/*.json`."""
    return json.dumps(canonical_rubric().model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
