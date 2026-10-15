"""Coach Gym datasets and experiments in the operator's Phoenix (D-036; WP-07's Phoenix, REST, no new client).

Phoenix's documented REST routes: `POST /v1/datasets/upload?sync=true` (create a dataset from inputs, outputs and
metadata), `GET /v1/datasets/{id}/examples`, `POST /v1/datasets/{id}/experiments`, `POST /v1/experiments/{id}/runs`
and `POST /v1/experiment_evaluations` (annotator `CODE`: the gym's grader). The URL is operator configuration
(`PHOENIX_BASE_URL` or the tracer's `PHOENIX_OTLP_ENDPOINT`, with `PHOENIX_API_KEY`), never run data. Only
dev-split examples exist to upload (`Example.split` is `dev` by type).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from arena_core.coachgym.examples import Example
from arena_core.coachgym.registry import now

TIMEOUT_S = 30.0
BASE_URL_VAR = "PHOENIX_BASE_URL"
OTLP_ENDPOINT_VAR = "PHOENIX_OTLP_ENDPOINT"
API_KEY_VAR = "PHOENIX_API_KEY"


class PhoenixError(RuntimeError):
    """Phoenix refused or answered something other than the documented shape."""


@dataclass(frozen=True)
class ExperimentRow:
    example_id: str  # the gym's example id (mapped to Phoenix's example id through the upload's metadata)
    output: str
    score: float
    explanation: str


@dataclass
class Phoenix:
    base_url: str
    client: httpx.Client

    def _post(self, path: str, body: Mapping[str, Any], params: Mapping[str, str] | None = None) -> dict[str, Any]:
        response = self.client.post(f"{self.base_url.rstrip('/')}{path}", json=dict(body), params=params)
        return self._data(response, path)

    def _data(self, response: httpx.Response, path: str) -> dict[str, Any]:
        if response.status_code >= httpx.codes.BAD_REQUEST:
            msg = f"phoenix {path}: HTTP {response.status_code}"
            raise PhoenixError(msg)
        try:
            data = response.json().get("data")
        except (ValueError, AttributeError) as exc:
            msg = f"phoenix {path}: the answer is not the documented JSON"
            raise PhoenixError(msg) from exc
        if not isinstance(data, dict):
            msg = f"phoenix {path}: no data object in the answer"
            raise PhoenixError(msg)
        return data

    def upload_dataset(self, name: str, examples: Sequence[Example]) -> str:
        body = {
            "action": "create",
            "name": name,
            "description": "Coach Gym examples: the coach's input at one turn of a dev-split trial and its reference",
            "inputs": [{"turn": e.turn, "context": e.context} for e in examples],
            "outputs": [e.reference.model_dump(mode="json") for e in examples],
            "metadata": [
                {
                    "example_id": e.example_id,
                    "split": e.split,
                    "partition": e.partition,
                    "family": e.family,
                    "trial_id": e.trial_id,
                }
                for e in examples
            ],
        }
        dataset_id = self._post("/v1/datasets/upload", body, {"sync": "true"}).get("dataset_id")
        if not isinstance(dataset_id, str):
            msg = "phoenix upload: no dataset_id in the answer"
            raise PhoenixError(msg)
        return dataset_id

    def example_ids(self, dataset_id: str) -> dict[str, str]:
        path = f"/v1/datasets/{dataset_id}/examples"
        data = self._data(self.client.get(f"{self.base_url.rstrip('/')}{path}"), path)
        out = {}
        for row in data.get("examples", []):
            gym_id = (row.get("metadata") or {}).get("example_id")
            if isinstance(gym_id, str) and isinstance(row.get("id"), str):
                out[gym_id] = row["id"]
        return out

    def log_experiment(
        self, dataset_id: str, name: str, metadata: Mapping[str, Any], rows: Sequence[ExperimentRow]
    ) -> str:
        """One experiment: a run per graded example and the grader's score on it. Returns the experiment id."""
        ids = self.example_ids(dataset_id)
        experiment = self._post(
            f"/v1/datasets/{dataset_id}/experiments", {"name": name, "metadata": dict(metadata), "repetitions": 1}
        )
        experiment_id = experiment.get("id")
        if not isinstance(experiment_id, str):
            msg = "phoenix experiment: no id in the answer"
            raise PhoenixError(msg)
        for row in rows:
            if row.example_id not in ids:
                continue
            at = now()
            run = self._post(
                f"/v1/experiments/{experiment_id}/runs",
                {
                    "dataset_example_id": ids[row.example_id],
                    "output": row.output,
                    "repetition_number": 1,
                    "start_time": at,
                    "end_time": at,
                },
            )
            self._post(
                "/v1/experiment_evaluations",
                {
                    "experiment_run_id": run.get("id"),
                    "name": "coach_gym_score",
                    "annotator_kind": "CODE",
                    "start_time": at,
                    "end_time": at,
                    "result": {"score": row.score, "explanation": row.explanation[:2000]},
                },
            )
        return experiment_id


def phoenix_from(env: Mapping[str, str]) -> Phoenix | None:
    """The operator's Phoenix: `PHOENIX_BASE_URL`, else the `PHOENIX_OTLP_ENDPOINT` base the tracer exports to (the
    same Phoenix, WP-07), with `PHOENIX_API_KEY` as the bearer key when set; None when neither URL is set."""
    url = env.get(BASE_URL_VAR, "").strip() or env.get(OTLP_ENDPOINT_VAR, "").strip()
    if not url:
        return None
    key = env.get(API_KEY_VAR, "").strip()
    headers = {"authorization": f"Bearer {key}"} if key else {}
    return Phoenix(url, httpx.Client(timeout=TIMEOUT_S, headers=headers))
