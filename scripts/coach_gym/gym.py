"""Coach Gym runs: dataset, optimize-and-grade, promote (D-036; PROCTOR roles kept apart).

- Optimizer (`optimize.py`, GEPA) sees the train pool and its validation set only.
- Critic (`reflect.py`) sees train-side failures and label disagreements only; the curator files its lessons as
  `pending`, and a human approves them.
- Grader (`arena_core.coachgym.metric`, code) scores the champion and the challenger on the dev holdout plus the
  canaries, after the search has ended, with fresh calls; the promotion rule reads only its metrics.
- Promotion is a human command (`make coach-promote`): it re-verifies the frozen manifest's hashes, runs the
  roster-freeze check, records the new champion and, only when asked (`REGISTER=1`), registers the version in
  `arena.candidates`, where the next tournament roster and new practice sessions pick it up.
"""

from __future__ import annotations

import fcntl
import json
import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from arena_core.agents.manifests import PromptSet, check_roster, load_prompts
from arena_core.coachgym import registry
from arena_core.coachgym.candidate import (
    PLAYBOOK,
    STRATEGY,
    Candidate,
    build,
    components,
    manifest_path,
    next_version,
    write,
)
from arena_core.coachgym.examples import (
    Example,
    TrialRecord,
    build_examples,
    check_partitions,
    dataset_sha256,
    load_holdout,
    partition,
    read_jsonl,
    with_canaries,
    write_jsonl,
)
from arena_core.coachgym.metric import (
    CardRun,
    Grade,
    Metrics,
    Verdict,
    aggregate,
    cheat_findings,
    promotion_verdict,
)
from arena_core.coachgym.playbook import CurateContext, Lesson, curate, render, rendered
from arena_core.db import calls
from arena_core.db.pool import Connector
from arena_core.providers.port import AgentPort
from scripts.coach_gym.data import fetch_dev_data
from scripts.coach_gym.evaluate import BudgetExhaustedError, CardEvaluator, Meter
from scripts.coach_gym.optimize import (
    Bridge,
    GymAdapter,
    Halt,
    OptimizeResult,
    ReflectionLM,
    Search,
    optimize,
    run_in_thread,
)
from scripts.coach_gym.phoenix import ExperimentRow, Phoenix
from scripts.coach_gym.reflect import reflect, reflector_input

log = logging.getLogger(__name__)

RUN_DIR = ".run/coach-gym"
LATEST = "latest.json"
OPTIMIZER_SHARE = Decimal("0.6")  # the rest of BUDGET is kept for the holdout grading and the reflector


class GymError(RuntimeError):
    """A gym command refused (unknown version, unverifiable manifest, a refused promotion, no dataset)."""


# ---------------------------------------------------------------- dataset


def forbidden_strings(examples: Sequence[Example], canaries: Sequence[str]) -> list[str]:
    """What no candidate text or lesson may contain: every case id, the packets' canaries, the gym's canary
    tokens."""
    tokens = [e.reference.canary_token for e in examples if e.reference.canary_token]
    return sorted({*(e.case_id for e in examples if e.case_id), *canaries, *tokens})


async def build_dataset(connect: Connector, root: Path, phoenix: Phoenix | None = None) -> dict[str, Any]:
    """`make coach-gym-dataset`: read the dev trials (dev-only SQL) and save the dataset."""
    data = await fetch_dev_data(connect)
    return save_dataset(root, data.trials, data.canaries, phoenix)


def save_dataset(
    root: Path, trials: Sequence[TrialRecord], canaries: Sequence[str], phoenix: Phoenix | None = None
) -> dict[str, Any]:
    """Examples (with the gym's canaries) to `.run/coach-gym/dataset-<sha>.jsonl`, the run metadata to
    `latest.json`, and optionally the examples to Phoenix as a dataset."""
    holdout = load_holdout(root)
    examples = with_canaries(build_examples(trials, holdout))
    sha = dataset_sha256(examples, holdout)
    out = root / RUN_DIR
    path = out / f"dataset-{sha[:12]}.jsonl"
    write_jsonl(path, examples)
    meta: dict[str, Any] = {
        "sha256": sha,
        "path": str(path.relative_to(root)),
        "built_at": registry.now(),
        "trials": len(trials),
        "holdout": sorted(holdout),
        "counts": counts(examples),
        "forbidden": forbidden_strings(examples, canaries),
        "phoenix_dataset_id": None,
    }
    if phoenix is not None and examples:
        meta["phoenix_dataset_id"] = phoenix.upload_dataset(f"coach-gym-{sha[:12]}", examples)
    (out / LATEST).write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return meta


def counts(examples: Sequence[Example]) -> dict[str, int]:
    return {
        "train": sum(e.partition == "train" and not e.canary for e in examples),
        "val": sum(e.partition == "val" for e in examples),
        "holdout": sum(e.partition == "holdout" for e in examples),
        "canaries": sum(e.canary for e in examples),
    }


def load_dataset(root: Path) -> tuple[dict[str, Any], list[Example]]:
    """The latest dataset, refused unless it hashes to what was recorded, was split by today's holdout and every
    example sits in the partition its family and id put it in (so a hand-edited file cannot move a holdout
    example into the optimizer's pool)."""
    latest = root / RUN_DIR / LATEST
    if not latest.is_file():
        msg = "no dataset yet: run `make coach-gym-dataset` first"
        raise GymError(msg)
    meta = json.loads(latest.read_text(encoding="utf-8"))
    examples = read_jsonl(root / meta["path"])
    holdout = load_holdout(root)
    if sorted(holdout) != meta.get("holdout"):
        msg = f"the dataset was split by holdout {meta.get('holdout')}, not today's {sorted(holdout)}; rebuild it"
        raise GymError(msg)
    if dataset_sha256(examples, holdout) != meta["sha256"]:
        msg = f"{meta['path']} does not hash to the dataset recorded in {LATEST}"
        raise GymError(msg)
    problems = check_partitions(examples, holdout)
    if problems:
        msg = f"{meta['path']}: {'; '.join(problems[:3])}"
        raise GymError(msg)
    return meta, examples


# ---------------------------------------------------------------- run


@dataclass(frozen=True)
class RunConfig:
    run_id: str
    candidate_id: str
    budget: Decimal
    mode: Literal["fake", "vertex"]
    max_evals: int = 300
    minibatch: int = 3
    val_size: int = 24


@dataclass(frozen=True)
class Holdout:
    champion: Metrics
    challenger: Metrics
    champion_runs: list[tuple[Example, Grade, CardRun]]
    challenger_runs: list[tuple[Example, Grade, CardRun]]


async def _grade(
    evaluator: CardEvaluator, prompts: PromptSet, examples: Sequence[Example]
) -> list[tuple[Example, Grade, CardRun]]:
    results = await evaluator.grade_all(prompts, examples)
    return [(e, g, r) for e, (g, r) in zip(examples, results, strict=True)]


async def grade_holdout(
    evaluator: CardEvaluator, champion: PromptSet, challenger: PromptSet, examples: Sequence[Example]
) -> Holdout:
    """The grader role: champion and challenger, fresh calls, on the holdout and every canary."""
    pool = [*partition(examples, "holdout"), *(e for e in examples if e.canary)]
    old = await _grade(evaluator, champion, pool)
    new = await _grade(evaluator, challenger, pool)
    return Holdout(aggregate(g for _, g, _ in old), aggregate(g for _, g, _ in new), old, new)


def _val(examples: Sequence[Example], size: int) -> list[Example]:
    val = sorted(partition(examples, "val"), key=lambda e: e.example_id)
    if not val:  # a tiny dataset: GEPA validates on the train pool rather than on nothing
        val = sorted((e for e in partition(examples, "train") if not e.canary), key=lambda e: e.example_id)
    return val[:size]


def _rows(runs: Sequence[tuple[Example, Grade, CardRun]]) -> list[ExperimentRow]:
    return [ExperimentRow(e.example_id, g.label or "no card", float(g.score), g.feedback) for e, g, _ in runs]


@dataclass(frozen=True)
class Champion:
    event: registry.VersionEvent
    prompts: PromptSet  # verified against its manifest's hashes (`load_prompts`)
    approved: list[Lesson]
    playbook: str  # the approved lessons rendered, else the champion's own playbook
    version: str  # the challenger's version

    @classmethod
    def load(cls, root: Path, candidate_id: str) -> Champion:
        event = registry.champion(root, candidate_id)
        prompts = load_prompts(registry.manifest_of(root, event), root)
        approved = rendered(registry.approved_lessons(root, candidate_id))  # exactly the lessons the text shows
        playbook = render(approved) or components(prompts)[PLAYBOOK]
        return cls(
            event, prompts, approved, playbook, next_version(event.version, registry.taken_versions(root, candidate_id))
        )


@dataclass(frozen=True)
class Outcome:
    challenger: Candidate | None  # None: the search found nothing different from the champion
    holdout: Holdout | None
    verdict: Verdict
    stop_reason: str


@dataclass(frozen=True)
class Ctx:
    """One gym run's fixed inputs."""

    cfg: RunConfig
    port: AgentPort
    evaluator: CardEvaluator
    root: Path
    meta: dict[str, Any]
    examples: list[Example]
    champ: Champion


async def _search(ctx: Ctx) -> tuple[OptimizeResult, GymAdapter]:
    """The optimizer role: GEPA on the train pool and its validation set."""
    holder: list[GymAdapter] = []
    champ, examples, cfg = ctx.champ, ctx.examples, ctx.cfg

    def search(bridge: Bridge, halt: Halt) -> OptimizeResult:
        adapter = GymAdapter(ctx.evaluator, champ.prompts, champ.playbook, champ.version, bridge, halt)
        holder.append(adapter)
        reflection = ReflectionLM(ctx.port, ctx.evaluator.meter, cfg.run_id, bridge, halt)
        space = Search(
            partition(examples, "train"), _val(examples, cfg.val_size), reflection, cfg.max_evals, cfg.minibatch
        )
        return optimize(adapter, space)

    found = await run_in_thread(search)
    return found, holder[0]


async def _judge(ctx: Ctx, found: OptimizeResult) -> Outcome:
    """The grader role: the challenger against the champion on the holdout, then the promotion rule."""
    champ = ctx.champ
    note = f"Coach Gym run {ctx.cfg.run_id}: GEPA strategy search; {len(champ.approved)} approved playbook lesson(s)."
    challenger = build(champ.prompts, {STRATEGY: found.strategy, PLAYBOOK: champ.playbook}, champ.version, note)
    if components(challenger.prompts) == components(champ.prompts):
        reason = "the search found no strategy or playbook different from the champion's"
        return Outcome(None, None, Verdict(promote=False, reasons=(reason,)), found.stop_reason)
    try:
        holdout = await grade_holdout(ctx.evaluator, champ.prompts, challenger.prompts, ctx.examples)
    except BudgetExhaustedError as exc:
        log.warning("coach gym %s: holdout not graded: %s", ctx.cfg.run_id, exc)
        verdict = Verdict(promote=False, reasons=("the budget ran out before the holdout was graded",))
        return Outcome(challenger, None, verdict, "budget (holdout incomplete)")
    texts = {"the challenger strategy": found.strategy, "the challenger playbook": champ.playbook}
    verdict = promotion_verdict(holdout.champion, holdout.challenger, cheat_findings(texts, ctx.meta["forbidden"]))
    return Outcome(challenger, holdout, verdict, found.stop_reason)


async def _lessons(ctx: Ctx, graded: Sequence[tuple[Example, Grade]]) -> list[str]:
    """The critic and the curator: new `pending` lessons from the run's train-side grades and disagreements."""
    cfg = ctx.cfg
    pool = [e for e in ctx.examples if e.partition in ("train", "val")]
    shown = reflector_input(graded, pool)
    try:
        proposed = await reflect(ctx.port, ctx.evaluator.meter, cfg.run_id, shown)
    except BudgetExhaustedError as exc:
        log.warning("coach gym %s: no reflector call: %s", cfg.run_id, exc)
        return []
    known = [lesson for lesson, _ in registry.lessons(ctx.root).values()]
    forbidden = list(ctx.meta["forbidden"])
    curated = curate(
        proposed, CurateContext(known, cfg.candidate_id, cfg.run_id, shown.trial_of, forbidden, registry.now())
    )
    registry.propose_lessons(ctx.root, curated.accepted)
    return [lesson.lesson_id for lesson in curated.accepted]


def _record_version(ctx: Ctx, outcome: Outcome) -> str | None:
    challenger = outcome.challenger
    if challenger is None:
        return None
    written = write(challenger, ctx.root) if outcome.verdict.promote else []
    holdout = outcome.holdout
    event = registry.VersionEvent(
        version_id=challenger.version_id,
        candidate_id=ctx.cfg.candidate_id,
        version=ctx.champ.version,
        status="challenger",
        at=registry.now(),
        manifest_path=manifest_path(challenger.manifest) if written else "",
        manifest_sha256=challenger.manifest.sha256 or "",
        parent_sha256=ctx.champ.prompts.manifest.sha256,
        change_note=challenger.manifest.lineage.change_note,
        run_id=ctx.cfg.run_id,
        lesson_ids=tuple(x.lesson_id for x in ctx.champ.approved),
        metrics=None if holdout is None else {"holdout": holdout.challenger.to_json()},
        verdict=outcome.verdict.to_json(),
    )
    registry.append_versions(ctx.root, [event])
    return challenger.version_id


async def run_gym(cfg: RunConfig, port: AgentPort, root: Path, phoenix: Phoenix | None = None) -> registry.Experiment:
    with registry_lock(root):
        return await _run_gym(cfg, port, root, phoenix)


async def _run_gym(cfg: RunConfig, port: AgentPort, root: Path, phoenix: Phoenix | None) -> registry.Experiment:
    started = registry.now()
    meta, examples = load_dataset(root)
    champ = Champion.load(root, cfg.candidate_id)
    meter = Meter(cfg.budget, cap=cfg.budget * OPTIMIZER_SHARE)
    ctx = Ctx(cfg, port, CardEvaluator(port, meter, cfg.run_id), root, meta, examples, champ)
    found, adapter = await _search(ctx)
    meter.cap = None  # the optimizer's share is over; the rest is the grader's and the critic's
    outcome = await _judge(ctx, found)
    lesson_ids = await _lessons(ctx, adapter.graded.get(found.strategy, []))
    challenger_id = _record_version(ctx, outcome)
    holdout = outcome.holdout
    experiment = registry.Experiment(
        run_id=cfg.run_id,
        candidate_id=cfg.candidate_id,
        mode=cfg.mode,
        champion_id=champ.event.version_id,
        challenger_id=challenger_id,
        started_at=started,
        finished_at=registry.now(),
        budget_usd=str(cfg.budget),
        spent_usd=str(meter.spent),
        dataset_sha256=meta["sha256"],
        counts=counts(examples),
        before=None if holdout is None else holdout.champion.to_json(),
        after=None if holdout is None else holdout.challenger.to_json(),
        series=found.series,
        verdict=outcome.verdict.to_json(),
        lessons_proposed=lesson_ids,
        stop_reason=outcome.stop_reason,
    )
    registry.append_experiment(root, experiment)
    if phoenix is not None and holdout is not None and meta.get("phoenix_dataset_id"):
        info = {"run_id": cfg.run_id, "candidate_id": cfg.candidate_id}
        dataset = meta["phoenix_dataset_id"]
        phoenix.log_experiment(
            dataset, f"{cfg.run_id} champion {champ.event.version_id}", info, _rows(holdout.champion_runs)
        )
        phoenix.log_experiment(
            dataset, f"{cfg.run_id} challenger {challenger_id}", info, _rows(holdout.challenger_runs)
        )
    return experiment


# ---------------------------------------------------------------- promote and report


@contextmanager
def registry_lock(root: Path) -> Iterator[None]:
    """One gym run or promotion at a time on this checkout: an exclusive, non-blocking lock under the git-ignored
    run directory, held from a run's version allocation to its publication, and across a promotion."""
    path = root / RUN_DIR / "registry.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            msg = "another coach gym run or promotion holds the registry; wait for it to finish"
            raise GymError(msg) from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


async def promote(root: Path, version_id: str, by: str, register: Connector | None = None) -> list[str]:
    """A human's promotion of a challenger whose holdout verdict says promote, against the champion it was graded
    against. With `register`, the version is registered in `arena.candidates` first (idempotent): the promotion
    is recorded only after that succeeded, so a failed registration leaves the challenger promotable again."""
    with registry_lock(root):
        current = registry.current_versions(root)
        event = current.get(version_id)
        if event is None or event.status != "challenger":
            msg = f"{version_id} is not a challenger on record"
            raise GymError(msg)
        if not (event.verdict or {}).get("promote") or not event.manifest_path:
            msg = f"{version_id} did not pass the holdout promotion rule: {(event.verdict or {}).get('reasons')}"
            raise GymError(msg)
        old = registry.champion(root, event.candidate_id)
        if event.parent_sha256 != old.manifest_sha256:
            msg = (
                f"{version_id} was graded against another champion than today's {old.version_id}; run the gym again"
                " so it is graded against the current champion"
            )
            raise GymError(msg)
        manifest = registry.manifest_of(root, event)
        load_prompts(manifest, root)  # every file and the manifest itself hash as recorded (S2 3.3)
        if manifest.sha256 != event.manifest_sha256:
            msg = f"{event.manifest_path} is not the manifest the gym graded"
            raise GymError(msg)
        others = [
            registry.manifest_of(root, v)
            for v in current.values()
            if v.status == "champion" and v.candidate_id != event.candidate_id
        ]
        check_roster([manifest, *others])  # S2 3.3 freeze check: equal budgets, allowlisted models
        done = []
        if register is not None:
            payload = manifest.model_dump(mode="json", exclude={"frozen_at"})
            async with register() as conn:
                uuid = await calls.register_candidate(
                    conn, kind=manifest.kind, name=manifest.candidate_id, version=manifest.version, manifest=payload
                )
            done.append(f"registered in arena.candidates as {uuid}")
        at = registry.now()
        registry.append_versions(
            root,
            [
                old.model_copy(update={"status": "retired", "at": at, "by": by, "metrics": None, "verdict": None}),
                event.model_copy(update={"status": "champion", "at": at, "by": by, "metrics": None, "verdict": None}),
            ],
        )
        return [f"{old.version_id} retired", f"{version_id} is the {event.candidate_id} champion", *done]


def report(root: Path) -> dict[str, Any]:
    return {
        "versions": registry.versions_view(root),
        "pending_lessons": registry.pending_view(root),
        "experiments": registry.experiments_view(root)[:5],
    }
