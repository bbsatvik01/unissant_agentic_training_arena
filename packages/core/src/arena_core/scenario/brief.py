"""Authoring-brief renderer (S1 8.2; leakage rule L5).

An authoring brief is plain text with four blocks:

| Block | Content |
| --- | --- |
| `RULES` | the authoring rules file (`prompts/scenario/authoring.rules.v1.txt`, WP-09), passed in as text |
| `DOMAIN` | the facility-access record vocabulary (research X9 Q6) and the catalogs from the schemas |
| `EXAMPLE` | one development family rendered as a design brief, under a do-not-reuse header |
| `SEED` | the seed spec as JSON |

`Authoring` carries a seed spec, its brief, the authoring agent's model ID and the date into
`assemble(source, authoring)`, which writes the family's code-owned fields and its provenance from them.
An AI-authored source is committed with its authoring context beside it (`F04.source.json` and
`F04.authoring.json`), so the build can always rebuild the family (`authoring_beside`).

The example must come from the development split (L5): `design_brief` raises `ExampleSplitError` for any
family whose split is not `dev`, so a hidden family can never become an example (AC-S1-20). It must also
have a different violation type from the seed. `prompt_sha256` of the authored family is the sha256 of the
brief text, which holds the rules, the example brief and the seed spec (S1 8.4).
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from arena_core.ids import canonical_json, read_json_text, sha256_hex
from arena_core.scenario.content import content_text
from arena_core.scenario.schema import schema_enum
from arena_core.scenario.seed import DrawStream, SeedSpec

BRIEF_VERSION = "authoring_brief.v1"
DESIGN_BRIEF_TITLE = "CASE DESIGN BRIEF"
EXAMPLE_HEADER = "Example from a different case. Do not reuse its people, places, records or events."
# Research X9 Q6 (DOE OIG physical-security audit vocabulary), facility-access row.
FACILITY_ACCESS_VOCABULARY = (
    "Badge-swipe logs with timestamps, visitor sign-in sheets, access-control-system audit exports, "
    "badge-issuance and termination records, security-camera time-stamps (metadata only, never footage content)."
)


class ExampleSplitError(ValueError):
    """The example family is not a development family (S1 L5)."""


def _record_lines(family: Mapping[str, Any]) -> list[str]:
    truthful, deceptive = family["variants"]["truthful"], family["variants"]["deceptive"]
    dates = {r["record_id"]: r.get("date") for r in truthful["public_packet"]["requestable_records"]}
    lines = ["RECORDS"]
    pairs = zip(
        truthful["evaluator_packet"]["evidence_artifacts"],
        deceptive["evaluator_packet"]["evidence_artifacts"],
        strict=True,
    )
    for t_art, d_art in pairs:
        release = t_art["release"]
        when = release["type"] + (f" after {release['after_exchanges']}" if "after_exchanges" in release else "")
        date = dates.get(t_art["artifact_id"])
        lines.append(
            f"{t_art['artifact_id']} {t_art['kind']} ({when}): {t_art['title']}" + (f" [dated {date}]" if date else "")
        )
        if t_art["content"] == d_art["content"]:
            lines.append("  both: " + content_text(t_art["content"]).replace("\n", "; "))
        else:
            lines.append("  T: " + content_text(t_art["content"]).replace("\n", "; "))
            lines.append("  D: " + content_text(d_art["content"]).replace("\n", "; "))
        t_support = ", ".join(f"{s['fact_id']}={s['level']}" for s in t_art["supports"])
        d_support = ", ".join(f"{s['fact_id']}={s['level']}" for s in d_art["supports"])
        lines.append(f"  supports T: {t_support} | D: {d_support}")
    return lines


def _variant_lines(family: Mapping[str, Any]) -> list[str]:
    lines: list[str] = []
    for mark, variant in (("T", "truthful"), ("D", "deceptive")):
        private = family["variants"][variant]["private_packet"]
        ledger = "; ".join(
            f"{k['id']} {k['class']}" + (f"({k['gate_id']})" if "gate_id" in k else "") for k in private["facts"]
        )
        lines.append(f"LEDGER {mark}: {ledger}")
        lines.extend(
            f"GATE {g['id']} level {g['min_evidence_level']} opens {g['opens']}: {g['condition']}"
            for g in private["gates"]
        )
        lines.extend(
            f"UNCERTAINTY {u['id']} {u['fact_id']} {u['answer_form']}: {u['text']}" for u in private["uncertainty"]
        )
        lines.extend(f"FORBIDDEN {x['id']} ({x['contradicts']}): {x['text']}" for x in private["forbidden_assertions"])
        criteria = family["variants"][variant]["evaluator_packet"]["resolution_criteria"]
        lines.extend(
            f"DECISIVE {mark} {item['id']} {item['artifact_ids']}: {item['description']}"
            for item in criteria["decisive_support"]
        )
    return lines


def design_brief(family: Mapping[str, Any]) -> str:
    """One development family as a design brief (the EXAMPLE block). Raises ExampleSplitError unless dev."""
    if family.get("split") != "dev":
        msg = (
            f"family {family.get('family_id')!r} has split {family.get('split')!r}; only dev families are examples (L5)"
        )
        raise ExampleSplitError(msg)
    public = family["variants"]["truthful"]["public_packet"]
    taxonomy, difficulty = family["taxonomy"], family["difficulty"]
    lines = [
        f"{DESIGN_BRIEF_TITLE} {family['family_id']}: {family['title']}",
        f"taxonomy: {taxonomy['violation_type']}; misleading: {', '.join(taxonomy['misleading_types'])}; "
        f"level {difficulty['level']} {difficulty['knobs']}",
        "OBJECTIVE: " + public["investigation_objective"],
        "OPENING QUESTION: " + public["opening_question"],
        "REPLAY TOPICS: " + "; ".join(public["replay_topics"]),
        "FACTS (id [variants] tags: statement)",
    ]
    for fact in family["event_graph"]["facts"]:
        marks = "/".join(v[0].upper() for v in fact["variants"])
        lines.append(f"{fact['id']} [{marks}] {','.join(fact['tags'])}: {fact['statement']}")
    lines.append(
        "EDGES: " + "; ".join(f"{e['from']} {e['relation']} {e['to']}" for e in family["event_graph"]["edges"])
    )
    lines.extend(_record_lines(family))
    lines.extend(_variant_lines(family))
    return "\n".join(lines)


def domain_block() -> str:
    """Record vocabulary and the schema catalogs an author may use."""
    return "\n".join(
        [
            "Facility-access evidence vocabulary: " + FACILITY_ACCESS_VOCABULARY,
            "Record kinds: " + ", ".join(schema_enum("public-packet.schema.json", "artifactKind")),
            "Violation types: " + ", ".join(schema_enum("case-family.schema.json", "violationType")),
            "Misleading types: " + ", ".join(schema_enum("case-family.schema.json", "misleadingType")),
        ]
    )


def choose_example(spec: SeedSpec, families: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    """A development family with a different violation type, drawn from the seed (S1 8.2)."""
    eligible = sorted(
        (f for f in families if f.get("split") == "dev" and f["taxonomy"]["violation_type"] != spec.violation_type),
        key=lambda f: str(f["family_id"]),
    )
    if not eligible:
        msg = f"no development family with a violation type other than {spec.violation_type!r}"
        raise ValueError(msg)
    return DrawStream(spec.sampler.seed, f"example|{spec.family_id}").choice(eligible)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class AuthoringBrief(_Model):
    """A rendered brief. `sha256` is the family's `prompt_sha256`; it must be the hash of `text`."""

    text: str
    sha256: str
    example_family_id: str
    seed_spec_sha256: str

    @model_validator(mode="after")
    def _hash_matches_text(self) -> AuthoringBrief:
        if self.sha256 != sha256_hex(self.text):
            msg = "brief sha256 is not the sha256 of its text"
            raise ValueError(msg)
        # `example_family_id` becomes the family's few_shot_family_ids: it must be the family the text shows.
        if f"\n\nEXAMPLE\n{EXAMPLE_HEADER}\n{DESIGN_BRIEF_TITLE} {self.example_family_id}:" not in self.text:
            msg = f"example_family_id {self.example_family_id} is not the family in the brief's EXAMPLE block"
            raise ValueError(msg)
        return self


def seed_block(spec: SeedSpec) -> str:
    """The brief's last block: the seed spec as JSON with sorted keys, so it reads the same however the spec
    was loaded (what the agent is told the code-owned fields are)."""
    return "SEED\n" + json.dumps(spec.as_json(), indent=2, ensure_ascii=False, sort_keys=True)


def render_authoring_brief(spec: SeedSpec, example: Mapping[str, Any], rules_text: str) -> AuthoringBrief:
    """The full brief for one seed: RULES, DOMAIN, EXAMPLE (dev only, other violation type), SEED."""
    if not rules_text.strip():
        msg = "the RULES block is empty; pass the authoring rules file's text"
        raise ValueError(msg)
    example_text = design_brief(example)
    if example["taxonomy"]["violation_type"] == spec.violation_type:
        msg = f"the example {example['family_id']} shares the seed's violation type {spec.violation_type!r} (S1 8.2)"
        raise ValueError(msg)
    blocks = [
        f"{BRIEF_VERSION}",
        "RULES\n" + rules_text.strip(),
        "DOMAIN\n" + domain_block(),
        f"EXAMPLE\n{EXAMPLE_HEADER}\n{example_text}",
        seed_block(spec),
    ]
    text = "\n\n".join(blocks) + "\n"
    return AuthoringBrief(
        text=text, sha256=sha256_hex(text), example_family_id=str(example["family_id"]), seed_spec_sha256=spec.sha256()
    )


class Authoring(_Model):
    """What code owns when an agent authors a family from a seed (S1 8.1-8.3): the seed spec, the brief the
    agent worked from, the agent's model ID and the authoring date. `assemble(source, authoring)` writes
    every code-owned field of the family from it."""

    spec: SeedSpec
    brief: AuthoringBrief
    generator_model: str = Field(min_length=1, max_length=80)
    created: str = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

    @model_validator(mode="after")
    def _brief_is_for_this_seed(self) -> Authoring:
        if self.brief.seed_spec_sha256 != self.spec.sha256():
            msg = "the brief was rendered for a different seed spec"
            raise ValueError(msg)
        # The hash metadata is not enough: the text the agent read (and `prompt_sha256` covers) must end with
        # this spec's SEED block, so a stale brief cannot be re-pointed at another seed (S1 8.4).
        if not self.brief.text.endswith("\n\n" + seed_block(self.spec) + "\n"):
            msg = "the brief's SEED block is not this seed spec"
            raise ValueError(msg)
        return self

    def provenance(self) -> dict[str, Any]:
        """The family's `provenance` (S1 7.5 step 4, 8.3): method generator, model, brief and seed hashes."""
        sampler = self.spec.sampler
        notes = (
            f"AI-authored offline (D-014) from sampler seed {sampler.seed}, family {sampler.index + 1} of "
            f"{sampler.n} ({self.spec.split} split), factorial largest |phi| {sampler.max_phi:.3f}."
        )
        if sampler.replacement:
            notes += f" Replacement {sampler.replacement} for a discarded seed in that slot (S1 8.5)."
        return {
            "method": "generator",
            "created": self.created,
            "generator_model": self.generator_model,
            "prompt_sha256": self.brief.sha256,
            "seed_spec_sha256": self.spec.sha256(),
            "few_shot_family_ids": [self.brief.example_family_id],
            "notes": notes,
        }


SOURCE_SUFFIX = ".source.json"
AUTHORING_SUFFIX = ".authoring.json"


def load_authoring(path: Path) -> Authoring:
    """An authoring context file, read strictly (no duplicate keys, no NaN) and validated."""
    return Authoring.model_validate_json(canonical_json(read_json_text(path.read_text(encoding="utf-8"))))


def authoring_beside(source_path: Path) -> Authoring | None:
    """The authoring context committed next to a source (`X.source.json` -> `X.authoring.json`), if any."""
    if not source_path.name.endswith(SOURCE_SUFFIX):
        msg = f"{source_path.name}: a family source file is named <family>{SOURCE_SUFFIX}"
        raise ValueError(msg)
    path = source_path.with_name(source_path.name.removesuffix(SOURCE_SUFFIX) + AUTHORING_SUFFIX)
    return load_authoring(path) if path.exists() else None
