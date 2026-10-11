"""S2 4.4 `demeanor_lexicon.v1`: spec parity, matching rules and the FX-DEM-NEUTRAL tuning set."""

from __future__ import annotations

import pytest

from arena_core import fixtures
from arena_core.safety import demeanor

from .conftest import spec_section

ZWSP = chr(0x200B)
DEM_NEUTRAL_SIZE = 60  # S2 11.1: 60 neutral dev claims


def spec_terms() -> list[str]:
    row = next(line for line in spec_section("4.4").splitlines() if line.startswith("| Demeanor lexicon |"))
    listed = row.split("`demeanor_lexicon.v1`:", 1)[1].split("|", 1)[0]
    return [t.strip() for t in listed.split(",")]


def test_the_lexicon_is_s2_4_4_exactly() -> None:
    assert list(demeanor.DEMEANOR_LEXICON) == spec_terms()


@pytest.mark.parametrize("term", demeanor.DEMEANOR_LEXICON)
def test_every_term_is_caught_in_a_claim(term: str) -> None:
    assert demeanor.is_demeanor_based(f"The subject was {term.upper()} when asked about the door.")


def test_whole_words_only() -> None:
    assert demeanor.demeanor_terms("The accentuated wording and the grammarian's notes") == []
    assert demeanor.demeanor_terms("An unemotional, nondefensive summary.") == []
    assert demeanor.demeanor_terms("He stood by the defensive line.") == ["defensive"]
    assert demeanor.demeanor_terms("Hesitation, then silence.") == ["hesitation"]


def test_phrases_match_across_spacing_and_the_longest_term_is_reported() -> None:
    assert demeanor.demeanor_terms("She avoided eye\n contact.") == ["eye contact"]
    assert demeanor.demeanor_terms("He sounded nervous at t03.") == ["sounded nervous"]


def test_disguises_do_not_hide_a_term() -> None:
    assert demeanor.demeanor_terms(f"ner{ZWSP}vous") == ["nervous"]
    fullwidth = "".join(chr(0xFF00 + ord(c) - 0x20) for c in "anxious")
    assert demeanor.demeanor_terms(f"Seemed {fullwidth}.") == ["anxious"]


def test_fx_dem_neutral_has_sixty_claims_and_no_hit() -> None:
    claims = fixtures.load("fx_dem_neutral")["claims"]
    assert len(claims) == len(set(claims)) == DEM_NEUTRAL_SIZE
    assert [c for c in claims if demeanor.is_demeanor_based(c)] == []
