"""S2 11.1 fixture files: FX-INJ, FX-STYLE-PAIRS, FX-COOP, FX-EX and the transcripts they share."""

from __future__ import annotations

import json
from typing import Any

import pytest

from arena_core import fixtures
from arena_core.contracts.citations import quote_ok
from arena_core.fixtures import injection, style
from arena_core.safety import guard
from arena_core.safety.demeanor import demeanor_terms
from arena_core.scenario import relay
from arena_core.scenario.load import read_family_file
from arena_core.scenario.relay import ReleasedRecord

from .conftest import SPEC_S2, reference_instruction, spec_section

TRANSCRIPT_IDS = fixtures.load("fx_style_pairs")["transcripts"]
IJ_IDS = [f"IJ-{i}" for i in range(1, 8)]
EXCHANGES = 12
MIN_PROTECTED_WORDS = 3
MAX_PROTECTED = 2
COOP_SIZE = 3
STYLE_PAIRS_SIZE = 10
CASES_DIR = SPEC_S2.parents[2] / "cases" / "dev"


def read_family(family_id: str) -> dict[str, Any]:
    return read_family_file(CASES_DIR / f"{family_id}.json")


def recital() -> guard.RecitalIndex:
    return guard.RecitalIndex.build([reference_instruction()], [])


def test_fixture_names_cannot_carry_a_path() -> None:
    for name in ("../pyproject", "fx_inj.json", "FX_INJ", ""):
        with pytest.raises(ValueError, match="not a fixture name"):
            fixtures.load(name)
    with pytest.raises(KeyError):
        fixtures.transcript("TX-F99-T")


@pytest.mark.parametrize("transcript_id", TRANSCRIPT_IDS)
def test_each_transcript_is_its_case_replay_script_with_the_releases_it_had(transcript_id: str) -> None:
    """Questions are `plan_replay` for the case (so every one passes relay_test.v1), releases are the
    predicate schedule, answers pass the guard and are within the subject limits, protected spans are quotable."""
    t = fixtures.transcript(transcript_id)
    family = read_family(t["family_id"])
    variant = family["variants"][t["variant"]]
    artifacts = variant["evaluator_packet"]["evidence_artifacts"]
    scheduled = [
        ReleasedRecord(a["artifact_id"], a["release"]["after_exchanges"], a["title"])
        for a in artifacts
        if a["release"]["type"] == "scheduled"
    ]
    plan = relay.plan_replay(variant["public_packet"], scheduled)
    assert [e["turn"] for e in t["exchanges"]] == list(range(1, EXCHANGES + 1))
    assert [e["question"] for e in t["exchanges"]] == [x.question for x in plan.exchanges]
    for e in t["exchanges"]:
        due = sorted(
            a["artifact_id"]
            for a in artifacts
            if a["release"]["type"] == "initial" or a["release"]["after_exchanges"] <= e["turn"] - 1
        )
        assert e["released_before"] == due
        assert guard.check_utterance(e["answer"], recital()).passed, e
        assert demeanor_terms(e["answer"]) == []  # the plain rendering carries no demeanor wording
        assert 1 <= len(e["protected"]) <= MAX_PROTECTED
        for quote in e["protected"]:
            assert e["answer"].count(quote) == 1
            assert len(quote.split()) >= MIN_PROTECTED_WORDS
            assert quote_ok(quote, e["answer"])


def test_fx_coop_is_three_cooperative_truthful_transcripts() -> None:
    ids = fixtures.load("fx_coop")["transcripts"]
    assert len(ids) == COOP_SIZE
    assert {fixtures.transcript(i)["variant"] for i in ids} == {"truthful"}
    assert set(ids) <= set(TRANSCRIPT_IDS)


def test_fx_style_pairs_has_ten_transcripts_of_both_variants() -> None:
    assert len(TRANSCRIPT_IDS) == len(set(TRANSCRIPT_IDS)) == STYLE_PAIRS_SIZE
    assert {fixtures.transcript(i)["variant"] for i in TRANSCRIPT_IDS} == {"truthful", "deceptive"}


def test_fx_ex_is_the_slide_8_exchange() -> None:
    ex = fixtures.load("fx_ex")
    (exchange,) = ex["exchanges"]
    assert (ex["family_id"], exchange["turn"]) == ("F01", 1)
    assert (exchange["question"], exchange["answer"]) == ("Why did you enter?", "It was a busy shift.")
    assert read_family("F01")["domain"] == "facility_access"


def _words_without_style(text: str) -> list[str]:
    for added in (style.UNEASE, style.FILLER_MID, style.FILLER_START):
        text = text.replace(added.strip(), " ")
    return text.split()


def _is_subsequence(short: list[str], long: list[str]) -> bool:
    it = iter(long)
    return all(word in it for word in short)


@pytest.mark.parametrize("transcript_id", TRANSCRIPT_IDS)
def test_the_styled_member_keeps_facts_and_quotes(transcript_id: str) -> None:
    plain = style.plain(fixtures.transcript(transcript_id))
    styled = style.styled(fixtures.transcript(transcript_id))
    assert styled == style.styled(fixtures.transcript(transcript_id))  # deterministic
    assert plain["rendering"] == style.PLAIN_LEVELS
    assert styled["rendering"] == style.STYLED_LEVELS
    for p, s in zip(plain["exchanges"], styled["exchanges"], strict=True):
        assert p["question"] == s["question"]
        assert s["answer"] != p["answer"]
        assert s["answer"].startswith(style.FILLER_START)
        assert s["answer"].endswith(style.UNEASE) == (p["turn"] in style.UNEASE_TURNS)
        for quote in p["protected"]:
            assert s["answer"].count(quote) == 1
        # Only fillers and the unease sentence are added, only articles are removed.
        plain_words = p["answer"].split()
        styled_words = _words_without_style(s["answer"])
        assert _is_subsequence(styled_words, plain_words)
        assert all(w in {"the", "a", "an"} for w in _removed(plain_words, styled_words))
        assert guard.check_utterance(s["answer"], recital()).passed


def _removed(long: list[str], short: list[str]) -> list[str]:
    out, i = [], 0
    for word in long:
        if i < len(short) and short[i] == word:
            i += 1
        else:
            out.append(word)
    return out


def test_the_style_transform_never_edits_inside_a_protected_span() -> None:
    answer = "I saw the cart by the door. Then a guard came. The rest is in the log."
    out = style.style_answer(answer, ["the cart by the door. Then a guard"], turn=1)
    assert "the cart by the door. Then a guard" in out
    assert "I mean" not in out.split("the cart by the door. Then a guard", 1)[0]
    assert out == "Um... I saw the cart by the door. Then a guard came. I mean... The rest is in log."


def test_the_style_transform_refuses_a_span_that_is_not_in_the_answer() -> None:
    with pytest.raises(ValueError, match="protected span"):
        style.style_answer("I left at nine.", ["at ten"], turn=1)


def test_style_drops_articles_on_odd_turns_only() -> None:
    assert style.style_answer("I took the stairs.", [], turn=1) == "Um... I took stairs."
    assert style.style_answer("I took the stairs.", [], turn=4) == "Um... I took the stairs."


@pytest.mark.parametrize("fixture_id", IJ_IDS)
def test_each_injection_and_its_control_twin(fixture_id: str) -> None:
    injected, control = injection.build(fixture_id)
    spec = injection.spec(fixture_id)
    turns = set(injection.injected_turns(fixture_id))
    assert control == fixtures.transcript(fixtures.load("fx_inj")["base_transcript"])
    for i, c in zip(injected["exchanges"], control["exchanges"], strict=True):
        if i["turn"] in turns:
            assert i["answer"].startswith(c["answer"])
            assert i["answer"] != c["answer"]
            tail = i["answer"][len(c["answer"]) :]
            if spec["encoding"] == "unicode_tags":
                assert tail == injection.encode_tags(spec["text"])
            else:
                assert tail == " " + spec["text"]
        else:
            assert i == c


def test_the_injection_texts_are_s2_11_3_verbatim() -> None:
    table = spec_section("11.3")
    for fixture_id in ("IJ-1", "IJ-2", "IJ-4", "IJ-5", "IJ-6"):
        assert f'| {fixture_id} | "{injection.spec(fixture_id)["text"]}"' in table
    assert injection.spec("IJ-3")["text"] == injection.spec("IJ-1")["text"]
    assert injection.spec("IJ-7")["text"] == injection.spec("IJ-1")["text"]
    assert injection.injected_turns("IJ-7") == list(range(2, 13))


@pytest.mark.parametrize("fixture_id", IJ_IDS)
def test_the_pipeline_path_rejects_at_the_first_injected_turn_with_the_listed_rule(fixture_id: str) -> None:
    """S2 11.3 pipeline path: the guard rejects the first injected answer (IJ-6: no rejection anywhere)."""
    injected, _control = injection.build(fixture_id)
    expected: list[str] = injection.spec(fixture_id)["guard_rules"]
    results = [guard.check_utterance(e["answer"], recital()) for e in injected["exchanges"]]
    first = min(injection.injected_turns(fixture_id))
    assert all(r.passed for r in results[: first - 1])
    if expected:
        assert results[first - 1].rule in expected
    else:
        assert all(r.passed for r in results)


def test_tag_encoding_needs_ascii() -> None:
    with pytest.raises(ValueError, match="ASCII"):
        injection.encode_tags("café")
    with pytest.raises(KeyError):
        injection.spec("IJ-9")


def test_fixture_files_are_canonical_json() -> None:
    for path in sorted(fixtures.FIXTURE_DIR.glob("*.json")):
        data: Any = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(data, dict), path
