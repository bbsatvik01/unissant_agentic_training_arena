"""A Coach Gym challenger as a new coach manifest version (D-036; S2 3.1-3.3 machinery, nothing new).

The optimizer edits one text, the coach's strategy block (the second file of the card assembly; the shared
output contract `common.v*` and the final block are never touched). Approved playbook lessons become a third
file after it. Everything else is the champion's manifest: limits, schemas, user templates, the deep call. The
new version names the champion in `lineage.parent_sha256`, its new prompt files are content-addressed under
`prompts/coach/gym/`, and its manifest is written to `prompts/manifests/gym/<id>-<version>.json` with the S2 3.2
hash, so `load_prompts` verifies it exactly like an official one and `check_roster` can freeze it.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from arena_core.agents.manifests import CandidateManifest, PromptSet, manifest_text, with_hash
from arena_core.agents.templates import REPO_ROOT, check_rel_path
from arena_core.ids import sha256_hex

GYM_PROMPT_DIR = "prompts/coach/gym"
GYM_MANIFEST_DIR = "prompts/manifests/gym"
STRATEGY, PLAYBOOK = "strategy", "playbook"
_WITH_PLAYBOOK = 3  # common, strategy, playbook


class CandidateError(ValueError):
    """A champion whose layout the gym cannot edit, or a file that would overwrite different content."""


@dataclass(frozen=True)
class Layout:
    """Where each editable text sits in a coach's card and final assemblies."""

    common: str
    strategy: str
    playbook: str | None
    final: str


def layout(manifest: CandidateManifest) -> Layout:
    prompt = manifest.prompt
    if manifest.kind != "assistant" or prompt is None:
        msg = f"{manifest.candidate_id}: the gym edits assistant (coach) manifests only"
        raise CandidateError(msg)
    card, final = prompt.assembly.get("card", []), prompt.assembly.get("final", [])
    if len(card) not in (_WITH_PLAYBOOK - 1, _WITH_PLAYBOOK) or final[:-1] != card or len(final) != len(card) + 1:
        msg = f"{manifest.candidate_id}: card {card} / final {final} is not common, strategy[, playbook] (+ final)"
        raise CandidateError(msg)
    return Layout(card[0], card[1], card[2] if len(card) == _WITH_PLAYBOOK else None, final[-1])


def components(prompts: PromptSet) -> dict[str, str]:
    """The champion's editable texts: its strategy and its playbook ("" when it has none)."""
    where = layout(prompts.manifest)
    return {STRATEGY: prompts.text(where.strategy), PLAYBOOK: prompts.text(where.playbook) if where.playbook else ""}


@dataclass(frozen=True)
class Candidate:
    manifest: CandidateManifest
    prompts: PromptSet  # verified-equivalent texts held in memory (no file is read)
    new_files: Mapping[str, str]  # gym prompt files this version adds (path -> text)

    @property
    def version_id(self) -> str:
        return f"{self.manifest.candidate_id}@{self.manifest.version}"


def _gym_path(candidate_id: str, part: str, text: str) -> str:
    path = f"{GYM_PROMPT_DIR}/{candidate_id.lower()}.{part}.{sha256_hex(text)[:12]}.txt"
    check_rel_path(path)
    return path


def next_version(version: str, taken: Iterable[str]) -> str:
    """The champion's next free minor version (1.1.0 -> 1.2.0, or 1.3.0 when 1.2.0 is already taken)."""
    major, minor, _ = (int(p) for p in version.split("."))
    used = set(taken)
    minor += 1
    while f"{major}.{minor}.0" in used:
        minor += 1
    return f"{major}.{minor}.0"


def build(champion: PromptSet, texts: Mapping[str, str], version: str, note: str) -> Candidate:
    """The challenger with `texts[STRATEGY]` and `texts[PLAYBOOK]` ("" = no playbook) on top of `champion`."""
    base = champion.manifest
    where = layout(base)
    current = components(champion)
    strategy, playbook = texts[STRATEGY], texts.get(PLAYBOOK, "")
    if not strategy.strip():
        msg = "a challenger needs a non-empty strategy"
        raise CandidateError(msg)
    all_texts = dict(champion.texts)
    new_files: dict[str, str] = {}
    strategy_path = where.strategy
    if strategy != current[STRATEGY]:
        strategy_path = _gym_path(base.candidate_id, STRATEGY, strategy)
        new_files[strategy_path] = strategy
    playbook_path = where.playbook if playbook and playbook == current[PLAYBOOK] else None
    if playbook and playbook_path is None:
        playbook_path = _gym_path(base.candidate_id, PLAYBOOK, playbook)
        new_files[playbook_path] = playbook
    all_texts.update(new_files)
    card = [where.common, strategy_path, *([playbook_path] if playbook_path else [])]
    raw: dict[str, Any] = base.model_dump(mode="json", exclude={"sha256", "frozen_at"})
    prompt = raw["prompt"]
    assembly = {**prompt["assembly"], "card": card, "final": [*card, where.final]}
    used = [p for parts in assembly.values() for p in parts]
    files = list(dict.fromkeys(used))
    prompt["files"] = [{"path": p, "sha256": sha256_hex(all_texts[p].encode("utf-8"))} for p in files]
    prompt["assembly"] = assembly
    raw["version"] = version
    raw["lineage"] = {"parent_sha256": base.sha256, "change_note": note[:300]}
    manifest = with_hash(raw)
    templates = [t.path for t in manifest.prompt.user_templates] if manifest.prompt else []
    kept = {p: all_texts[p] for p in [*files, *templates]}
    return Candidate(manifest, PromptSet(manifest, kept), new_files)


def manifest_path(manifest: CandidateManifest) -> str:
    return f"{GYM_MANIFEST_DIR}/{manifest.candidate_id}-{manifest.version}.json"


def write(candidate: Candidate, root: Path = REPO_ROOT) -> list[str]:
    """Write the new prompt files and the manifest; refuse to overwrite a file with different content."""
    out = {**candidate.new_files, manifest_path(candidate.manifest): manifest_text(candidate.manifest)}
    for rel, text in out.items():
        path = root / rel
        if path.is_file() and path.read_text(encoding="utf-8") != text:
            msg = f"{rel} already exists with different content"
            raise CandidateError(msg)
    for rel, text in out.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return sorted(out)


def read_manifest(rel: str, root: Path = REPO_ROOT) -> CandidateManifest:
    return CandidateManifest.model_validate(json.loads((root / rel).read_text(encoding="utf-8")))
