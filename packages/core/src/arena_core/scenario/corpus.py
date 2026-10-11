"""Hidden-content scan corpus (S1 10.4; shared decision D1): the one definition the referee's pre-tournament
isolation scan (S2 3.4, S3 IG-4, L9) and AC-S1-21/AC-S1-33 use. Built once per hidden family from its accepted
file (sealed archive, S1 10.5): identifiers (family ID, both case IDs, the four canaries, the persona name)
match as exact substrings (the persona name as a token sequence); every other string outside the platform
field-path allowlist contributes 8-grams (S2 G6 tokenization, `arena_core.safety.guard`), minus every 8-gram
that also occurs in a development family file at the seal commit (the reference, subtracted).

A hit never carries the matched text (L7): `scan()` returns which hidden family field(s) produced it, never
the string itself.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass

from arena_core.safety.guard import ngrams, tokens

JSONValue = str | int | float | bool | None | Mapping[str, "JSONValue"] | Sequence["JSONValue"]
Family = Mapping[str, JSONValue]

Gram = tuple[str, ...]

# S1 10.4's allowlist: leaf field paths that are platform boilerplate, never case-specific, so their text never
# enters the corpus. Paths are relative to the family root; `_VARIANT_ALLOW` paths are relative to one variant
# object (`variants.<role>.<path>`). Array indices are stripped before matching (`_strip_index`).
_FAMILY_ROOT_ALLOW = frozenset(
    {
        "schema_version",
        "family_id",
        "revision",
        "split",
        "domain",
        "taxonomy",
        "difficulty",
        "style",
        "provenance.method",
        "provenance.created",
        "provenance.generator_model",
        "provenance.family_sha256",
        "provenance.source_sha256",
        "provenance.few_shot_family_ids",
    }
)
_VARIANT_ALLOW = frozenset(
    {
        "case_id",
        "public_packet.schema_version",
        "public_packet.packet",
        "public_packet.case_id",
        "public_packet.ground_rules",
        "public_packet.limits",
        "public_packet.interview_context.agency",
        "public_packet.interview_context.timezone",
        "public_packet.presentation.persona_id",
        "public_packet.presentation.voice_id",
        "private_packet.schema_version",
        "private_packet.packet",
        "private_packet.case_id",
        "private_packet.role",
        "private_packet.objective",
        "private_packet.permitted_behaviors",
        "private_packet.forbidden_behaviors",
        "private_packet.limits",
        "private_packet.difficulty",
        "private_packet.style",
        "evaluator_packet.schema_version",
        "evaluator_packet.packet",
        "evaluator_packet.case_id",
        "evaluator_packet.variant",
        "evaluator_packet.role",
    }
)
_INDEX = re.compile(r"\[\d+\]")
_VARIANT_PATH = re.compile(r"^variants\.(truthful|deceptive)\.(.*)$")
_VARIANT_ROOT = re.compile(r"^variants(\.(truthful|deceptive))?$")


def _strip_index(path: str) -> str:
    return _INDEX.sub("", path)


def _is_allowed(path: str) -> bool:
    stripped = _strip_index(path)
    variant_match = _VARIANT_PATH.match(stripped)
    if variant_match:
        return variant_match.group(2) in _VARIANT_ALLOW
    if _VARIANT_ROOT.match(stripped):
        return True  # the container itself, never a leaf
    return stripped in _FAMILY_ROOT_ALLOW


def _iter_strings(obj: JSONValue, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(obj, str):
        if obj:
            yield path, obj
    elif isinstance(obj, Mapping):
        for key, value in obj.items():
            yield from _iter_strings(value, f"{path}.{key}" if path else str(key))
    elif isinstance(obj, Sequence):
        for i, value in enumerate(obj):
            yield from _iter_strings(value, f"{path}[{i}]")


def _as_mapping(value: JSONValue) -> Mapping[str, JSONValue]:
    """A family file's own JSON shape guarantees this; an unexpected leaf yields no further fields rather
    than raising, so a malformed or partial fixture degrades to fewer hits, never a crash."""
    return value if isinstance(value, Mapping) else {}


def _as_str(value: JSONValue) -> str | None:
    return value if isinstance(value, str) and value else None


def _family_text(family: Family) -> Iterator[tuple[str, str]]:
    """Every non-allowlisted string of `family`, with its field path (variants and family root)."""
    for role, variant in _as_mapping(family.get("variants")).items():
        for path, text in _iter_strings(variant, f"variants.{role}"):
            if not _is_allowed(path):
                yield path, text
    root = {k: v for k, v in family.items() if k != "variants"}
    for path, text in _iter_strings(root, ""):
        if not _is_allowed(path):
            yield path, text


def family_text_grams(family: Family) -> dict[Gram, set[str]]:
    """Every 8-gram of `family`'s non-allowlisted text, each mapped to the field paths it came from."""
    out: dict[Gram, set[str]] = {}
    for path, text in _family_text(family):
        for gram in ngrams(text):
            out.setdefault(gram, set()).add(path)
    return out


def dev_reference_grams(dev_families: Iterable[Family]) -> frozenset[Gram]:
    """S1 10.4's subtracted reference: every 8-gram of every development family's non-allowlisted text, fixed
    at the seal commit. A test that uses a development family as a stand-in hidden family leaves it out of
    this reference (10.4)."""
    out: set[Gram] = set()
    for family in dev_families:
        for _path, text in _family_text(family):
            out |= ngrams(text)
    return frozenset(out)


@dataclass(frozen=True)
class Corpus:
    """One hidden family's scan corpus (S1 10.4). `substrings` matches exactly; `persona_tokens` matches as a
    token sequence (S2 G6 tokenization); `grams` matches by 8-gram, already minus the development reference."""

    substrings: Mapping[str, str]  # identifier text -> the field path it came from
    persona_tokens: Gram | None
    persona_path: str | None
    grams: Mapping[Gram, frozenset[str]]


def build_corpus(family: Family, dev_reference: frozenset[Gram] = frozenset()) -> Corpus:
    """One family's corpus (S1 10.4): the family ID, both case IDs and the four canaries (two variants x
    `private_packet.canary` and `evaluator_packet.canary`) as identifiers; the persona name (both variants
    carry the same `presentation.display_name`, L1) as a token sequence; every other non-allowlisted 8-gram,
    minus `dev_reference`."""
    substrings: dict[str, str] = {}
    family_id = _as_str(family.get("family_id"))
    if family_id:
        substrings[family_id] = "family_id"
    persona_tokens: Gram | None = None
    persona_path: str | None = None
    for role, variant_value in _as_mapping(family.get("variants")).items():
        variant = _as_mapping(variant_value)
        case_id = _as_str(variant.get("case_id"))
        if case_id:
            substrings[case_id] = f"variants.{role}.case_id"
        for packet_name in ("private_packet", "evaluator_packet"):
            canary = _as_str(_as_mapping(variant.get(packet_name)).get("canary"))
            if canary:
                substrings[canary] = f"variants.{role}.{packet_name}.canary"
        if persona_tokens is None:
            presentation = _as_mapping(_as_mapping(variant.get("public_packet")).get("presentation"))
            name = _as_str(presentation.get("display_name"))
            if name:
                persona_tokens = tuple(tokens(name))
                persona_path = f"variants.{role}.public_packet.presentation.display_name"
    grams: dict[Gram, set[str]] = {}
    for gram, paths in family_text_grams(family).items():
        if gram in dev_reference:
            continue
        grams[gram] = paths
    return Corpus(
        substrings=substrings,
        persona_tokens=persona_tokens if persona_tokens else None,
        persona_path=persona_path,
        grams={g: frozenset(p) for g, p in grams.items()},
    )


@dataclass(frozen=True)
class Hit:
    """One corpus hit (S1 10.4, L7): which hidden family field(s) it came from, never the matched text."""

    kind: str  # "identifier" or "text"
    source_paths: tuple[str, ...]


def scan(corpus: Corpus, text: str) -> list[Hit]:
    """Every hit of `corpus` in `text` (S3 IG-4, S2 3.4): one `Hit` per matching identifier, the persona name
    once if it occurs, and one per distinct 8-gram that lands in `corpus.grams`."""
    hits: list[Hit] = []
    for substr, path in corpus.substrings.items():
        if substr and substr in text:
            hits.append(Hit("identifier", (path,)))
    if corpus.persona_tokens and corpus.persona_path:
        words = tokens(text)
        n = len(corpus.persona_tokens)
        if any(tuple(words[i : i + n]) == corpus.persona_tokens for i in range(len(words) - n + 1)):
            hits.append(Hit("identifier", (corpus.persona_path,)))
    for gram in ngrams(text):
        paths = corpus.grams.get(gram)
        if paths:
            hits.append(Hit("text", tuple(sorted(paths))))
    return hits


@dataclass(frozen=True)
class ScanResult:
    """One scanned file's result (S3 IG-4 pass evidence): counts and field paths only, never matched text."""

    path: str
    hits: Sequence[Hit]

    @property
    def hit_count(self) -> int:
        return len(self.hits)


def scan_files(corpus: Corpus, files: Mapping[str, str]) -> list[ScanResult]:
    """`files`: scanned-file path -> its text (prompts, templates, fixtures named by a rostered manifest,
    S1 AC-S1-21). Returns one `ScanResult` per file, including files with zero hits."""
    return [ScanResult(path, scan(corpus, text)) for path, text in files.items()]
