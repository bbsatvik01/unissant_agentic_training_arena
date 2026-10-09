"""The EVL-8 decision tree (S3 3.3), in its order: J1 Part 1 asks the same questions (S2 7.2, C-10)."""

from __future__ import annotations

LABELS = ("evasion", "genuine_uncertainty", "legitimate_non_disclosure", "poorly_framed_question", "responsive")


def tree_label(framing_prevented: bool, limit_signaled: bool, item_given: bool, listed_non_disclosable: bool) -> str:
    """PFQ first, so a compound question penalizes the asker; UNC before RSP, so an approximation within an
    uncertainty entry is not responsive (SG2-16)."""
    if framing_prevented:
        return "poorly_framed_question"
    if limit_signaled:
        return "genuine_uncertainty"
    if item_given:
        return "responsive"
    if listed_non_disclosable:
        return "legitimate_non_disclosure"
    return "evasion"
