"""Coach Gym dataset shape: dev-only, the fixed holdout, the reference, the coach-visible context, canaries."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from arena_core.coachgym.examples import (
    CANARY_PREFIX,
    HOLDOUT_FILE,
    HiddenSplitError,
    build_examples,
    check_partitions,
    dataset_sha256,
    family_base,
    load_holdout,
    partition,
    read_jsonl,
    with_canaries,
    write_jsonl,
)
from packages.core.tests.coachgym.support import REPO, Spec, trial

HOLDOUT = frozenset({"F03", "F05"})


def test_a_hidden_trial_is_refused_and_nothing_is_built() -> None:
    with pytest.raises(HiddenSplitError, match="hidden"):
        build_examples([trial("truthful"), trial("deceptive", Spec(split="hidden"))], HOLDOUT)


def test_one_example_per_answered_turn_with_the_context_the_card_call_reads() -> None:
    t = trial("deceptive", Spec(turns=4, release_after=2))
    examples = build_examples([t], HOLDOUT)
    assert [e.turn for e in sorted(examples, key=lambda e: e.turn)] == [1, 2, 3, 4]
    by_turn = {e.turn: e for e in examples}
    for n, e in by_turn.items():
        assert [r["turn_no"] for r in e.context["transcript"]] == list(range(1, n + 1))  # never a later turn
        assert e.context["coaching"] == []
        assert e.split == "dev"
        assert e.trial_id == t.trial_id
        assert e.case_id == t.public_packet["case_id"]
    # rec-01 released after 2 exchanges: a card for turn 3 sees it (released before question 3), turn 2's does not.
    assert by_turn[2].context["released_evidence"] == []
    assert [r["record_id"] for r in by_turn[3].context["released_evidence"]] == ["rec-01"]


def test_the_reference_takes_human_labels_first_and_records_disagreements() -> None:
    t = trial("deceptive", Spec(turns=4, evasive=(2, 3), human={2: "genuine_uncertainty", 4: "evasion"}))
    by_turn = {e.turn: e for e in build_examples([t], HOLDOUT)}
    ref = by_turn[4].reference
    assert ref.role == "deceptive"
    assert ref.evasion_turns == (3, 4)  # t02's human label replaces R1's evasion; t04 becomes evasion
    assert ref.labeled_turns == (1, 2, 3, 4)
    assert [(d.turn, d.referee, d.human) for d in ref.disagreements] == [
        (2, "evasion", "genuine_uncertainty"),
        (4, "responsive", "evasion"),
    ]
    assert by_turn[1].reference.disagreements == ()  # only disagreements on turns the card could see
    assert by_turn[1].reference.evasion_turns == ()


def test_holdout_is_whole_families_and_revisions_follow_their_family() -> None:
    examples = build_examples(
        [
            trial("truthful"),
            trial("truthful", Spec(family_code="F03", case_id="C-3333AAAA")),
            trial("deceptive", Spec(family_code="F05.r2")),
        ],
        HOLDOUT,
    )
    assert {e.family for e in partition(examples, "holdout")} == {"F03", "F05"}
    assert {e.family for e in examples if e.partition != "holdout"} == {"F01"}
    assert family_base("F05.r12") == "F05"


def test_identical_inputs_are_kept_once() -> None:
    a = trial("truthful")
    b = trial("truthful")  # a replay trial copying the same transcript of the same variant
    examples = build_examples([a, b], HOLDOUT)
    assert (len(examples), len({e.example_id for e in examples})) == (4, 4)


def test_canaries_are_unpassable_train_examples_with_a_token() -> None:
    base = build_examples([trial("deceptive"), trial("truthful")], HOLDOUT)
    examples = with_canaries(base, count=2)
    canaries = [e for e in examples if e.canary]
    assert [c.partition for c in canaries] == ["train", "train"]
    for c in canaries:
        assert c.partition == "train"
        assert c.reference.canary_token is not None
        assert c.reference.canary_token.startswith(CANARY_PREFIX)
        assert c.reference.evasion_turns == (c.turn + 1,)  # a turn the coach cannot see
        assert c.example_id not in {e.example_id for e in base}
    assert canaries[0].reference.canary_token != canaries[1].reference.canary_token


def test_jsonl_round_trip_and_hash(tmp_path: Path) -> None:
    examples = with_canaries(build_examples([trial("deceptive")], HOLDOUT))
    path = tmp_path / "d.jsonl"
    write_jsonl(path, examples)
    again = read_jsonl(path)
    assert again == examples
    assert dataset_sha256(again, HOLDOUT) == dataset_sha256(examples, HOLDOUT)
    assert dataset_sha256(again, frozenset({"F01"})) != dataset_sha256(examples, HOLDOUT)
    assert check_partitions(again, HOLDOUT) == []


def test_a_dataset_line_claiming_another_split_does_not_parse(tmp_path: Path) -> None:
    example = build_examples([trial("truthful")], HOLDOUT)[0]
    line = json.loads(example.model_dump_json())
    line["split"] = "hidden"
    path = tmp_path / "d.jsonl"
    path.write_text(json.dumps(line) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="dev"):
        read_jsonl(path)


def test_the_committed_holdout_is_a_quarter_of_the_dev_families(tmp_path: Path) -> None:
    holdout = load_holdout(REPO)
    dev = {p.stem for p in (REPO / "cases/dev").glob("F*.json")}
    assert holdout <= dev
    assert len(holdout) == round(len(dev) / 4)
    bad = tmp_path / HOLDOUT_FILE
    bad.parent.mkdir(parents=True)
    bad.write_text('{"families": []}', encoding="utf-8")
    with pytest.raises(ValueError, match="non-empty"):
        load_holdout(tmp_path)


def test_check_partitions_finds_moved_or_edited_examples() -> None:
    examples = with_canaries(build_examples([trial("deceptive"), trial("truthful", Spec(family_code="F03"))], HOLDOUT))
    held = next(e for e in examples if e.partition == "holdout")
    moved = held.model_copy(update={"partition": "train"})
    edited = held.model_copy(update={"reference": held.reference.model_copy(update={"role": "deceptive"})})
    canary = next(e for e in examples if e.canary)
    loose = canary.model_copy(update={"partition": "val"})
    problems = check_partitions([moved, edited, loose], HOLDOUT)
    assert [p.split(" ")[0] for p in problems] == ["example", "example", "canary"]
    assert "not where its family puts it" in problems[0]
    assert "does not hash to its own id" in problems[1]
