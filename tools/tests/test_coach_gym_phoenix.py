"""`scripts/coach_gym/phoenix.py` over a scripted Phoenix (the documented REST routes and bodies, a refusal for
anything else), and `arena_core.observability.phoenix.PhoenixJsonClient` over a scripted requester."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from arena_core.coachgym.examples import build_examples
from arena_core.observability.phoenix import PhoenixJsonClient, PhoenixReadError
from packages.core.tests.coachgym.support import trial
from scripts.coach_gym.phoenix import ExperimentRow, Phoenix, PhoenixError, phoenix_from

BASE = "http://127.0.0.1:6006"


class FakePhoenix:
    def __init__(self) -> None:
        self.seen: list[tuple[str, str, Any, Mapping[str, str] | None]] = []
        self.examples: list[dict[str, Any]] = []

    def call(
        self, method: str, path: str, body: object = None, params: Mapping[str, str] | None = None
    ) -> tuple[int, object]:
        self.seen.append((method, path, body, params))
        payload: Any = body
        if path == "/v1/datasets/upload":
            assert params == {"sync": "true"}
            self.examples = [{"id": f"ex-{i}", "metadata": m} for i, m in enumerate(payload["metadata"])]
            return 200, {"data": {"dataset_id": "ds-1", "version_id": "v-1"}}
        if path == "/v1/datasets/ds-1/examples":
            return 200, {"data": {"dataset_id": "ds-1", "examples": self.examples}}
        if path == "/v1/datasets/ds-1/experiments":
            return 200, {"data": {"id": "exp-1"}}
        if path == "/v1/experiments/exp-1/runs":
            return 200, {"data": {"id": f"run-{len(self.seen)}"}}
        if path == "/v1/experiment_evaluations":
            return 200, {"data": {"id": "eval"}}
        return 404, {"detail": "no route"}


class Answer:
    def __init__(self, status: int, parsed: object) -> None:
        self.status, self.parsed = status, parsed

    def call(
        self, method: str, path: str, body: object = None, params: Mapping[str, str] | None = None
    ) -> tuple[int, object]:
        _ = (method, path, body, params)
        return self.status, self.parsed


def test_upload_then_an_experiment_with_one_run_and_score_per_example() -> None:
    fake = FakePhoenix()
    phoenix = Phoenix(fake)
    examples = build_examples([trial("deceptive")], frozenset())
    assert phoenix.upload_dataset("coach-gym-abc", examples) == "ds-1"
    method, path, body, _ = fake.seen[0]
    assert (method, path, body["action"], body["name"]) == ("POST", "/v1/datasets/upload", "create", "coach-gym-abc")
    assert [m["split"] for m in body["metadata"]] == ["dev"] * len(examples)
    assert body["outputs"][1]["role"] == "deceptive"
    rows = [ExperimentRow(e.example_id, "deceptive", 0.5, "feedback") for e in examples[:2]]
    rows.append(ExperimentRow("not-uploaded", "x", 0.0, "skipped"))
    assert phoenix.log_experiment("ds-1", "gym-1 challenger", {"run_id": "gym-1"}, rows) == "exp-1"
    runs = [b for _, p, b, _ in fake.seen if p == "/v1/experiments/exp-1/runs"]
    evals = [b for _, p, b, _ in fake.seen if p == "/v1/experiment_evaluations"]
    assert [r["dataset_example_id"] for r in runs] == ["ex-0", "ex-1"]
    assert [(e["annotator_kind"], e["name"], e["result"]["score"]) for e in evals] == [
        ("CODE", "coach_gym_score", 0.5),
        ("CODE", "coach_gym_score", 0.5),
    ]


@pytest.mark.parametrize(
    ("status", "parsed"),
    [(500, {}), (200, None), (200, {"data": "not an object"}), (200, {"data": {}})],
)
def test_anything_but_the_documented_answer_is_refused(status: int, parsed: object) -> None:
    with pytest.raises(PhoenixError):
        Phoenix(Answer(status, parsed)).upload_dataset("x", build_examples([trial("truthful")], frozenset()))


def test_an_experiment_without_an_id_is_refused() -> None:
    with pytest.raises(PhoenixError, match="no id"):
        Phoenix(Answer(200, {"data": {"examples": []}})).log_experiment("ds", "n", {}, [])


class _Response:
    def __init__(self, status: int, body: object) -> None:
        self.status_code, self._body = status, body

    def json(self) -> object:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _Requester:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.sent: list[tuple[str, str, object, Any, Any]] = []
        self.closed = False

    def request(
        self,
        method: str,
        url: str,
        *,
        json: object = None,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> _Response:
        self.sent.append((method, url, json, params, headers))
        return self.response

    def close(self) -> None:
        self.closed = True


def test_the_json_client_sends_the_key_and_parses_the_answer() -> None:
    requester = _Requester(_Response(200, {"data": {}}))
    client = PhoenixJsonClient(requester, f"{BASE}/", "k")
    assert client.call("POST", "/v1/datasets/upload", {"a": 1}, {"sync": "true"}) == (200, {"data": {}})
    assert requester.sent == [
        ("POST", f"{BASE}/v1/datasets/upload", {"a": 1}, {"sync": "true"}, {"authorization": "Bearer k"})
    ]
    assert (client.base_url, client.authorized) == (BASE, True)
    not_json = PhoenixJsonClient(_Requester(_Response(502, ValueError("html"))), BASE)
    assert not_json.call("GET", "/v1/datasets/x/examples") == (502, None)
    assert not_json.authorized is False
    with pytest.raises(PhoenixReadError, match="not a /v1/"):
        client.call("GET", "/internal/answer")
    client.close()
    assert requester.closed


def test_phoenix_is_operator_configuration() -> None:
    assert phoenix_from({}) is None
    configured = phoenix_from({"PHOENIX_BASE_URL": BASE})
    assert configured is not None
    assert isinstance(configured.client, PhoenixJsonClient)
    assert (configured.client.base_url, configured.client.authorized) == (BASE, False)
    traced = phoenix_from({"PHOENIX_OTLP_ENDPOINT": "http://127.0.0.1:7007", "PHOENIX_API_KEY": "k"})
    assert traced is not None
    assert isinstance(traced.client, PhoenixJsonClient)
    assert (traced.client.base_url, traced.client.authorized) == ("http://127.0.0.1:7007", True)
