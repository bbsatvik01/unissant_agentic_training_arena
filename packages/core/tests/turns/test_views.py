"""The projection over a real orchestrated trial (S5 6.2, 6.5; D-021): live deltas with hint frames, the snapshot
fold, the recording, the status table (C-45), and what each mode withholds."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from arena_core.db.arena import EventRow
from arena_core.events.load import (
    RECORDING_FORMAT,
    LoadedTrial,
    TrialMeta,
    load_tournament_trial,
    load_trial,
    recording_of,
    snapshot_of,
    stored_events,
)
from arena_core.events.projections import (
    MAX_DELTA_BYTES,
    StoredEvent,
    TrialState,
    Viewer,
    live_deltas,
    notice_message,
    s6_status,
    snapshot,
)
from arena_core.turns.orchestrator import Orchestrator, TrialSignals

from .fakedb import PACKET, T0, FakeArenaDb
from .test_orchestrator import FINDING, Rig, run

TURNS_PAST_REC_05 = 6  # rec-05 is scheduled after 5 exchanges: the sixth question releases it
FIRST_EVENT_MS = 1000  # fakedb stamps event n at T0 + n seconds; the session started at T0


def _played(turns: int = 3, *, mode: str = "practice", finish: bool = True) -> Rig:
    rig = Rig(mode=mode)
    for _ in range(turns):
        rig.turn()
    if finish:
        run(rig.orch.commit_finding(rig.db.trial_id, FINDING, str(uuid4())))
    return rig


def _loaded(db: FakeArenaDb) -> LoadedTrial:
    loaded = run(load_trial(db, db.trial_id))
    assert loaded is not None
    return loaded


def _events(db: FakeArenaDb) -> list[StoredEvent]:
    return _loaded(db).events


def _frames(messages: list[bytes]) -> list[dict[str, Any]]:
    out = []
    for m in messages:
        lines = m.decode().splitlines()
        body = json.loads(next(line for line in lines if line.startswith("data: "))[6:])
        body["_id"] = next((int(line[4:]) for line in lines if line.startswith("id: ")), None)
        out.append(body)
    return out


def test_live_deltas_add_hints_only_where_the_follow_up_has_not_arrived() -> None:
    rig = _played(1, finish=False)
    events = _events(rig.db)
    one_by_one = [f["type"] for row in events for f in _frames(live_deltas([row], Viewer(False, "practice")))]
    assert one_by_one == [
        "question.accepted",
        "subject.thinking",
        "subject.answer",
        "coach.working",
        "coach.card",
    ]
    batch = [f["type"] for f in _frames(live_deltas(events, Viewer(False, "practice")))]
    assert batch == ["question.accepted", "subject.answer", "coach.card"]


def test_hint_frames_carry_no_sse_id_and_persisted_frames_carry_their_seq() -> None:
    rig = _played(1, finish=False)
    frames = [f for row in _events(rig.db) for f in _frames(live_deltas([row], Viewer(False, "practice")))]
    for f in frames:
        if f["type"] in ("subject.thinking", "coach.working"):
            assert f["seq"] is None
            assert f["_id"] is None
        else:
            assert f["seq"] == f["_id"] is not None


def test_assessment_receives_no_coaching_frames_until_the_trial_ends() -> None:
    rig = _played(3, mode="assessment", finish=False)
    running = run(rig.db.trial_events(rig.db.trial_id, 0))
    events = stored_events(TrialMeta(rig.db.trial_id, "training", None), running, PACKET, [])
    kinds = {f["type"] for row in events for f in _frames(live_deltas([row], Viewer(False, "assessment")))}
    assert not kinds & {"coach.card", "coach.working", "coach.update"}
    snap = snapshot_of(_loaded(rig.db))
    assert snap["cards"] == []
    assert snap["updates"] == []


def test_assessment_cards_arrive_in_order_after_the_end() -> None:
    rig = _played(3, mode="assessment")
    loaded = run(load_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    assert loaded.ended
    snap = snapshot_of(loaded)
    assert [c["turn_no"] for c in snap["cards"]] == [1, 2, 3]
    assert len(snap["updates"]) == 1


def test_snapshot_folds_turns_releases_cards_finding_and_commitment() -> None:
    rig = _played(TURNS_PAST_REC_05)
    snap = snapshot_of(_loaded(rig.db))
    assert snap["status"] == "completed"
    assert snap["commitment_hash"] == "c" * 64
    assert [t["turn_no"] for t in snap["turns"]] == list(range(1, 7))
    assert snap["exchanges_used"] == TURNS_PAST_REC_05
    assert snap["last_seq"] == len(rig.db.events)
    released = snap["released"]
    assert [r["record_id"] for r in released] == ["rec-05"]
    assert released[0]["trigger"] == "scheduled"
    assert {r["record_id"] for r in snap["requestable"]} == {"rec-01", "rec-02", "rec-03", "rec-04"}
    assert snap["finding"]["label"] == "truthful"
    assert "candidate_sha256" not in json.dumps(snap["cards"])


def test_a_requested_record_is_marked_requested() -> None:
    rig = _played(2, finish=False)
    run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01"], str(uuid4())))
    snap = snapshot_of(_loaded(rig.db))
    assert snap["released"][0]["trigger"] == "requested"
    assert "rec-01" not in {r["record_id"] for r in snap["requestable"]}


def test_recording_is_the_ui_players_format_with_live_timing() -> None:
    rig = _played(3)
    loaded = run(load_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    rec = recording_of(loaded, {"debrief": "doc"})
    assert rec["format"] == RECORDING_FORMAT
    assert rec["trial_id"] == str(rig.db.trial_id)
    assert set(rec["case"]) == {
        "case_id",
        "title",
        "objective",
        "domain",
        "difficulty_level",
        "subject",
        "setting",
        "initial_documents",
    }
    assert rec["snapshot"]["last_seq"] == 0
    assert rec["snapshot"]["status"] == "running"
    times = [e["at_ms"] for e in rec["events"]]
    assert times == sorted(times)
    assert times[0] == FIRST_EVENT_MS
    assert all(e["frame"]["scope_id"] == str(rig.db.trial_id) for e in rec["events"])
    types = [e["frame"]["type"] for e in rec["events"]]
    assert types[:2] == ["question.accepted", "subject.thinking"]
    assert types[-1] == "trial.finalized"
    assert rec["debrief"] == {"debrief": "doc"}


def test_an_assessment_recording_keeps_coaching_out_as_the_session_saw_it() -> None:
    rig = _played(3, mode="assessment")
    loaded = run(load_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    types = {e["frame"]["type"] for e in recording_of(loaded, None)["events"]}
    assert not types & {"coach.card", "coach.update", "coach.working"}


def test_a_terminated_trial_shows_its_execution_state() -> None:
    rig = Rig()
    rig.quarantine = True
    rig.turn()
    snap = snapshot_of(_loaded(rig.db))
    assert (snap["status"], snap["reason_code"]) == ("subject_quarantined", "subject_invalid")


def test_another_users_trial_is_none() -> None:
    db = FakeArenaDb()
    assert run(load_trial(db, uuid4())) is None


def test_load_tournament_trial_has_no_session_and_mode_harness() -> None:
    """D-021: a harness trial's own recording export (`arena_tournament`'s job holds no session)."""
    rig = Rig()
    rig.db.kind = "interactive"
    rig.turn()
    loaded = run(load_tournament_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    assert (loaded.session_id, loaded.mode) == (None, "harness")


def test_a_harness_trials_recording_and_snapshot_validate_against_the_real_contracts() -> None:
    """D-021: `make export-run` must actually produce a valid `arena.recording.v1` for a tournament trial,
    not raise -- the snapshot contract's own `mode` field has to accept "harness", not just training's
    "practice"/"assessment" (the real bug this proves: `recording_of`/`snapshot_of` call `snapshot()`,
    which validates `state.mode` against that Literal)."""
    rig = Rig()
    rig.db.kind = "interactive"
    rig.turn()
    loaded = run(load_tournament_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    assert snapshot_of(loaded)["mode"] == "harness"
    recording = recording_of(loaded, None)
    assert recording["snapshot"]["mode"] == "harness"


def test_a_source_unavailable_replay_trials_recording_and_snapshot_validate() -> None:
    """D-021: every tournament trial is exportable, including a replay trial that ended `source_unavailable`
    (S4 `start_trial`; never a training state, so the training-only `TrialStatus` enum must not be the one
    a harness export validates against)."""
    rig = Rig()
    rig.db.kind = "replay"
    rig.db.started_at = None
    run(rig.orch.stop(rig.db.trial_id, "source_unavailable", "the source transcript is not completed and valid"))
    loaded = run(load_tournament_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    assert snapshot_of(loaded)["status"] == "source_unavailable"
    recording = recording_of(loaded, None)
    ended = [e["frame"]["data"] for e in recording["events"] if e["frame"]["type"] == "trial.status"]
    assert [d["status"] for d in ended] == ["source_unavailable"]
    assert recording["final_snapshot"]["status"] == "source_unavailable"


def test_a_training_snapshot_never_carries_source_unavailable() -> None:
    """C-45: `source_unavailable` occurs only on replay trials, which no browser owns."""
    state = TrialState(str(uuid4()), "source_unavailable", None, "practice", 12, PACKET)
    with pytest.raises(ValidationError, match="source_unavailable"):
        snapshot(state, [], Viewer(trial_ended=True, mode="practice"))


def test_load_tournament_trial_is_none_for_an_unknown_trial() -> None:
    db = FakeArenaDb(kind="interactive")
    assert run(load_tournament_trial(db, uuid4())) is None


def test_load_tournament_trial_is_none_for_a_training_kind() -> None:
    """`load_trial` owns training trials; this is the fallback `export_run.py` leans on, never a second
    answer for the same trial."""
    rig = Rig()
    rig.turn()
    assert run(load_tournament_trial(rig.db, rig.db.trial_id)) is None


def test_load_tournament_trial_anchors_a_never_started_attempts_playback_to_its_own_event() -> None:
    """S4 EF-05..EF-11: a `budget_skipped` or `source_unavailable` attempt never reaches `start_trial`, so
    it has no `started_at` -- anchoring its recording to Unix epoch instead of its own `trial_ended` row's
    time (a real bug, Codex round 1) put every offset about 56 years into the future."""
    rig = Rig()
    rig.db.kind = "interactive"
    rig.db.started_at = None
    run(rig.orch.stop(rig.db.trial_id, "budget_skipped", "ops.admit_unit: not enough budget free"))
    loaded = run(load_tournament_trial(rig.db, rig.db.trial_id))
    assert loaded is not None
    assert len(rig.db.events) == 1  # just the trial_ended row this stop() wrote, seq 1 -> T0 + 1s
    assert loaded.started_ms == (T0 + timedelta(seconds=1)).timestamp() * 1000


@pytest.mark.parametrize(
    ("status", "state", "expected"),
    [
        ("running", None, "running"),
        ("planned", None, "running"),
        ("finalized", "completed", "completed"),
        ("terminated", "subject_quarantined", "subject_quarantined"),
        ("terminated", "assistant_failed", "assistant_failed"),
        ("terminated", "infra_failed", "infra_failed"),
        ("terminated", "budget_truncated", "budget_truncated"),
        ("terminated", "budget_skipped", "budget_skipped"),
    ],
)
def test_c45_status_table(status: str, state: str | None, expected: str) -> None:
    assert s6_status(status, state) == expected


def test_an_ended_trial_without_a_terminal_record_is_a_defect() -> None:
    with pytest.raises(ValueError, match="terminal record"):
        s6_status("finalized", None)


def test_live_deltas_refuse_anything_but_stored_events_and_unknown_kinds() -> None:
    with pytest.raises(TypeError):
        live_deltas([{"kind": "question_recorded"}], Viewer(False))
    rig = _played(1, finish=False)
    row = _events(rig.db)[0]
    bad = StoredEvent(**{**row.__dict__, "kind": "mystery"})
    with pytest.raises(ValueError, match="unknown event kind"):
        live_deltas([bad], Viewer(False))


def test_notice_frame() -> None:
    body = notice_message(str(uuid4()), "2026-10-11T14:00:00.000Z", 3, "paused", "The arena is paused.")
    frame = json.loads(body.decode()[6:])
    assert frame["type"] == "notice"
    assert frame["seq"] is None
    assert not body.startswith(b"id:")
    assert len(body) < MAX_DELTA_BYTES


class EndsWhileLoading(FakeArenaDb):
    """The trial finalizes after its events were read and before the trial row is read again."""

    def __init__(self) -> None:
        super().__init__()
        self.cut: int | None = None

    async def all_events(self, trial: UUID) -> list[EventRow]:
        rows = await super().all_events(trial)
        if self.cut is not None:
            rows, self.cut = rows[: self.cut], None
        return rows


def test_a_trial_that_ends_while_it_is_loaded_is_read_again() -> None:
    rig = Rig()
    rig.db = EndsWhileLoading()
    rig.orch = Orchestrator(db=rig.db, port=rig.port, subject=rig.subject, signals=TrialSignals())
    rig.turn()
    run(rig.orch.commit_finding(rig.db.trial_id, FINDING, str(uuid4())))
    rig.db.cut = len(rig.db.events) - 2  # the first read missed finding_committed and trial_ended
    snap = snapshot_of(_loaded(rig.db))
    assert snap["status"] == "completed"
    assert snap["commitment_hash"] == "c" * 64
    assert snap["finding"] is not None


def test_an_assessment_recording_carries_the_withheld_coaching_in_its_final_snapshot() -> None:
    rig = _played(3, mode="assessment")
    rec = recording_of(_loaded(rig.db), None)
    assert [c["turn_no"] for c in rec["final_snapshot"]["cards"]] == [1, 2, 3]
    assert rec["final_snapshot"]["status"] == "completed"
    running = _played(1, finish=False)
    assert recording_of(_loaded(running.db), None)["final_snapshot"] is None


def test_the_final_snapshot_stays_below_the_debrief_ready_frame() -> None:
    rig = _played(2)
    rig.db._emit("debrief_ready", {"session_id": str(rig.db.session_id)})
    rec = recording_of(_loaded(rig.db), None)
    ready = [e["frame"]["seq"] for e in rec["events"] if e["frame"]["type"] == "debrief.ready"]
    assert ready
    assert rec["final_snapshot"]["last_seq"] < ready[0]
