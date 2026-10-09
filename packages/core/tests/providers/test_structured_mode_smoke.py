"""Structured output (T5), the fake adapter and mode selection (S5 10.4), and the owner's Vertex smoke command, which
is driven here with the fake adapter and the in-memory guard: no test sends a real request."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from decimal import Decimal

import pytest
from pydantic import BaseModel, Field

from arena_core.config import BootCheckError
from arena_core.providers import mode, smoke
from arena_core.providers.errors import ConfigError, ErrorKind, ProviderCallError
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.retry import RetryPolicy
from arena_core.providers.structured import (
    OutputInvalidError,
    extract_json_text,
    lint_schema,
    parse_output,
    vertex_root,
    vertex_schema,
)
from arena_core.providers.types import Message, ModelAdapter, ModelRequest, Usage
from arena_core.spend.guard import SpendGuard
from arena_core.spend.limits import ATTEMPTS, ThinkingLevel, VertexModel
from arena_core.spend.memory import RunBudget

MAX_TAGS = 2


class Item(BaseModel):
    name: str = Field(max_length=5)
    tags: list[str] = Field(max_length=MAX_TAGS)


SMOKE_ENV = {"ARENA_GCP_PROJECT": "cna-guardian"}


def req(title: str = "Item") -> ModelRequest:
    return ModelRequest(
        model=VertexModel.FLASH_LITE_35,
        system="s",
        messages=(Message("user", "q"),),
        json_schema={"title": title},
        max_output_tokens=10,
        thinking=ThinkingLevel.MINIMAL,
        seed=1,
    )


# ---------------------------------------------------------------- structured


def test_vertex_schema_drops_undocumented_keywords_and_keeps_bounds() -> None:
    filtered = vertex_root(lint_schema(Item))
    tags = filtered["properties"]["tags"]
    assert tags["maxItems"] == MAX_TAGS  # a bound Vertex documents is kept
    assert "maxLength" not in filtered["properties"]["name"]
    assert vertex_schema([{"default": 1, "type": "x"}]) == [{"type": "x"}]
    assert vertex_schema("leaf") == "leaf"


def test_parse_output_accepts_a_fenced_or_embedded_object() -> None:
    assert parse_output('```json\n{"name": "a", "tags": []}\n```', Item) == Item(name="a", tags=[])
    assert extract_json_text('prose {"a": 1} more') == '{"a": 1}'


@pytest.mark.parametrize(
    ("text", "first"),
    [
        ("no object here", "<root>: no JSON object in the reply"),
        ("{not json}", "<root>: the reply is not valid JSON"),
        ('{"name": "toolong", "tags": []}', "name: String should have at most 5 characters"),
    ],
)
def test_parse_failures_carry_the_repair_list(text: str, first: str) -> None:
    with pytest.raises(OutputInvalidError) as failed:
        parse_output(text, Item)
    assert failed.value.errors[0] == first


# ---------------------------------------------------------------- fake adapter and mode


def test_the_fake_adapter_answers_from_its_script_then_its_canned_replies() -> None:
    fake = FakeAdapter(script=[lambda r: r.system], canned={"Item": "{}"}, usage=Usage(1, 2))
    first = asyncio.run(fake.generate(req(), timeout_s=1))
    second = asyncio.run(fake.generate(req(), timeout_s=1))
    assert (first.text, second.text, first.usage) == ("s", "{}", Usage(1, 2))
    assert fake.timeouts == [1, 1]
    with pytest.raises(ConfigError, match="no canned reply"):
        asyncio.run(fake.generate(req("Other"), timeout_s=1))
    fake.script.append(ProviderCallError(ErrorKind.TRANSIENT, "503"))
    with pytest.raises(ProviderCallError):
        asyncio.run(fake.generate(req(), timeout_s=1))


def test_mode_selects_the_fake_adapter_locally_and_refuses_it_hosted() -> None:
    assert isinstance(mode.model_adapter({"ARENA_MODEL_MODE": "fake"}, canned={"Item": "{}"}), FakeAdapter)
    with pytest.raises(ConfigError, match="K_SERVICE"):
        mode.model_adapter({"ARENA_MODEL_MODE": "fake", "K_SERVICE": "arena-api"})
    with pytest.raises(ConfigError, match="must be"):
        mode.model_adapter({"ARENA_MODEL_MODE": "openai"})


def test_mode_defaults_to_vertex(monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[Mapping[str, str]] = []
    stand_in = FakeAdapter()

    def fake_vertex(env: Mapping[str, str]) -> FakeAdapter:
        built.append(env)
        return stand_in

    monkeypatch.setattr(mode, "vertex_adapter", fake_vertex)
    assert mode.model_adapter({}) is stand_in
    assert mode.model_adapter({"ARENA_MODEL_MODE": "vertex"}) is stand_in
    assert built == [{}, {"ARENA_MODEL_MODE": "vertex"}]


# ---------------------------------------------------------------- smoke command (never sends in tests)


def parts_with(adapter: FakeAdapter, ceiling: Decimal = Decimal(1)) -> smoke.PartsFactory:
    def parts(_env: Mapping[str, str]) -> tuple[ModelAdapter, SpendGuard]:
        return adapter, RunBudget(ceiling)

    return parts


def test_smoke_refuses_without_the_confirmation_flag(capsys: pytest.CaptureFixture[str]) -> None:
    adapter = FakeAdapter(script=['{"status": "ok", "word": "door"}'])
    assert smoke.main([], SMOKE_ENV, parts_with(adapter)) == 1
    assert adapter.requests == []
    assert "--confirm-paid-call" in capsys.readouterr().err


@pytest.mark.parametrize(
    "env",
    [{}, {"ARENA_GCP_PROJECT": "kbg-production"}, {**SMOKE_ENV, "GEMINI_API_KEY": "x"}],
    ids=["no-project", "wrong-project", "api-key"],
)
def test_smoke_refuses_on_a_failed_boot_check(env: dict[str, str]) -> None:
    adapter = FakeAdapter(script=['{"status": "ok", "word": "door"}'])
    assert smoke.main(["--confirm-paid-call"], env, parts_with(adapter)) == 1
    assert adapter.requests == []


def test_smoke_runs_one_call_through_the_port_and_prints_its_receipt(capsys: pytest.CaptureFixture[str]) -> None:
    adapter = FakeAdapter(script=['{"status": "ok", "word": "door"}'], usage=Usage(30, 5))
    assert smoke.main(["--confirm-paid-call"], SMOKE_ENV, parts_with(adapter)) == 0
    out = capsys.readouterr().out
    assert "smoke ok: word='door' attempts=1" in out
    sent = adapter.requests[0]
    assert (sent.model, sent.labels) == (VertexModel.FLASH_LITE_35, {"app": "unissant-arena"})


def test_smoke_reports_a_refused_or_failed_call(capsys: pytest.CaptureFixture[str]) -> None:
    adapter = FakeAdapter(script=['{"status": "ok", "word": "door"}'])
    assert smoke.main(["--confirm-paid-call"], SMOKE_ENV, parts_with(adapter, Decimal(0))) == 1
    assert "BudgetRefusedError" in capsys.readouterr().err


def test_smoke_runtime_parts_need_the_public_dsn() -> None:
    with pytest.raises(BootCheckError, match="ARENA_PUBLIC_DSN"):
        smoke.runtime_parts(SMOKE_ENV)


def test_smoke_runtime_parts_build_the_vertex_adapter_and_the_database_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(smoke, "vertex_adapter", lambda _env: FakeAdapter())
    adapter, guard = smoke.runtime_parts({**SMOKE_ENV, "ARENA_PUBLIC_DSN": "postgresql://x@127.0.0.1:1/db"})
    assert isinstance(adapter, FakeAdapter)
    assert type(guard).__name__ == "DbSpendGuard"


@pytest.mark.parametrize(
    ("attempts", "delay"), [(0, 0.5), (ATTEMPTS + 1, 0.5), (ATTEMPTS, -1.0)], ids=["zero", "five", "negative"]
)
def test_a_retry_policy_outside_the_attempt_rule_is_refused(attempts: int, delay: float) -> None:
    with pytest.raises(ValueError, match="max_attempts"):
        RetryPolicy(max_attempts=attempts, base_delay_s=delay)
