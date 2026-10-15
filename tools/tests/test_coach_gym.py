"""`scripts/coach_gym` in fake mode (zero spend): the metered port calls, the GEPA adapter's holdout wall, a whole
gym loop end to end (search, holdout grading, critic, curator, promotion, a second run with an approved lesson)
and the Coach Lab API over the registry it leaves. The dev-only SQL against the real database is
`tools/tests/it_coach_gym.py` (make db-test)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from arena_core.agents.manifests import committed_manifest, load_prompts
from arena_core.coachgym import registry
from arena_core.coachgym.candidate import components
from arena_core.coachgym.examples import Example, build_examples, with_canaries
from arena_core.db.pool import Connector
from arena_core.providers.errors import BudgetRefusedError, ErrorKind, ProviderCallError
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.providers.types import Message, ModelRequest, ThinkingLevel, VertexModel
from arena_core.spend.memory import RunBudget
from packages.core.tests.coachgym.support import (
    MARKER,
    REPO,
    Spec,
    gym_root,
    instruction_with_marker,
    strategic_card,
    trial,
)
from scripts.coach_gym import cli, gym
from scripts.coach_gym.evaluate import BudgetExhaustedError, CardEvaluator, Meter, gather_all, run_metered
from scripts.coach_gym.fake import FAKE_ADDITION, FAKE_GYM_REPLIES, FAKE_LESSON, instruction_reply, lessons_reply
from scripts.coach_gym.optimize import GymAdapter, HoldoutLeakError, OptimizeResult, ReflectionLM
from scripts.coach_gym.reflect import GymLessons, LessonDraft, proposals, reflector_input


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _no_sleep(_s: float) -> None:
    return None


def port(canned: dict[str, Any] | None = None, script: list[Any] | None = None) -> tuple[AgentPort, FakeAdapter]:
    adapter = FakeAdapter(script=list(script or []), canned=canned or FAKE_GYM_REPLIES)
    return AgentPort(adapter, RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep)), adapter


SMART = {**FAKE_GYM_REPLIES, "CoachingCard": strategic_card, "GymInstruction": instruction_with_marker}


def trials() -> list[Any]:
    return [
        trial("deceptive", Spec(case_id="C-AAAA1111", turns=4, evasive=(2, 3))),
        trial("deceptive", Spec(case_id="C-AAAA2222", turns=5, evasive=(3, 4, 5), human={4: "responsive"})),
        trial("truthful", Spec(case_id="C-AAAA3333", turns=4)),
        trial("deceptive", Spec(family_code="F03", case_id="C-BBBB1111", turns=4, evasive=(2, 3))),
        trial("truthful", Spec(family_code="F03", case_id="C-BBBB2222", turns=4)),
    ]


# ---------------------------------------------------------------- meter and metered calls


def test_meter_holds_the_worst_case_and_refuses_past_the_cap() -> None:
    m = Meter(Decimal("1.00"), cap=Decimal("0.60"))
    m.hold(Decimal("0.50"))
    with pytest.raises(BudgetExhaustedError, match="exhausted"):
        m.hold(Decimal("0.20"))
    m.settle(Decimal("0.50"), Decimal("0.05"))
    assert (m.spent, m.held, m.calls, m.remaining) == (Decimal("0.05"), Decimal(0), 1, Decimal("0.55"))
    m.cap = None
    assert m.remaining == Decimal("0.95")


def test_a_failed_card_is_the_candidates_a_budget_refusal_is_systemic(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    prompts = load_prompts(committed_manifest("A1", root), root)
    example = build_examples([trial("truthful")], frozenset())[0]
    bad = ProviderCallError(ErrorKind.BAD_REQUEST, "bad request")
    p, _ = port(script=[bad])
    evaluator = CardEvaluator(p, Meter(Decimal(5)), "gym-t")
    out = run(evaluator.card(prompts, example))
    assert out.card is None
    assert out.error is not None
    assert evaluator.meter.calls == 1
    assert evaluator.meter.spent > 0  # an unknown real cost is counted at its worst case
    assert evaluator.meter.held == 0

    refusing = AgentPort(FakeAdapter(canned=FAKE_GYM_REPLIES), RunBudget(Decimal(0)), PortOptions(sleep=_no_sleep))
    with pytest.raises(BudgetRefusedError):
        run(CardEvaluator(refusing, Meter(Decimal(5)), "gym-t").card(prompts, example))


def test_gather_all_raises_the_first_failure_itself() -> None:
    async def ok() -> int:
        return 1

    async def boom() -> int:
        raise BudgetExhaustedError("x")

    assert run(gather_all([ok(), ok()])) == [1, 1]
    with pytest.raises(BudgetExhaustedError):
        run(gather_all([ok(), boom()]))


def test_run_metered_settles_the_real_cost() -> None:
    p, adapter = port()
    reflection = ReflectionLM(p, Meter(Decimal(5)), "gym-t", run)
    text = "I provided an assistant with the following instructions:\n```\nOld strategy.\n```\nfeedback"
    out = reflection(text)
    assert out == f"```\nOld strategy.\n{FAKE_ADDITION}\n```"
    assert reflection.prompts == [text]
    request = adapter.requests[0]
    assert request.labels == {"app": "unissant-arena"}
    assert reflection.meter.spent == 0  # the fake reports zero tokens
    value, card_run = run(run_metered(p, Meter(Decimal(5)), reflection.call("x" * 50)))
    assert value is not None
    assert card_run.error is None


# ---------------------------------------------------------------- the optimizer's wall around the holdout


def test_the_adapter_refuses_a_holdout_example(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    prompts = load_prompts(committed_manifest("A1", root), root)
    p, _ = port()
    adapter = GymAdapter(CardEvaluator(p, Meter(Decimal(5)), "g"), prompts, "", "1.2.0", run)
    examples = build_examples([trial("deceptive", Spec(family_code="F03"))], frozenset({"F03"}))
    with pytest.raises(HoldoutLeakError):
        adapter.evaluate(examples, {"strategy": "x" * 50})
    with pytest.raises(HoldoutLeakError):
        reflector_input([], examples)


def test_an_oversized_strategy_scores_zero_without_a_call(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    prompts = load_prompts(committed_manifest("A1", root), root)
    p, adapter_calls = port()
    adapter = GymAdapter(CardEvaluator(p, Meter(Decimal(5)), "g"), prompts, "", "1.2.0", run)
    batch = build_examples([trial("truthful")], frozenset())[:2]
    out = adapter.evaluate(batch, {"strategy": "x" * 4_001}, capture_traces=True)
    assert out.scores == [0.0, 0.0]
    assert adapter_calls.requests == []
    records = adapter.make_reflective_dataset({"strategy": "x"}, out, ["strategy"])["strategy"]
    assert "must be 1-4000 characters" in records[0]["Feedback"]


def test_reflector_ids_map_back_and_unknown_ids_drop() -> None:
    examples = build_examples([trial("deceptive", Spec(human={2: "genuine_uncertainty"}))], frozenset())
    shown = reflector_input([], examples)
    [disagreement] = [e for e in examples if e.reference.disagreements and e.turn == e.reference.disagreements[0].turn]
    assert f"[{disagreement.example_id[:16]}]" in shown.text
    assert "the referee labeled it evasion, a human rater labeled it genuine_uncertainty" in shown.text
    drafts = GymLessons(lessons=[LessonDraft(text=FAKE_LESSON, example_ids=[disagreement.example_id[:16], "nope"])])
    [proposal] = proposals(drafts, shown)
    assert proposal.example_ids == (disagreement.example_id,)


# ---------------------------------------------------------------- the whole loop


def _dataset(root: Path) -> list[Example]:
    canary_strings = ["CANARY-bb57c5decc04ccc8"]
    meta = gym.save_dataset(root, trials(), canary_strings)
    assert meta["counts"]["canaries"] == len(["one", "two"])
    assert "C-BBBB1111" in meta["forbidden"]
    return gym.load_dataset(root)[1]


@dataclass(frozen=True)
class FirstRun:
    root: Path
    experiment: registry.Experiment
    adapter: FakeAdapter
    holdout_ids: set[str]
    holdout_cases: set[str]


def _first_run(tmp_path: Path) -> FirstRun:
    root = gym_root(tmp_path)
    examples = _dataset(root)
    p, adapter = port(SMART)
    cfg = gym.RunConfig("gym-run-1", "A1", Decimal(5), "fake", max_evals=80, val_size=24)
    experiment = run(gym.run_gym(cfg, p, root))
    holdout = [e for e in examples if e.partition == "holdout"]
    return FirstRun(root, experiment, adapter, {e.example_id for e in holdout}, {e.case_id for e in holdout})


def test_a_fake_gym_loop_finds_a_better_strategy_that_wins_on_the_holdout(tmp_path: Path) -> None:
    first = _first_run(tmp_path)
    experiment = first.experiment
    assert first.holdout_ids
    assert experiment.verdict == {"promote": True, "reasons": []}
    assert experiment.challenger_id == "A1@1.2.0"
    assert experiment.before is not None
    assert experiment.after is not None
    assert experiment.after["mean_score"] > experiment.before["mean_score"]
    assert experiment.after["false_positive_rate"]["count"] == 0
    # Holdout deceptive trial: evasions at t02 and t03; the fake coach says deceptive on each evasive answer and
    # drops back to insufficient_evidence on the plain t04 answer, so 2 of the 3 cards with an evasion on record.
    assert experiment.after["deceptive_recall"] == {"rate": 0.6667, "count": 2, "of": 3}
    assert experiment.before["deceptive_recall"] == {"rate": 0.0, "count": 0, "of": 3}
    assert experiment.after["canary_passes"] == 0
    assert experiment.series[0]["candidate"] == 0  # the champion's validation score first
    assert max(s["val_score"] for s in experiment.series) > experiment.series[0]["val_score"]
    assert Decimal(experiment.spent_usd) == 0
    card_systems = [r.system for r in first.adapter.requests if r.json_schema.get("title") == "CoachingCard"]
    assert any(MARKER in s for s in card_systems)


def test_no_holdout_example_or_case_reaches_the_optimizer_or_the_critic(tmp_path: Path) -> None:
    first = _first_run(tmp_path)
    titles = ("GymInstruction", "GymLessons")
    reflections = [r.messages[-1].text for r in first.adapter.requests if r.json_schema.get("title") in titles]
    assert reflections
    for text in reflections:
        assert not any(h[:16] in text for h in first.holdout_ids)
        assert not any(c in text for c in first.holdout_cases)
    [pending] = registry.pending_view(first.root)
    assert pending["text"] == FAKE_LESSON
    assert pending["source_run_ids"] == ["gym-run-1"]
    assert not set(pending["source_example_ids"]) & first.holdout_ids


def test_promotion_then_a_second_run_with_an_approved_lesson(tmp_path: Path) -> None:
    first = _first_run(tmp_path)
    root = first.root
    event = registry.current_versions(root)["A1@1.2.0"]
    assert event.status == "challenger"
    manifest = registry.manifest_of(root, event)
    assert manifest.sha256 == event.manifest_sha256
    assert manifest.prompt is not None
    assert MARKER in load_prompts(manifest, root).text(manifest.prompt.assembly["card"][1])

    done = run(gym.promote(root, "A1@1.2.0", "owner"))
    assert done == ["A1@1.1.0 retired", "A1@1.2.0 is the A1 champion"]
    assert registry.champion(root, "A1").version == "1.2.0"
    with pytest.raises(gym.GymError, match="not a challenger"):
        run(gym.promote(root, "A1@1.2.0", "owner"))

    [pending] = registry.pending_view(root)
    registry.review_lesson(root, pending["lesson_id"], "approved", "owner")
    p2, _ = port(SMART)
    second = run(gym.run_gym(gym.RunConfig("gym-run-2", "A1", Decimal(5), "fake", max_evals=40), p2, root))
    assert (second.champion_id, second.challenger_id) == ("A1@1.2.0", "A1@1.3.0")
    assert registry.current_versions(root)["A1@1.3.0"].lesson_ids == (pending["lesson_id"],)
    view = registry.lessons_view(root, "A1@1.3.0")
    assert view is not None
    assert [(x["text"], x["status"]) for x in view["lessons"]] == [(FAKE_LESSON, "approved")]
    assert [e["run_id"] for e in gym.report(root)["experiments"]][:2] == ["gym-run-2", "gym-run-1"]


def test_a_plain_fake_run_finds_nothing_promotable(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    _dataset(root)
    p, _ = port()  # the plain fake card ignores the strategy, so no proposal can beat the champion
    experiment = run(gym.run_gym(gym.RunConfig("gym-plain", "A1", Decimal(5), "fake", max_evals=30), p, root))
    assert experiment.verdict == {
        "promote": False,
        "reasons": ["the search found no strategy or playbook different from the champion's"],
    }
    assert experiment.challenger_id is None
    assert experiment.before is None
    assert registry.version_events(root) == []
    assert len(experiment.series) == 1  # the champion alone


def test_promote_refuses_a_challenger_that_did_not_pass(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    champion = registry.champion(root, "A1")
    lost = champion.model_copy(
        update={
            "version_id": "A1@1.2.0",
            "version": "1.2.0",
            "status": "challenger",
            "manifest_path": "",
            "run_id": "gym-x",
            "verdict": {"promote": False, "reasons": ["no win on the holdout"]},
        }
    )
    registry.append_versions(root, [lost])
    with pytest.raises(gym.GymError, match="did not pass"):
        run(gym.promote(root, "A1@1.2.0", "owner"))


def test_a_budget_too_small_for_the_search_records_why(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    _dataset(root)
    p, _ = port(SMART)
    experiment = run(gym.run_gym(gym.RunConfig("gym-poor", "A1", Decimal("0.05"), "fake", max_evals=30), p, root))
    assert experiment.stop_reason == "the budget ran out before the champion's validation score"
    assert experiment.challenger_id is None
    assert Decimal(experiment.spent_usd) <= Decimal("0.05")


def test_a_holdout_the_budget_cannot_cover_is_not_promoted(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    examples = _dataset(root)
    meta, _ = gym.load_dataset(root)
    p, _ = port(SMART)
    champ = gym.Champion.load(root, "A1")
    cfg = gym.RunConfig("gym-h", "A1", Decimal("0.01"), "fake")
    ctx = gym.Ctx(cfg, p, CardEvaluator(p, Meter(Decimal("0.01")), "gym-h"), root, meta, examples, champ)
    strategy = components(champ.prompts)["strategy"] + "\n" + MARKER
    outcome = run(gym._judge(ctx, OptimizeResult(strategy, [], "max_evals")))
    assert outcome.holdout is None
    assert outcome.verdict.reasons == ("the budget ran out before the holdout was graded",)
    assert outcome.stop_reason == "budget (holdout incomplete)"
    assert outcome.challenger is not None


def test_load_dataset_refuses_a_missing_or_altered_file(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    with pytest.raises(gym.GymError, match="coach-gym-dataset"):
        gym.load_dataset(root)
    _dataset(root)
    meta = json.loads((root / gym.RUN_DIR / gym.LATEST).read_text(encoding="utf-8"))
    data = root / meta["path"]
    data.write_text("".join(data.read_text(encoding="utf-8").splitlines(keepends=True)[1:]), encoding="utf-8")
    with pytest.raises(gym.GymError, match="does not hash"):
        gym.load_dataset(root)


# ---------------------------------------------------------------- promotion registers through the owner-run path


class _Cur:
    async def fetchone(self) -> tuple[UUID]:
        return (UUID(int=7),)


class _Conn:
    def __init__(self, calls: list[tuple[str, tuple[Any, ...]]]) -> None:
        self.calls = calls

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        yield

    async def execute(self, query: str, params: tuple[Any, ...]) -> _Cur:
        self.calls.append((query, params))
        return _Cur()


def test_promote_registers_the_frozen_manifest_when_asked(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    _dataset(root)
    p, _ = port(SMART)
    run(gym.run_gym(gym.RunConfig("gym-reg", "A1", Decimal(5), "fake", max_evals=80), p, root))
    calls: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def connect() -> AsyncIterator[Any]:
        yield _Conn(calls)

    done = run(gym.promote(root, "A1@1.2.0", "owner", register=connect))
    assert done[-1] == f"registered in arena.candidates as {UUID(int=7)}"
    [(query, params)] = calls
    assert query.startswith("select arena.register_candidate(")
    assert params[:3] == ("assistant", "A1", "1.2.0")


def test_promote_refuses_a_tampered_manifest(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    _dataset(root)
    p, _ = port(SMART)
    run(gym.run_gym(gym.RunConfig("gym-tamper", "A1", Decimal(5), "fake", max_evals=80), p, root))
    event = registry.current_versions(root)["A1@1.2.0"]
    path = root / event.manifest_path
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["display_name"] = "Tampered"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(Exception, match="manifest"):
        run(gym.promote(root, "A1@1.2.0", "owner"))
    assert registry.champion(root, "A1").version == "1.1.0"


# ---------------------------------------------------------------- the command line


def test_cli_report_lessons_and_refusals(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = gym_root(tmp_path)
    assert cli.main(["report"], env={}, root=root) == 0
    report = json.loads(capsys.readouterr().out)
    assert [v["id"] for v in report["versions"]] == ["A1@1.1.0", "A2@1.1.0", "A3@1.1.0"]
    assert cli.main(["run", "--budget", "0"], env={}, root=root) == 1
    assert "more than $0" in capsys.readouterr().err
    assert cli.main(["run", "--budget", "21"], env={}, root=root) == 1
    assert cli.main(["run", "--budget", "ten"], env={}, root=root) == 1
    assert "not a number" in capsys.readouterr().err
    assert cli.main(["run", "--budget", "1"], env={"ARENA_MODEL_MODE": "fake"}, root=root) == 1
    assert "ARENA_REFEREE_DSN is not set" in capsys.readouterr().err
    assert cli.main(["dataset"], env={}, root=root) == 1
    assert cli.main(["promote", "--version", "A1@9.0.0", "--by", "o"], env={}, root=root) == 1
    assert "not a challenger" in capsys.readouterr().err
    assert cli.main(["lessons"], env={}, root=root) == 0
    assert json.loads(capsys.readouterr().out) == []
    assert cli.main(["lessons", "--approve", "x", "--reject", "y"], env={}, root=root) == 1
    assert cli.main(["lessons", "--approve", "0" * 16, "--by", "o"], env={}, root=root) == 1


def test_cli_run_and_lesson_review_in_fake_mode(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    root = gym_root(tmp_path)
    _dataset(root)
    monkeypatch.setattr(cli, "DbSpendGuard", lambda _connect: RunBudget(Decimal(100)))
    env = {"ARENA_MODEL_MODE": "fake", "ARENA_REFEREE_DSN": "postgresql://unused.invalid/x"}
    assert cli.main(["run", "--budget", "2", "--max-evals", "20"], env=env, root=root) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["mode"] == "fake"
    assert out["run_id"].startswith("gym-")
    [pending] = registry.pending_view(root)
    assert cli.main(["lessons", "--reject", pending["lesson_id"], "--by", "owner"], env={}, root=root) == 0
    assert json.loads(capsys.readouterr().out) == {"lesson_id": pending["lesson_id"], "status": "rejected"}


def test_cli_dataset_never_prints_the_reference_only_strings(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    root = gym_root(tmp_path)

    async def build(_connect: Connector, at: Path, phoenix: object) -> dict[str, object]:
        assert (at, phoenix) == (root, None)
        return {"sha256": "c" * 64, "counts": {"train": 1}, "forbidden": ["C-7Q2MXK4D", "CANARY-1"]}

    monkeypatch.setattr(gym, "build_dataset", build)
    env = {"ARENA_REFEREE_DSN": "postgresql://unused.invalid/x"}
    assert cli.main(["dataset"], env=env, root=root) == 0
    out = capsys.readouterr().out
    assert json.loads(out) == {"sha256": "c" * 64, "counts": {"train": 1}}
    assert "C-7Q2MXK4D" not in out


def test_fake_replies_are_schema_shaped() -> None:
    def req(text: str) -> ModelRequest:
        return ModelRequest(
            model=VertexModel.FLASH_LITE_35,
            system="s",
            messages=(Message("user", text),),
            json_schema={},
            max_output_tokens=10,
            thinking=ThinkingLevel.MINIMAL,
            seed=1,
        )

    assert json.loads(instruction_reply(req("no fences")))["instruction"] == FAKE_ADDITION
    assert json.loads(lessons_reply(req("nothing shown"))) == {"lessons": []}
    shown = json.loads(lessons_reply(req(f"[{'a' * 16}] exchange 2")))
    assert shown["lessons"][0]["example_ids"] == ["a" * 16]


def test_forbidden_strings_cover_case_ids_canaries_and_tokens() -> None:
    examples = with_canaries(build_examples([trial("deceptive", Spec(case_id="C-ZZZZ9999"))], frozenset()))
    out = gym.forbidden_strings(examples, ["CANARY-1"])
    assert "C-ZZZZ9999" in out
    assert "CANARY-1" in out
    assert any(s.startswith("CANARY-GYM-") for s in out)


def test_the_repo_holdout_and_registry_are_readable() -> None:
    assert registry.versions_view(REPO)  # the committed coachlab/ parses (the API serves it)
