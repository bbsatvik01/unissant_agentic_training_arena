"""Coach prompt builder: card, deep update and final finding (S2 5; AT-COACH-1..3).

`build_coach_prompt(view, prompts, call)` takes the trial as a `PublicTrialView` only (S5 1.2 item 3; refused at
runtime too), and the candidate's verified prompt texts (`manifests.load_prompts`). The system instruction is the
manifest's assembly for the call kind, the files joined by one blank line (S2 3.1); the user message is the
candidate's user template with every data block in its salted untrusted tag and the task sentence last (S2 1,
Prompt assembly order). The salt is fresh per call unless a test fixes it, and is never part of the output.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from arena_core.agents.manifests import PromptSet
from arena_core.agents.render import NONE, case_values, flag_line, released_records, transcript
from arena_core.agents.templates import join_blocks, render, require
from arena_core.agents.untrusted import check_salt, clean, new_salt
from arena_core.agents.views import CoachCall, EarlierOutput, PublicTrialView
from arena_core.contracts.coaching import StoredDeepUpdate
from arena_core.contracts.common import turn_id
from arena_core.contracts.findings import StoredFinding


@dataclass(frozen=True)
class Prompt:
    """One rendered request: the system instruction and the user message. The salt is kept for the caller's
    output check; neither it nor the salted text appears in a repr (S2 1: never written to any output, span or
    log), so logging a prompt object shows only its sizes."""

    system_instruction: str = field(repr=False)
    user_message: str = field(repr=False)
    salt: str = field(repr=False)

    def __repr__(self) -> str:
        sizes = f"system_instruction={len(self.system_instruction)} chars, user_message={len(self.user_message)} chars"
        return f"Prompt({sizes})"


def _numbers(values: list[int]) -> str:
    return ", ".join(str(v) for v in values) or NONE


def _ids(values: list[str]) -> str:
    return ", ".join(values) or NONE


def running_finding(finding: StoredFinding | None) -> str:
    """S2 5.4: the candidate's last valid running finding, three lines."""
    if finding is None:
        return "Running finding: none"
    revised = turn_id(finding.last_revised_turn) if finding.last_revised_turn is not None else NONE
    corroboration = "; ".join(clean(c) for c in finding.corroboration_needed) or NONE
    return (
        f"Running finding: {finding.label}, {finding.likelihood}, confidence {finding.confidence}, "
        f"cited turns {_numbers(finding.cited_turns)}, cited records {_ids(finding.cited_records)}, "
        f"basis {_ids(finding.basis_flag_refs)}, last revised {revised}\n"
        f"Rationale: {clean(finding.rationale)}\n"
        f"Corroboration needed: {corroboration}"
    )


def deep_update(update: StoredDeepUpdate | None) -> str:
    """A1's latest deep update (S2 4.6, 5.4): coverage, open gaps and plan."""
    if update is None:
        return NONE
    coverage = "; ".join(f"{c.record_id} {c.status} ({_ids(c.turn_ids)})" for c in update.evidence_coverage)
    gaps = "; ".join(f"{clean(g.missing_fact)} (first seen {g.first_seen_turn})" for g in update.open_gaps)
    plan = f"{update.disclosure_plan.record_id or 'no record'} {update.disclosure_plan.step}"
    return f"as of {update.as_of_turn}\nCoverage: {coverage or NONE}\nOpen gaps: {gaps or NONE}\nPlan: {plan}"


def earlier_values(earlier: EarlierOutput) -> dict[str, str]:
    flags = "\n".join(flag_line(f) for f in earlier.flags)
    return {
        "running_finding": running_finding(earlier.running_finding),
        "flags": f"Flags:\n{flags}" if flags else "Flags: none",
        "deep_update": f"Latest deep update: {deep_update(earlier.deep_update)}",
    }


def build_coach_prompt(view: PublicTrialView, prompts: PromptSet, call: CoachCall, salt: str | None = None) -> Prompt:
    """The `card`, `deep` or `final` request of one coach for one trial (S2 5.2-5.4)."""
    view = require(view, PublicTrialView, "coach prompt builder (S5 1.2)")
    if view.call != call:
        msg = f"the view was built for the {view.call} call, not {call} (S2 4.4.1 visibility differs)"
        raise ValueError(msg)
    salt = check_salt(salt or new_salt())
    values = {
        "n": str(view.exchange),
        "turn": turn_id(view.exchange),
        "salt": salt,
        **case_values(view.case),
        "released_records": released_records(view.released),
        "transcript": transcript(view.transcript),
        **earlier_values(view.earlier),
    }
    system = join_blocks(prompts.assembly(call))
    user = render(prompts.user_template(f"user.{call}.v1.txt"), values)
    return Prompt(system_instruction=system, user_message=user, salt=salt)
