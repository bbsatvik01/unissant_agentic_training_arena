"""An in-memory `ArenaDb` with S4's turn semantics for unit tests (the integration suite runs the real functions).

One training trial on dev family F01 (truthful variant; `docs/spec/seed-families/F01.json`): rec-01..rec-04 on
request after 2, 3, 3 and 6 exchanges, rec-05 scheduled after 5. It mirrors what the orchestrator and the routes
depend on: request-key idempotency of work items (a repeated key returns the item, before any state check), the
version binding (AR002), the open turn (AR004), the requestable list (AR005), events with per-trial `seq`, and the
terminal record. The subject's answer is recorded through `record_answer`, the stand-in for `arena-subject`.
"""

from __future__ import annotations

import json
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from psycopg import AsyncConnection

from arena_core.agents.manifests import committed_manifest
from arena_core.db.arena import ArenaDb, ArenaError, EventRow, QuestionOrigin, SessionStart
from arena_core.turns.orchestrator import SubjectOutcome

REPO = Path(__file__).resolve().parents[4]
FAMILY = json.loads((REPO / "docs/spec/seed-families/F01.json").read_text(encoding="utf-8"))
VARIANT = FAMILY["variants"]["truthful"]
PACKET: dict[str, Any] = VARIANT["public_packet"]
ARTIFACTS = {
    e["artifact_id"]: e
    for e in VARIANT["evaluator_packet"]["evidence_artifacts"]
    if e["artifact_id"].startswith("rec-")
}
COACH = committed_manifest("A1")
T0 = datetime(2026, 10, 11, 14, 0, 0, tzinfo=UTC)
COMMITMENT = "c" * 64


def _no_connection() -> AbstractAsyncContextManager[AsyncConnection[Any]]:
    msg = "FakeArenaDb never opens a connection"
    raise AssertionError(msg)


class FakeArenaDb(ArenaDb):
    def __init__(self, actor: UUID | None = None, *, mode: str = "practice", kind: str = "training") -> None:
        super().__init__(connect=_no_connection, actor=actor)
        self.trial_id = uuid4()
        self.session_id = uuid4()
        self.coach_id = uuid4()
        self.subject_id: UUID | None = None
        self.planned_trial_id: UUID | None = None
        self.variant_id = uuid4()
        self.mode = mode
        self.kind = kind  # arena.v_trials' own kind (training/interactive/replay/replay_corpus), WP-17
        self.status = "running"
        self.started_at: datetime | None = T0  # None for a never-started attempt (budget_skipped, WP-17)
        self.execution_state: str | None = None
        self.version = 0
        self.exchanges = 0
        self.coaching_pending = False
        self.turns: dict[int, dict[str, Any]] = {}
        self.items: dict[str, dict[str, Any]] = {}
        self.releases: list[dict[str, Any]] = []
        self.events: list[EventRow] = []
        self.finding: dict[str, Any] | None = None
        self.debriefs: dict[UUID, dict[str, Any]] = {}
        self.calls: list[str] = []
        self.fail_next: dict[str, ArenaError] = {}
        self.acks: dict[str, datetime] = {}
        self.paused = False
        self.ticket: str | None = None
        self.overtake_bound_steps = False  # a step bound to an earlier version is refused AR002
        self.manifest_missing = False
        self.tournament_statuses: dict[UUID, str] = {}
        self.tournament_splits: dict[UUID, str] = {}
        self.tournament_rows: list[dict[str, Any]] = []  # GET /api/tournaments rows
        self.tournament_progress_rows: dict[UUID, list[dict[str, Any]]] = {}
        self.tournament_event_pages: dict[UUID, tuple[list[dict[str, Any]], int]] = {}
        self.more_sessions: list[dict[str, Any]] = []
        self.study_row: dict[str, Any] | None = (
            None  # the actor's training.v_my_study row  # further sessions of the actor (progress tests)
        )
        self.boards: list[dict[str, Any]] = []  # {tournament, board, label, manifest_version, body}

    # ------------------------------------------------------------------ helpers

    def _check(self, name: str) -> None:
        self.calls.append(name)
        if name in self.fail_next:
            raise self.fail_next.pop(name)

    def _emit(self, kind: str, payload: dict[str, Any], turn_no: int | None = None) -> int:
        seq = len(self.events) + 1
        visibility = "debrief" if kind.startswith("coach_") and self.mode == "assessment" else "live"
        turn = turn_no if turn_no is not None else max(self.turns, default=0)
        at = T0 + timedelta(seconds=seq)
        self.events.append(EventRow(seq, kind, visibility, self.version, turn, payload, at))
        return seq

    def _running(self) -> None:
        if self.status != "running":
            raise ArenaError("AR001", f"trial is {self.status}")

    def _item(self, work_item: UUID) -> dict[str, Any]:
        for item in self.items.values():
            if item["work_item_id"] == str(work_item):
                return item
        raise ArenaError("AR003", "unknown work item")

    @staticmethod
    def _replayed(item: dict[str, Any], given: object) -> bool:
        """S4 `_take_work_item`: a finished item answers its stored result for the same input, AR003 otherwise;
        an open one remembers the input it is about to complete with."""
        if item["status"] == "done":
            if item.get("input") != given:
                raise ArenaError("AR003", "work item reused with different input")
            return True
        item["input"] = given
        return False

    @staticmethod
    def _done(item: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        item["status"], item["result"] = "done", result
        return result

    def _end(self, state: str) -> None:
        self.status = "finalized" if state == "completed" else "terminated"
        self.execution_state = state
        self.coaching_pending = False

    # ------------------------------------------------------------------ sessions and turns

    async def start_session(self, start: SessionStart) -> dict[str, Any]:
        self._check("start_session")
        assert start.key
        return {"session_id": str(self.session_id), "trial_id": str(self.trial_id), "phase": "practice"}

    async def submit_question(
        self, trial: UUID, expected_version: int, text: str, key: str, origin: QuestionOrigin | None = None
    ) -> dict[str, Any]:
        self._check("submit_question")
        assert trial == self.trial_id
        source = (origin or QuestionOrigin()).source or "investigator"
        for n, turn in self.turns.items():
            if turn["key"] == key:
                if turn["question"] != text:
                    raise ArenaError("AR003", "idempotency key reused with a different question")
                return {"turn_no": n, "transcript_version": turn["version"]}
        if expected_version != self.version:
            raise ArenaError("AR002", "stale transcript version")
        self._running()
        if any(t["answer"] is None for t in self.turns.values()) or self.coaching_pending:
            raise ArenaError("AR004", "turn in progress")
        n = self.exchanges + 1
        self.version += 1
        self.turns[n] = {"question": text, "answer": None, "key": key, "version": self.version}
        self._emit("question_recorded", {"turn_no": n, "question": text, "source": source, "channel": "text"}, n)
        return {"turn_no": n, "transcript_version": self.version}

    async def open_work_item(
        self, trial: UUID, kind: str, request_key: str, expected_version: int | None = None
    ) -> dict[str, Any]:
        self._check(f"open:{kind}")
        assert trial == self.trial_id
        if request_key in self.items:
            return self.items[request_key]
        if kind != "failure":
            self._running()
        if expected_version is not None and (expected_version != self.version or self.overtake_bound_steps):
            raise ArenaError("AR002", "stale: overtaken")
        if kind == "subject_answer" and not any(t["answer"] is None for t in self.turns.values()):
            raise ArenaError("AR004", "no open question")
        item = {
            "work_item_id": str(uuid4()),
            "kind": kind,
            "request_key": request_key,
            "transcript_version": self.version,
            "turn_no": max(self.turns, default=0),
            "status": "open",
            "result": None,
        }
        self.items[request_key] = item
        return item

    def _release(self, requested: list[str]) -> list[dict[str, Any]]:
        have = {r["record_id"] for r in self.releases}
        new = []
        for rid, art in sorted(ARTIFACTS.items()):
            if rid in have:
                continue
            rel = art["release"]
            due = rel["type"] == "scheduled" and rel["after_exchanges"] <= self.exchanges
            asked = rel["type"] == "on_request" and rid in requested and rel["after_exchanges"] <= self.exchanges
            if due or asked:
                new.append(art)
        if new:
            self.version += 1
        for art in new:
            row = {"record_id": art["artifact_id"], "kind": "record", "doc_kind": art["kind"], "title": art["title"]}
            self.releases.append({**row, "content": art["content"], "after_exchanges": self.exchanges})
            self._emit("evidence_released", {**row, "content": art["content"]})
        return new

    async def release_evidence(self, trial: UUID, work_item: UUID, record_ids: list[str]) -> dict[str, Any]:
        self._check("release_evidence")
        assert trial == self.trial_id
        item = self._item(work_item)
        if self._replayed(item, sorted(set(record_ids))):
            return dict(item["result"])
        self._running()
        if item["transcript_version"] != self.version:
            raise ArenaError("AR002", "stale transcript version")
        if self.coaching_pending:
            raise ArenaError("AR004", "turn in progress")
        if any(r not in ARTIFACTS or ARTIFACTS[r]["release"]["type"] != "on_request" for r in record_ids):
            raise ArenaError("AR005", "not requestable")
        new = self._release(record_ids)
        new_ids = [a["artifact_id"] for a in new]
        have = {r["record_id"] for r in self.releases}
        result = {
            "released": [{"record_id": a["artifact_id"], "kind": "record", "doc_kind": a["kind"]} for a in new],
            "already_released": sorted(r for r in record_ids if r in have and r not in new_ids),
            "denied": sorted(r for r in record_ids if r not in have),
            "transcript_version": self.version,
        }
        return self._done(item, result)

    async def release_between_turns(self, trial: UUID, request_key: str, record_ids: list[str]) -> dict[str, Any]:
        item = await self.open_work_item(trial, "release", request_key)
        return await self.release_evidence(trial, UUID(item["work_item_id"]), record_ids)

    def record_answer(self, work_item: UUID, answer: str = "I went in to check the dehumidifier.") -> SubjectOutcome:
        """`arena.record_subject_turn` with a passed guard (the arena-subject stand-in)."""
        item = self._item(work_item)
        if item["status"] == "done":
            return SubjectOutcome(item["result"]["outcome"], item["result"]["turn_no"])
        n = max(self.turns)
        self.turns[n]["answer"] = answer
        self.exchanges += 1
        self.version += 1
        self.coaching_pending = True
        self._emit("subject_turn", {"turn_no": n, "answer": answer, "partial": False, "channel": "text"}, n)
        self._done(item, {"outcome": "recorded", "turn_no": n, "transcript_version": self.version})
        return SubjectOutcome("recorded", n)

    def quarantine(self, work_item: UUID) -> SubjectOutcome:
        item = self._item(work_item)
        n = max(self.turns)
        self.version += 1
        self._end("subject_quarantined")
        self._emit("trial_ended", {"reason": "subject_invalid"})
        self._done(item, {"outcome": "quarantined", "turn_no": n})
        return SubjectOutcome("quarantined", n)

    async def record_coaching_event(
        self, trial: UUID, work_item: UUID, payload: dict[str, Any], kind: str
    ) -> dict[str, Any]:
        self._check(f"record:{kind}")
        assert trial == self.trial_id
        item = self._item(work_item)
        if item["status"] == "done":
            return dict(item["result"])
        self._running()
        if item["transcript_version"] != self.version:
            raise ArenaError("AR002", "stale transcript version: discard this card")
        seq = self._emit(kind, payload, item["turn_no"])
        if kind in ("coach_card", "coach_unavailable"):
            self.coaching_pending = False
        return self._done(item, {"seq": seq})

    async def finalize_trial(self, trial: UUID, work_item: UUID, finding: dict[str, Any] | None) -> dict[str, Any]:
        """`finding` is null for a corpus transcript (S2 8.6; S4 6.2 item 3; mirrors
        `arena.finalize_trial`'s own `p_final_finding is null` branch, which skips the citation check and
        the finding-storage insert, and never emits `finding_committed` -- only `trial_ended`)."""
        self._check("finalize_trial")
        assert trial == self.trial_id
        item = self._item(work_item)
        if self._replayed(item, finding):
            return dict(item["result"])
        self._running()
        if self.coaching_pending:
            raise ArenaError("AR004", "turn in progress")
        if finding is None:
            self.finding = None
            self._end("completed")
            self._emit("trial_ended", {"reason": "completed", "commitment_sha256": COMMITMENT})
            return self._done(item, {"commitment_sha256": COMMITMENT, "payload_sha256": "d" * 64})
        answered = {n for n, t in self.turns.items() if t["answer"] is not None}
        docs = {d["doc_id"] for d in PACKET["initial_documents"]} | {r["record_id"] for r in self.releases}
        if not set(finding["cited_turns"]) <= answered or not set(finding["cited_records"]) <= docs:
            raise ArenaError("AR007", "finding citations")
        self.finding = finding
        self.version += 1
        self._end("completed")
        if self.kind == "training":  # S4 finalize_trial emits finding_committed for a training trial only
            self._emit("finding_committed", finding)
        self._emit("trial_ended", {"reason": "completed", "commitment_sha256": COMMITMENT})
        return self._done(item, {"commitment_sha256": COMMITMENT, "payload_sha256": "d" * 64})

    async def record_execution_failure(self, trial: UUID, work_item: UUID, state: str, reason: str) -> dict[str, Any]:
        self._check("record_execution_failure")
        assert reason
        item = self._item(work_item)
        self._end(state)
        self._emit("trial_ended", {"reason": "budget" if state.startswith("budget") else state})
        return self._done(item, {"trial_id": str(trial), "state": state})

    async def trial_context(self, trial: UUID, work_item: UUID) -> dict[str, Any]:
        self._check("trial_context")
        assert self._item(work_item)["status"] == "open"
        coaching = [
            {"seq": e.seq, "kind": e.kind, "turn_no": e.turn_no, "card": e.payload}
            for e in self.events
            if e.kind in ("coach_card", "coach_deep", "coach_unavailable")
        ]
        return {
            "trial_id": str(trial),
            "kind": "training",
            "mode": self.mode,
            "transcript_version": self.version,
            "exchanges": self.exchanges,
            "max_exchanges": 12,
            "public_packet": PACKET,
            "transcript": [
                {"turn_no": n, "question": t["question"], "answer": t["answer"], "partial": False}
                for n, t in sorted(self.turns.items())
            ],
            "released_evidence": list(self.releases),
            "coaching": coaching,
            "assistant_manifest": COACH.model_dump(mode="json"),
        }

    # ------------------------------------------------------------------ tickets and reads

    async def issue_ticket(self, kind: str, trial: UUID) -> str:
        self._check("issue_ticket")
        assert kind == "sse"
        assert trial == self.trial_id
        if self.status != "running" and self.session_id in self.debriefs:
            raise ArenaError("AR040", "ticket refused")
        self.ticket = "t" * 64
        return self.ticket

    async def redeem_ticket(self, token: str, kind: str) -> dict[str, Any]:
        self._check("redeem_ticket")
        if token != self.ticket or kind != "sse":
            raise ArenaError("AR040", "ticket refused")
        self.ticket = None
        return {
            "ticket_id": str(uuid4()),
            "user_id": str(self.actor),
            "trial_id": str(self.trial_id),
            "mode": self.mode,
        }

    async def trial_events(self, trial: UUID, after: int, limit: int = 200) -> list[EventRow]:
        assert trial == self.trial_id
        ended = self.status != "running"
        rows = [e for e in self.events if e.seq > after and (e.visibility == "live" or ended)]
        return rows[:limit]

    async def trial(self, trial: UUID) -> dict[str, Any] | None:
        """`arena.v_trials` joined with `training.v_my_sessions`: no row for a tournament trial (no training
        session), whatever `trial_id` or actor; `tournament_trial` is that trial's own read."""
        if trial != self.trial_id or self.kind != "training":
            return None
        return {
            "trial_id": self.trial_id,
            "mode": self.mode,
            "status": self.status,
            "transcript_version": self.version,
            "exchanges": self.exchanges,
            "max_exchanges": 12,
            "coaching_pending": self.coaching_pending,
            "execution_state": self.execution_state,
            "variant_id": self.variant_id,
            "session_id": self.session_id,
            "voice": False,
            "started_at": self.started_at,
            "assistant_candidate_id": self.coach_id,
        }

    async def tournament_trial(self, trial: UUID) -> dict[str, Any] | None:
        """The real `arena.v_trials` read resolves either way regardless of `actor` (S5 1.2 item 2's own
        grants, not a python-level filter), with the one shape every tournament job call shares (`kind`,
        `subject_candidate_id`, `planned_trial_id` -- none of which `trial()`'s own training-only dict
        carries): this lets a harness-style test (`HarnessAsker`/`CorpusAsker`, WP-17) drive this fake
        exactly as a `db.actor is None` job would, and gives `Orchestrator._manifest`'s fallback and
        `load_tournament_trial` something real to find when `trial()`'s own query misses."""
        if trial != self.trial_id:
            return None
        return {
            "trial_id": self.trial_id,
            "kind": self.kind,
            "status": self.status,
            "transcript_version": self.version,
            "exchanges": self.exchanges,
            "max_exchanges": 12,
            "coaching_pending": self.coaching_pending,
            "execution_state": self.execution_state,
            "variant_id": self.variant_id,
            "assistant_candidate_id": self.coach_id,
            "subject_candidate_id": self.subject_id,
            "planned_trial_id": self.planned_trial_id,
            "started_at": self.started_at,
        }

    async def open_question(self, trial: UUID) -> bool:
        assert trial == self.trial_id
        return any(t["answer"] is None for t in self.turns.values())

    async def released(self, trial: UUID) -> list[dict[str, Any]]:
        assert trial == self.trial_id
        return [
            {"record_id": r["record_id"], "released_after_exchanges": r["after_exchanges"], "content": r["content"]}
            for r in self.releases
        ]

    async def released_with_titles(self, trial: UUID) -> list[dict[str, Any]]:
        """`arena.v_released_evidence`'s shape (S2 8.6; C-23): title alongside every released record, used
        by the replay-corpus harness ports (WP-17, `CorpusAsker.release`)."""
        assert trial == self.trial_id
        return [
            {"record_id": r["record_id"], "title": r["title"], "released_after_exchanges": r["after_exchanges"]}
            for r in self.releases
        ]

    async def public_packet(self, variant: UUID) -> dict[str, Any] | None:
        return PACKET if variant == self.variant_id else None

    async def study(self) -> dict[str, Any] | None:
        return self.study_row

    async def dev_cases(self) -> list[dict[str, Any]]:
        return [
            {
                "variant_id": self.variant_id,
                "family_code": "F01",
                "variant_code": PACKET["case_id"],
                "public_packet": PACKET,
                "kpi1_set": False,
            }
        ]

    async def my_sessions(self) -> list[dict[str, Any]]:
        return [
            {
                "session_id": self.session_id,
                "trial_id": self.trial_id,
                "phase": "practice",
                "voice": False,
                "created_at": T0,
                "mode": self.mode,
                "status": self.status,
                "exchanges": self.exchanges,
                "variant_id": self.variant_id,
            },
            *self.more_sessions,
        ]

    async def candidate(self, kind: str, name: str) -> tuple[UUID, dict[str, Any]] | None:
        assert kind in ("assistant", "subject")
        return (self.coach_id, {}) if name in ("A1", "S1") else None

    async def manifest(self, candidate: UUID) -> dict[str, Any] | None:
        if candidate != self.coach_id or self.manifest_missing:
            return None
        return {"manifest": COACH.model_dump(mode="json"), "sha256": COACH.sha256}

    async def debrief(self, session: UUID) -> dict[str, Any] | None:
        return self.debriefs.get(session)

    async def tournament_status(self, tournament: UUID) -> str | None:
        return self.tournament_statuses.get(tournament)

    async def tournament_split(self, tournament: UUID) -> str | None:
        return self.tournament_splits.get(tournament)

    async def tournaments(self) -> list[dict[str, Any]]:
        return list(self.tournament_rows)

    async def tournament_progress(self, tournament: UUID) -> list[dict[str, Any]]:
        return list(self.tournament_progress_rows.get(tournament, []))

    async def tournament_events(
        self, tournament: UUID, after: int, limit: int = 200
    ) -> tuple[list[dict[str, Any]], int]:
        frames, last = self.tournament_event_pages.get(tournament, ([], after))
        return frames[:limit], last

    async def leaderboard(self, tournament: UUID, board: str, label: str | None) -> dict[str, Any] | None:
        rows = [
            b
            for b in self.boards
            if b["tournament"] == tournament and b["board"] == board and label in (None, b["label"])
        ]
        if not rows:
            return None
        top = max(rows, key=lambda b: b["manifest_version"])
        return {"body": top["body"], "label": top["label"], "manifest_version": top["manifest_version"]}

    async def isolation_checks(self) -> list[dict[str, Any]]:
        return [
            {
                "check": "hidden_text_scan",
                "candidate": "A1",
                "passed": True,
                "run_at": "2026-10-12T00:00:00.000Z",
                "commit_sha": "c" * 40,
            }
        ]

    async def revealed_commitments(self) -> list[dict[str, Any]]:
        return []

    async def budget_view(self) -> dict[str, Any]:
        return {"ceiling_usd": "0.000000", "spent_usd": "0", "open_usd": "0", "by_purpose": []}

    async def public_config(self) -> dict[str, Any]:
        return {"paused": self.paused, "text_sessions_per_user_day": 5, "voice_sessions_per_user_day": 1}

    async def acknowledgements(self) -> dict[str, datetime]:
        return dict(self.acks)

    async def acknowledge(self, kind: str) -> datetime:
        return self.acks.setdefault(kind, T0)

    async def ack_card(self, trial: UUID, turn_no: int, client_valid: bool) -> bool:
        self._check("ack_card")
        assert trial == self.trial_id
        assert turn_no >= 1
        return client_valid
