"""`arena_core.events.projections.tournament_frames` (S5 6.2; S6 4.9, 5.3): ledger rows projected into the
tournament poll's wire frames, the properties `GET /api/tournaments/{id}/events?after=` depends on -- never a
frame object leaves the module (S5 1.2 item 2), a replay-corpus row and a trial-scope event stay out, and the
returned cursor always lands on a row this call actually consumed."""

from __future__ import annotations

from uuid import uuid4

import pytest
from pydantic import ValidationError

from arena_core.events.projections import LedgerRow, tournament_frames

TOURNAMENT = str(uuid4())
TS = "2026-10-12T00:00:00.000Z"


def status_row(seq: int, event_type: str) -> LedgerRow:
    """A tournament-level row: no `trial_id`, no joined trial of its own."""
    return LedgerRow(seq=seq, event_type=event_type, trial_id=None, created_at=TS, payload={})


@pytest.mark.parametrize(
    ("event_type", "state"),
    [
        ("tournament_created", "draft"),
        ("roster_frozen", "frozen"),
        ("tournament_running", "running"),
        ("tournament_sealed", "sealed"),
        ("tournament_scoring", "scoring"),
        ("tournament_revealed", "revealed"),
    ],
)
def test_every_lifecycle_event_becomes_tournament_status(event_type: str, state: str) -> None:
    frames, last = tournament_frames([status_row(1, event_type)], TOURNAMENT)
    assert [f["type"] for f in frames] == ["tournament.status"]
    assert frames[0]["data"] == {"state": state}
    assert frames[0]["scope_id"] == TOURNAMENT
    assert last == 1


def test_trial_started_on_the_interactive_track_carries_its_pairing_and_block() -> None:
    trial = str(uuid4())
    source = LedgerRow(
        seq=5,
        event_type="trial_started",
        trial_id=trial,
        created_at=TS,
        payload={},
        trial_ref=3,
        track="interactive",
        block=2,
        pairing="A1 x S1",
    )
    frames, last = tournament_frames([source], TOURNAMENT)
    assert frames[0]["type"] == "trial.started"
    assert frames[0]["data"] == {
        "trial_ref": 3,
        "trial_id": trial,
        "pairing": "A1 x S1",
        "track": "interactive",
        "block": 2,
    }
    assert last == source.seq


def test_trial_started_on_the_replay_track_has_no_block() -> None:
    trial = str(uuid4())
    source = LedgerRow(
        seq=1,
        event_type="trial_started",
        trial_id=trial,
        created_at=TS,
        payload={},
        trial_ref=1,
        track="replay",
        block=None,
        pairing="A1 x S1",
    )
    frames, _ = tournament_frames([source], TOURNAMENT)
    assert frames[0]["data"]["block"] is None
    assert frames[0]["data"]["track"] == "replay"


def test_replay_turn_finalized_and_execution_map_their_own_payload_field() -> None:
    """A completed trial's own `trial_finalized` payload already carries `state: "completed"` (S4
    `arena.finalize_trial`'s own success append, never a separate `execution_recorded` row for it) -- the
    matrix needs that state exactly as it needs every other terminal one, so this maps to both a
    `trial.execution` and a `trial.finalized` frame, not finalized alone."""
    rows = [
        LedgerRow(
            seq=1,
            event_type="replay_turn_copied",
            trial_id=None,
            created_at=TS,
            payload={"turn_no": 4},
            trial_ref=1,
            track="replay",
        ),
        LedgerRow(
            seq=2,
            event_type="trial_finalized",
            trial_id=None,
            created_at=TS,
            payload={"commitment_sha256": "c" * 64, "state": "completed"},
            trial_ref=1,
            track="replay",
        ),
        LedgerRow(
            seq=3,
            event_type="execution_recorded",
            trial_id=None,
            created_at=TS,
            payload={"state": "budget_skipped"},
            trial_ref=2,
            track="replay",
        ),
    ]
    frames, last = tournament_frames(rows, TOURNAMENT)
    assert [f["type"] for f in frames] == ["replay.turn", "trial.execution", "trial.finalized", "trial.execution"]
    assert frames[0]["data"] == {"trial_ref": 1, "turn_no": 4}
    assert frames[1]["data"] == {"trial_ref": 1, "state": "completed"}
    assert frames[2]["data"] == {"trial_ref": 1, "commitment_hash": "c" * 64}
    assert frames[3]["data"] == {"trial_ref": 2, "state": "budget_skipped"}
    assert last == rows[-1].seq


def test_a_never_started_trial_still_opens_its_own_matrix_cell() -> None:
    """S4 `arena.start_trial`'s early return and `record_execution_failure` from `planned` (EF-01, EF-09)
    write no `trial_started` row for a `budget_skipped` or `source_unavailable` attempt -- its own
    `execution_recorded` row is the only one it will ever contribute, so that row must also open the matrix
    cell the client's `trial.started`-gated reducer needs (S6 4.9), synthesized from the same row."""
    trial = str(uuid4())
    seq = 9
    row = LedgerRow(
        seq=seq,
        event_type="execution_recorded",
        trial_id=trial,
        created_at=TS,
        payload={"state": "source_unavailable"},
        trial_ref=4,
        track="replay",
        pairing="A2 x S3",
        never_started=True,
    )
    frames, last = tournament_frames([row], TOURNAMENT)
    assert [f["type"] for f in frames] == ["trial.started", "trial.execution"]
    assert frames[0]["data"] == {
        "trial_ref": 4,
        "trial_id": trial,
        "pairing": "A2 x S3",
        "track": "replay",
        "block": None,
    }
    assert frames[1]["data"] == {"trial_ref": 4, "state": "source_unavailable"}
    assert last == seq


def test_a_trial_that_really_started_gets_no_synthetic_second_start() -> None:
    """The common case (`never_started` false): its own real `trial_started` row already opened the cell,
    so its terminal row carries only the execution-state frame, never a duplicate `trial.started`."""
    row = LedgerRow(
        seq=9,
        event_type="execution_recorded",
        trial_id=None,
        created_at=TS,
        payload={"state": "infra_failed"},
        trial_ref=4,
        track="interactive",
        never_started=False,
    )
    frames, _ = tournament_frames([row], TOURNAMENT)
    assert [f["type"] for f in frames] == ["trial.execution"]


def test_a_rows_two_frames_are_never_split_across_a_page() -> None:
    """A `trial_finalized` row's own two frames (execution then finalized) are built together or not at
    all: a page limit that would fit only the first leaves the whole row for the next call."""
    row = LedgerRow(
        seq=5,
        event_type="trial_finalized",
        trial_id=None,
        created_at=TS,
        payload={"commitment_sha256": "d" * 64, "state": "completed"},
        trial_ref=1,
        track="replay",
    )
    frames, last = tournament_frames([row], TOURNAMENT, limit=1)
    assert frames == []
    assert last == 0  # the row is deferred whole; the cursor never advances past it


def test_a_replay_corpus_trial_produces_no_frame_at_all() -> None:
    """S6 4.9: the corpus producer stays internal; it is visible only as progress counts, dev split or
    revealed alike -- never a `trial.started` or any other wire frame."""
    trial = str(uuid4())
    rows = [
        LedgerRow(
            seq=1,
            event_type="trial_started",
            trial_id=trial,
            created_at=TS,
            payload={},
            trial_ref=1,
            track="replay_corpus",
            pairing=None,
        ),
        LedgerRow(
            seq=2,
            event_type="execution_recorded",
            trial_id=None,
            created_at=TS,
            payload={"state": "completed"},
            trial_ref=1,
            track="replay_corpus",
        ),
    ]
    frames, last = tournament_frames(rows, TOURNAMENT)
    assert frames == []
    assert last == rows[-1].seq  # both rows are still consumed (never re-read), just framed into nothing


def test_a_trial_scope_event_this_tournament_trial_also_wrote_is_skipped_but_still_advances_the_cursor() -> None:
    """`question_asked`, `evidence_released` and `subject_answered` carry the same `tournament_id` as the
    tournament's other events (S4's `ledger.append_event` sets it for every trial of the tournament), but S6
    5.3 names no tournament-scope wire type for them."""
    scoped = ("question_asked", "evidence_released", "subject_answered", "trial_retry", "validity_adjudicated")
    rows = [
        LedgerRow(seq=n, event_type=kind, trial_id=None, created_at=TS, payload={}, trial_ref=1, track="interactive")
        for n, kind in enumerate(scoped, start=1)
    ]
    rows.append(LedgerRow(seq=len(rows) + 1, event_type="manifest_corrected", trial_id=None, created_at=TS, payload={}))
    frames, last = tournament_frames(rows, TOURNAMENT)
    assert frames == []
    assert last == rows[-1].seq


def test_the_cursor_lands_on_the_last_consumed_row_not_the_last_fetched_one() -> None:
    """A page capped at `limit` frames leaves the row that would exceed it entirely for the next call: its
    own `seq` never becomes the returned cursor, so its frame is built exactly once."""
    page_limit = 2
    rows = [status_row(n, "tournament_running") for n in range(1, 5)]
    frames, last = tournament_frames(rows, TOURNAMENT, limit=page_limit)
    assert len(frames) == page_limit
    assert last == rows[page_limit - 1].seq
    # The next poll (after=last) builds the row this call left behind, once.
    remaining = [r for r in rows if r.seq > last]
    frames2, last2 = tournament_frames(remaining, TOURNAMENT, limit=page_limit)
    assert len(frames2) == len(remaining)
    assert last2 == rows[-1].seq


def test_skipped_rows_before_a_capped_frame_still_advance_the_cursor() -> None:
    rows = [
        LedgerRow(
            seq=1,
            event_type="question_asked",
            trial_id=None,
            created_at=TS,
            payload={},
            trial_ref=1,
            track="interactive",
        ),
        status_row(2, "tournament_running"),
    ]
    frames, last = tournament_frames(rows, TOURNAMENT, limit=1)
    assert len(frames) == 1
    assert last == rows[-1].seq


def test_an_inconsistent_block_fails_validation_instead_of_building_a_bad_frame() -> None:
    """`TrialStarted`'s own rule (S6 4.9): a block on anything but an interactive trial, or none on one, is
    refused -- proving the contract actually validates what this module builds, not just the happy path."""
    trial = str(uuid4())
    bad = LedgerRow(
        seq=1,
        event_type="trial_started",
        trial_id=trial,
        created_at=TS,
        payload={},
        trial_ref=1,
        track="replay",
        block=2,
        pairing="A1 x S1",
    )
    with pytest.raises(ValidationError, match="block"):
        tournament_frames([bad], TOURNAMENT)


def test_a_non_ledger_row_is_a_type_error() -> None:
    with pytest.raises(TypeError, match="ledger rows"):
        tournament_frames([{"seq": 1}], TOURNAMENT)


def test_no_rows_is_an_empty_page_at_cursor_zero() -> None:
    assert tournament_frames([], TOURNAMENT) == ([], 0)
