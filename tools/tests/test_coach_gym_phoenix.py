"""`scripts/coach_gym/phoenix.py` against a mock Phoenix (httpx.MockTransport): the documented REST routes and
bodies, and a refusal for anything else."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from arena_core.coachgym.examples import build_examples
from packages.core.tests.coachgym.support import trial
from scripts.coach_gym.phoenix import ExperimentRow, Phoenix, PhoenixError, phoenix_from

BASE = "http://127.0.0.1:6006"


class FakePhoenix:
    def __init__(self) -> None:
        self.seen: list[tuple[str, str, Any]] = []
        self.examples: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body: Any = json.loads(request.content) if request.content else None
        self.seen.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/v1/datasets/upload":
            assert request.url.params["sync"] == "true"
            self.examples = [{"id": f"ex-{i}", "metadata": m} for i, m in enumerate(body["metadata"])]
            return httpx.Response(200, json={"data": {"dataset_id": "ds-1", "version_id": "v-1"}})
        if path == "/v1/datasets/ds-1/examples":
            return httpx.Response(200, json={"data": {"dataset_id": "ds-1", "examples": self.examples}})
        if path == "/v1/datasets/ds-1/experiments":
            return httpx.Response(200, json={"data": {"id": "exp-1"}})
        if path == "/v1/experiments/exp-1/runs":
            return httpx.Response(200, json={"data": {"id": f"run-{len(self.seen)}"}})
        if path == "/v1/experiment_evaluations":
            return httpx.Response(200, json={"data": {"id": "eval"}})
        return httpx.Response(404, json={"detail": "no route"})


def client(fake: FakePhoenix) -> Phoenix:
    return Phoenix(BASE, httpx.Client(transport=httpx.MockTransport(fake)))


def test_upload_then_an_experiment_with_one_run_and_score_per_example() -> None:
    fake = FakePhoenix()
    phoenix = client(fake)
    examples = build_examples([trial("deceptive")], frozenset())
    assert phoenix.upload_dataset("coach-gym-abc", examples) == "ds-1"
    method, path, body = fake.seen[0]
    assert (method, path, body["action"], body["name"]) == ("POST", "/v1/datasets/upload", "create", "coach-gym-abc")
    assert [m["split"] for m in body["metadata"]] == ["dev"] * len(examples)
    assert body["outputs"][1]["role"] == "deceptive"
    rows = [ExperimentRow(e.example_id, "deceptive", 0.5, "feedback") for e in examples[:2]]
    rows.append(ExperimentRow("not-uploaded", "x", 0.0, "skipped"))
    assert phoenix.log_experiment("ds-1", "gym-1 challenger", {"run_id": "gym-1"}, rows) == "exp-1"
    runs = [b for m, p, b in fake.seen if p == "/v1/experiments/exp-1/runs"]
    evals = [b for m, p, b in fake.seen if p == "/v1/experiment_evaluations"]
    assert [r["dataset_example_id"] for r in runs] == ["ex-0", "ex-1"]
    assert [(e["annotator_kind"], e["name"], e["result"]["score"]) for e in evals] == [
        ("CODE", "coach_gym_score", 0.5),
        ("CODE", "coach_gym_score", 0.5),
    ]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, json={}),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json={"data": "not an object"}),
        httpx.Response(200, json={"data": {}}),
    ],
)
def test_anything_but_the_documented_answer_is_refused(response: httpx.Response) -> None:
    phoenix = Phoenix(BASE, httpx.Client(transport=httpx.MockTransport(lambda _r: response)))
    with pytest.raises(PhoenixError):
        phoenix.upload_dataset("x", build_examples([trial("truthful")], frozenset()))


def test_an_experiment_without_an_id_is_refused() -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/examples"):
            return httpx.Response(200, json={"data": {"examples": []}})
        return httpx.Response(200, json={"data": {}})

    phoenix = Phoenix(BASE, httpx.Client(transport=httpx.MockTransport(answer)))
    with pytest.raises(PhoenixError, match="no id"):
        phoenix.log_experiment("ds", "n", {}, [])


def test_phoenix_is_operator_configuration() -> None:
    assert phoenix_from({}) is None
    configured = phoenix_from({"PHOENIX_BASE_URL": BASE})
    assert configured is not None
    assert configured.base_url == BASE
    assert "authorization" not in configured.client.headers
    traced = phoenix_from({"PHOENIX_OTLP_ENDPOINT": "http://127.0.0.1:7007", "PHOENIX_API_KEY": "k"})
    assert traced is not None
    assert traced.base_url == "http://127.0.0.1:7007"
    assert traced.client.headers["authorization"] == "Bearer k"
