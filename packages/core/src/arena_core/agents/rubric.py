"""Spec S3's `rubric.v1` as S2 7.4 fixes its form, and the one way the referee reads it: from the verified bytes of
the file its manifest hashes (`manifest_rubric`), so the rubric rendered into J4's prompt is the one the manifest
hash certifies (S2 3.2, 7.4). Spec S3 owns the content; until it publishes the file, J4 runs on a development
placeholder and the referee manifest cannot freeze (`manifests.check_referee_freeze`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.contracts.common import Contract
from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.ids import read_json_text

if TYPE_CHECKING:
    from arena_core.agents.manifests import PromptSet

RUBRIC_FILE = "rubric.v1.json"
MAX_SUBCHECKS = 30  # S2 7.4: at most 30 sub-checks in total


class RubricSubcheck(Contract):
    id: Annotated[str, StringConstraints(pattern=r"^[1-5][a-e]$")]
    text: Annotated[str, StringConstraints(min_length=1, max_length=400)]
    na_when: Annotated[str, StringConstraints(min_length=1, max_length=400)] | None


class RubricDimension(Contract):
    dim_id: Literal["D1", "D2", "D3", "D4", "D5"]
    name: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    anchors_0_to_4: Annotated[list[str], Field(min_length=5, max_length=5)]
    subchecks: Annotated[list[RubricSubcheck], Field(min_length=2, max_length=8)]


class Rubric(Contract):
    """Spec S3's `rubric.v1` as S2 7.4 fixes its form."""

    rubric_version: Literal["rubric.v1"]
    dimensions: Annotated[list[RubricDimension], Field(min_length=5, max_length=5)]

    @model_validator(mode="after")
    def _ids(self) -> Self:
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
