"""V1 schema, V1b real-agency deny list, V1c relay test, V1d byte budget (S1 9.1).

V1: the family validates against `case-family.schema.json` v1.2 with the three packet schemas resolved
by `$id` (draft 2020-12; AC-S1-01, AC-S1-19).

V1b: no real agency, department or sponsor name anywhere in the file. The deny list is S1 9.1's: the
federal agencies Unissant serves (research X6 Q1: ICE, CBP, USCIS, DHS, TSA, US Marshals Service, DoS,
DoD, US Army, DMDC, OPM, NIH, VA, CMS, NCI, HHS, DHA, NCATS, NHLBI, ACF, FHFA), NARA, GSA, OPM, IRS,
FEMA, the FBI, CIA and NSA, and Unissant itself, each by acronym (any case, except ICE, VA, DoS and CMS,
which are also ordinary words or units and match only as written) and by full name (case-insensitive).

V1.number_form: every number in the S1 schemas is an integer, and JSON Schema's `integer` also accepts
4.0; such a value is refused, since it serializes differently from 4 (a byte difference between variants
would be a role signal, L1).

V1.storage: no U+0000 or lone surrogate anywhere (`arena_core.scenario.storage`), which S4 cannot store.

V1d: the byte budget of S1 9.1 (`arena_core.scenario.content`): each record's content, the releasable
contents of a variant summed, each packet and the family file, as canonical JSON in UTF-8.

V1c: the replay script rendered from the public packet with no releases (S2 8.6), checked in row order
with the repeat rule, and the evidence-slot question of every releasable record (title and, when listed,
date), each through `relay_test.v1` (S2 8.2; AC-S1-27). Slot questions are checked in record order with
the repeat rule as well, since a trial can ask all of them.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from typing import Any

from arena_core.contracts.rendered import TextTooLongError, check_question
from arena_core.scenario.content import budget_overruns
from arena_core.scenario.guardscan import scan_forms
from arena_core.scenario.relay import evidence_slot_question, relay_test, render_replay_script
from arena_core.scenario.schema import family_validator
from arena_core.scenario.storage import unstorable_text
from arena_core.scenario.validators._common import VARIANTS, Family, Issue, Reporter, family_id_of, packets, strings

_AGENCY_ACRONYMS = (
    "ICE",
    "CBP",
    "USCIS",
    "DHS",
    "TSA",
    "USMS",
    "DoS",
    "DoD",
    "DOD",
    "DMDC",
    "OPM",
    "NIH",
    "VA",
    "CMS",
    "NCI",
    "HHS",
    "DHA",
    "NCATS",
    "NHLBI",
    "ACF",
    "FHFA",
    "NARA",
    "GSA",
    "IRS",
    "FEMA",
    "FBI",
    "CIA",
    "NSA",
)
_AGENCY_NAMES = (
    "Unissant",
    "Immigration and Customs",
    "Customs and Border",
    "Citizenship and Immigration Services",
    "Homeland Security",
    "Transportation Security Administration",
    "Marshals Service",
    "U.S. Marshals",
    "US Marshals",
    "Department of State",
    "State Department",
    "Department of Defense",
    "Defense Department",
    "U.S. Army",
    "US Army",
    "United States Army",
    "Defense Manpower Data Center",
    "Office of Personnel Management",
    "National Institutes of Health",
    "Veterans Affairs",
    "Centers for Medicare",
    "National Cancer Institute",
    "Health and Human Services",
    "Defense Health Agency",
    "Advancing Translational Sciences",
    "Heart, Lung, and Blood Institute",
    "Administration for Children and Families",
    "Federal Housing Finance Agency",
    "National Archives",
    "General Services Administration",
    "Internal Revenue Service",
    "Federal Emergency Management Agency",
    "Federal Bureau of Investigation",
    "Central Intelligence Agency",
    "National Security Agency",
)
# Acronyms match in any case ("fema", "Fema"), except those that are also ordinary lowercase words or units
# ("ice", "va", "dos", "cms" for centimetres), which match only as the agency writes them.
_CASE_SENSITIVE_ACRONYMS = frozenset({"ICE", "VA", "DoS", "CMS"})
_ACRONYM_RE = re.compile(
    r"\b(?:" + "|".join(a if a in _CASE_SENSITIVE_ACRONYMS else f"(?i:{a})" for a in _AGENCY_ACRONYMS) + r")\b"
)
_NAME_RE = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(n) for n in _AGENCY_NAMES) + r")(?!\w)", re.IGNORECASE)
_MESSAGE_LIMIT = 300


def real_agency(text: str) -> str | None:
    """The first real agency or sponsor name in `text` as authored or as rendered (`scan_forms`), if any."""
    for form in scan_forms(text):
        found = _ACRONYM_RE.search(form) or _NAME_RE.search(form)
        if found is not None:
            return found.group(0)
    return None


def check_schema(family: object) -> list[Issue]:
    """V1: every JSON Schema error, sorted by path for a stable report."""
    report = Reporter(family_id_of(family))
    errors = sorted(
        family_validator().iter_errors(family), key=lambda e: ([str(p) for p in e.absolute_path], e.message)
    )
    for error in errors:
        path = "/".join(str(p) for p in error.absolute_path)
        report.add("V1.schema", f"{path or '<root>'}: {error.message[:_MESSAGE_LIMIT]}", path=path)
    if errors:  # a schema-invalid file is reported as such; nothing else walks it
        return report.issues
    for path in _float_paths(family):
        report.add("V1.number_form", f"{path}: a number written as a float; the schemas hold integers only", path=path)
    return report.issues


def _float_paths(family: object) -> Iterator[str]:
    """Paths of float values, in document order, without recursion."""
    stack: list[tuple[object, tuple[str, ...]]] = [(family, ())]
    while stack:
        node, at = stack.pop()
        if isinstance(node, float):
            yield "/".join(at) or "<root>"
        elif isinstance(node, Mapping):
            stack.extend((value, (*at, str(key))) for key, value in reversed(list(node.items())))
        elif isinstance(node, list):
            stack.extend((value, (*at, str(index))) for index, value in reversed(list(enumerate(node))))


def check_storage(family: Family) -> list[Issue]:
    """V1.storage (no U+0000 or lone surrogates) and V1d (the byte budget)."""
    report = Reporter(family_id_of(family))
    for problem in unstorable_text(family):
        report.add("V1.storage", problem)
    for rule, message in budget_overruns(family):
        report.add(rule, message)
    return report.issues


def check_real_agencies(family: Family) -> list[Issue]:
    """V1b over every string in the file."""
    report = Reporter(family_id_of(family))
    for text in strings(family):
        name = real_agency(text)
        if name is not None:
            report.add("V1b.real_agency", f"real agency or sponsor name {name!r} in {text[:120]!r}")
    return report.issues


def _slot_records(public: Mapping[str, Any], evaluator: Mapping[str, Any]) -> list[tuple[str, str | None]]:
    dates = {str(r["record_id"]): r.get("date") for r in public["requestable_records"]}
    return [
        (str(a["title"]), dates.get(str(a["artifact_id"])))
        for a in evaluator["evidence_artifacts"]
        if a["release"]["type"] != "initial"
    ]


def _check_committable(report: Reporter, where: str, question: str, variant: str) -> None:
    """V1c.question: every question a trial of this case asks (the opening, the replay rows, the evidence slots)
    is one the runtime commits: 600 characters and 2,400 bytes as rendered (`contracts.rendered.check_question`,
    D11), so an accepted case can always start and replay its trial."""
    try:
        check_question(question)
    except TextTooLongError as exc:
        report.add("V1c.question", f"{where} cannot be committed: {exc}", variant)
    except UnicodeEncodeError:
        # A lone surrogate (V1.storage reports it) has no UTF-8 form, so it has no rendered size either.
        report.add("V1c.question", f"{where} cannot be committed: not encodable as UTF-8", variant)


def check_relay(family: Family) -> list[Issue]:
    """V1c per variant: script rows in order with the repeat rule, then every evidence-slot question."""
    report = Reporter(family_id_of(family))
    for variant in VARIANTS:
        public, _private, evaluator = packets(family, variant)
        asked: list[str] = []
        script = render_replay_script(str(public["opening_question"]), [str(t) for t in public["replay_topics"]])
        for row, question in enumerate(script, start=1):
            result = relay_test(question, asked)
            if not result.passed:
                report.add("V1c.replay_row", f"row {row} fails relay_test.v1 ({result.reason}): {question!r}", variant)
            _check_committable(report, f"row {row}", question, variant)
            asked.append(question)
        for title, date in _slot_records(public, evaluator):
            question = evidence_slot_question(title, date)
            result = relay_test(question, asked)
            if not result.passed:
                report.add(
                    "V1c.evidence_slot", f"slot question fails relay_test.v1 ({result.reason}): {question!r}", variant
                )
            _check_committable(report, "slot question", question, variant)
            asked.append(question)
    return report.issues
