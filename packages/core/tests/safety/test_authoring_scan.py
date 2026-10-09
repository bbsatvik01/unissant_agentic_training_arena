"""S2 AT-SUBJ-8 and S1 AC-S1-13 (guard scan): G3-G5 over every case-specific text field of every dev packet.

The scope is the one S1's V4c uses (`subject_renderable_text`: identifier and enum fields and the platform paths
excluded); the control run adds the EX-4 `ground_rules`, which hit G4 once per public packet on "simulated".
"""

from __future__ import annotations

import pytest

from arena_core.safety import guard
from arena_core.scenario.load import read_family_file
from arena_core.scenario.validators.v4 import subject_renderable_text

from .conftest import SPEC_S2

DEV_IDS = ("F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09")
CASES_DIR = SPEC_S2.parents[2] / "cases" / "dev"
LEXICAL = {"G3", "G4", "G5"}


def _lexical_hit(text: str) -> str | None:
    result = guard.check_utterance(text, guard.RecitalIndex.empty())
    return result.rule if result.rule in LEXICAL else None


@pytest.mark.parametrize("family_id", DEV_IDS)
@pytest.mark.parametrize("variant", ["truthful", "deceptive"])
def test_case_specific_text_has_no_g3_to_g5_hit(family_id: str, variant: str) -> None:
    packets = read_family_file(CASES_DIR / f"{family_id}.json")["variants"][variant]
    texts = subject_renderable_text(packets["public_packet"], packets["private_packet"], packets["evaluator_packet"])
    assert texts
    assert [(t[:80], r) for t in texts if (r := _lexical_hit(t))] == []


@pytest.mark.parametrize("family_id", DEV_IDS)
def test_the_control_run_with_ground_rules_reports_the_expected_g4_hit(family_id: str) -> None:
    public = read_family_file(CASES_DIR / f"{family_id}.json")["variants"]["truthful"]["public_packet"]
    hits = [(r, t) for t in public["ground_rules"] if (r := _lexical_hit(t))]
    assert len(hits) == 1
    assert hits[0][0] == "G4"
    assert "simulated" in hits[0][1].lower()
