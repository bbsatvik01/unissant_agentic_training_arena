"""check_cost_parity.py (S4 WI-S4-08, S5 4.9): the spend-guard seeds a migrated database enforces must equal
docs/research/synthesis/cost_model.py. The live comparison runs in `make db-test` against the freshly migrated
database; these tests pin every comparison rule, with a gateproof per drift the gate exists to catch."""

import dataclasses
import json
import subprocess
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path

import pytest

from tools import check_cost_parity as cp
from tools.tests.conftest import REPO_ROOT

DSN = "postgresql://postgres@127.0.0.1:54329/postgres"
ATTEMPTS = 4  # cost_model.ATTEMPTS: first try + one schema repair + two transient retries
SEED_DATE = "2026-10-08"


@pytest.fixture(autouse=True)
def no_libpq_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hermetic: a developer's own PGHOST or PGSERVICE must not change what these tests see."""
    for name in cp.LIBPQ_REDIRECTS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="module")
def model() -> cp.CostModel:
    return cp.load_cost_model(REPO_ROOT)


@pytest.fixture
def seeds(model: cp.CostModel) -> cp.Seeds:
    return matching_seeds(model)


def matching_seeds(cm: cp.CostModel) -> cp.Seeds:
    """The seeds a correct migration writes, built from the cost model: the passing baseline that every
    gateproof below changes by exactly one value."""
    limits = {k: v for k, v in cm.limits.items() if k not in cp.D014_REMOVED_CALL_KINDS}
    limits.update(cp.initial_value_limits(cm))
    prices = [
        cp.PriceRow(cp.MODEL_ID_PREFIX + key, SEED_DATE, p_in, p_out, None, None)
        for key, (p_in, p_out) in cm.liability_prices.items()
        if key not in cp.D014_REMOVED_PRICE_KEYS
    ]
    text_in, text_out, audio_in, audio_out = cp.live_rates(cm)
    prices += [cp.PriceRow(m, SEED_DATE, text_in, text_out, audio_in, audio_out) for m in cp.LIVE_MODEL_IDS]
    config = cp.ConfigSeed(
        attempts_per_call=cm.attempts,
        voice_session_reservation_usd=cp.printed6(cm.voice_reservation),
        voice_probe_reservation_usd=cp.printed6(cm.probe_reservation),
        voice_sessions_total=cm.voice_sessions,
        voice_probes_total=cm.live_probes,
    )
    buckets = {name: (parent, Decimal(0)) for name, (parent, _ceiling) in cm.plan.items()}
    return cp.Seeds(config=config, model_prices=prices, call_limits=limits, budget_buckets=buckets)


def with_price(seeds: cp.Seeds, row: cp.PriceRow) -> cp.Seeds:
    """seeds with `row` replacing the price row of the same model (or added when the model has none)."""
    rows = [r for r in seeds.model_prices if r.model != row.model] + [row]
    return dataclasses.replace(seeds, model_prices=rows)


def price_of(seeds: cp.Seeds, model_id: str) -> cp.PriceRow:
    return next(r for r in seeds.model_prices if r.model == model_id)


def with_limit(seeds: cp.Seeds, kind: str, limits: tuple[int, int] | None) -> cp.Seeds:
    call_limits = dict(seeds.call_limits)
    if limits is None:
        call_limits.pop(kind)
    else:
        call_limits[kind] = limits
    return dataclasses.replace(seeds, call_limits=call_limits)


def seed_rows_json(seeds: cp.Seeds) -> str:
    """What the database query prints for `seeds` (row_to_json shapes, numbers as JSON numbers)."""

    def num(value: Decimal | None) -> object:
        return None if value is None else float(value)

    return json.dumps(
        {
            "config": {
                "attempts_per_call": seeds.config.attempts_per_call,
                "voice_session_reservation_usd": num(seeds.config.voice_session_reservation_usd),
                "voice_probe_reservation_usd": num(seeds.config.voice_probe_reservation_usd),
                "voice_sessions_total": seeds.config.voice_sessions_total,
                "voice_probes_total": seeds.config.voice_probes_total,
                "kill_switch": False,
            },
            "model_prices": [
                {
                    "model": r.model,
                    "effective_from": r.effective_from,
                    "text_in": num(r.text_in),
                    "text_out": num(r.text_out),
                    "audio_in": num(r.audio_in),
                    "audio_out": num(r.audio_out),
                    "status": r.status,
                }
                for r in seeds.model_prices
            ],
            "call_limits": [
                {"call_kind": k, "input_limit": i, "output_limit": o} for k, (i, o) in seeds.call_limits.items()
            ],
            "budget_buckets": [
                {"name": n, "parent": p, "ceiling_usd": num(c), "note": "seed"}
                for n, (p, c) in seeds.budget_buckets.items()
            ],
        }
    )


# ------------------------------------------------------------------ the cost model side


def test_the_real_cost_model_loads(model: cp.CostModel) -> None:
    assert model.limits["card"] == (128000, 1600)  # D11: byte-based input limits
    assert {"generate", "validate"} <= set(model.limits)
    assert model.liability_prices["3.5-flash-lite"] == (Decimal("0.3"), Decimal("2.5"))
    assert model.attempts == ATTEMPTS
    assert model.plan["global"][0] is None
    assert model.plan["global"][1] > 0


def test_voice_amounts_are_the_values_the_script_prints(model: cp.CostModel) -> None:
    # S4 8.4 seeds the amounts as cost_model.py prints them to 6 dp ($3.392520, $0.424940). PROBE_RESERVATION is
    # 0.42494000000000004 as a float: binary noise, not a cent of worst case, so it must not round up to 0.424941.
    assert (cp.printed6(model.voice_reservation), cp.printed6(model.probe_reservation)) == (
        Decimal("3.392520"),
        Decimal("0.424940"),
    )
    assert cp.printed6(Decimal("0.42494000000000004")) == Decimal("0.424940")
    assert cp.printed6(Decimal("1.6357199999999998")) == Decimal("1.635720")
    assert cp.printed6(Decimal("0.0000005")) == Decimal("0.000001")  # half rounds up, as %.6f prints it here


def test_initial_value_limits_cover_portrait_only(model: cp.CostModel) -> None:
    # S5 3.3's initial value; retranscribe is gone with D7 (voice is display-only, no retranscription call).
    assert cp.initial_value_limits(model) == {"portrait": (2000, 2000)}


def test_a_cost_model_limit_wins_over_an_initial_value(model: cp.CostModel) -> None:
    grown = dataclasses.replace(model, limits={**model.limits, "portrait": (2500, 2500)})
    assert "portrait" not in cp.initial_value_limits(grown)


def test_live_rates_are_voice_rates_times_one_and_a_half(model: cp.CostModel) -> None:
    assert cp.live_rates(model) == (Decimal("1.125"), Decimal("6.75"), Decimal("4.5"), Decimal("18.0"))


def test_parses_a_real_plan_object() -> None:
    assert cp.parse_plan_json('{"global": {"parent": null, "ceiling_usd": 74.0}}') == {
        "global": (None, Decimal("74.0"))
    }


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("stdout", "match"),
    [
        ("not json at all", "did not print valid JSON"),
        ("{}", "non-empty JSON object"),
        ("[1, 2, 3]", "non-empty JSON object"),
        ('{"global": {"parent": null}}', "ceiling_usd"),
        ('{"global": {"parent": 7, "ceiling_usd": 1}}', "parent"),
        ('{"global": {"parent": null, "ceiling_usd": -1}}', "ceiling_usd"),
        ('{"global": {"parent": null, "ceiling_usd": true}}', "ceiling_usd"),
        ('{"global": 74}', "object"),
    ],
)
def test_a_malformed_plan_fails(stdout: str, match: str) -> None:
    with pytest.raises(cp.CostParityError, match=match):
        cp.parse_plan_json(stdout)


@pytest.mark.gateproof
def test_missing_cost_model_fails(tmp_path: Path) -> None:
    with pytest.raises(cp.CostParityError, match="is missing"):
        cp.load_cost_model(tmp_path)


@pytest.mark.gateproof
def test_a_cost_model_that_exits_nonzero_fails(tmp_path: Path) -> None:
    broken = tmp_path / cp.COST_MODEL_PATH
    broken.parent.mkdir(parents=True)
    broken.write_text("import sys\nsys.exit(1)\n")
    with pytest.raises(cp.CostParityError, match="exited 1"):
        cp.load_cost_model(tmp_path)


@pytest.mark.gateproof
def test_a_plan_json_run_that_exits_nonzero_fails(tmp_path: Path) -> None:
    broken = tmp_path / cp.COST_MODEL_PATH
    broken.parent.mkdir(parents=True)
    broken.write_text("import sys\nsys.exit(3 if '--plan-json' in sys.argv else 0)\n")
    with pytest.raises(cp.CostParityError, match="--plan-json exited 3"):
        cp.run_plan_json(tmp_path)


def test_the_real_plan_json_round_trips() -> None:
    assert cp.parse_plan_json(cp.run_plan_json(REPO_ROOT))["global"][0] is None


@pytest.mark.gateproof
def test_a_cost_model_without_a_constant_fails(tmp_path: Path) -> None:
    broken = tmp_path / cp.COST_MODEL_PATH
    broken.parent.mkdir(parents=True)
    broken.write_text("LIMITS = {}\n")
    with pytest.raises(cp.CostParityError, match="exited 1"):
        cp.load_cost_model(tmp_path)


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("LIMITS", {"card": [6000]}, "LIMITS"),
        ("LIMITS", {"card": [6000, "1600"]}, "LIMITS"),
        ("LIABILITY_PRICES", {"3.5-flash-lite": [0.3, None]}, "LIABILITY_PRICES"),
        ("ATTEMPTS", 4.5, "ATTEMPTS"),
        ("ATTEMPTS", True, "ATTEMPTS"),
        ("VOICE", {"text_in": 0.75}, "VOICE"),
        ("LIVE_PROBE", [], "LIVE_PROBE"),
    ],
)
def test_a_malformed_cost_model_export_fails(field: str, value: object, match: str) -> None:
    export = json.loads(cp.run_cost_model_export(REPO_ROOT))
    export[field] = value
    with pytest.raises(cp.CostParityError, match=match):
        cp.parse_cost_model(json.dumps(export), '{"global": {"parent": null, "ceiling_usd": 74.0}}')


# ------------------------------------------------------------------ the comparison


def test_matching_seeds_pass(model: cp.CostModel, seeds: cp.Seeds) -> None:
    assert cp.compare(model, seeds) == []


def test_a_superseded_price_row_is_history(model: cp.CostModel, seeds: cp.Seeds) -> None:
    current = price_of(seeds, "gemini-3.5-flash-lite")
    older = dataclasses.replace(current, effective_from="2026-09-01", text_in=Decimal("9.99"), status="superseded")
    aged = dataclasses.replace(seeds, model_prices=[*seeds.model_prices, older])
    assert cp.compare(model, aged) == []


def test_a_matching_future_price_row_passes(model: cp.CostModel, seeds: cp.Seeds) -> None:
    current = price_of(seeds, "gemini-3.1-flash-lite")
    later = dataclasses.replace(current, effective_from="2026-12-01", status="future")
    assert cp.compare(model, dataclasses.replace(seeds, model_prices=[*seeds.model_prices, later])) == []


def test_text_models_audio_rates_are_not_cost_model_fields(model: cp.CostModel, seeds: cp.Seeds) -> None:
    # The day-1 price lookup appends an audio-input rate for retranscription (S5 Q7); LIABILITY_PRICES has none.
    current = price_of(seeds, "gemini-3.5-flash-lite")
    assert cp.compare(model, with_price(seeds, dataclasses.replace(current, audio_in=Decimal("1.0")))) == []


@pytest.mark.gateproof
def test_a_one_cent_price_change_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    current = price_of(seeds, "gemini-3.5-flash-lite")
    drifted = with_price(seeds, dataclasses.replace(current, text_in=current.text_in + Decimal("0.01")))
    assert cp.compare(model, drifted) == [
        "ops.model_prices[gemini-3.5-flash-lite] in_force from 2026-10-08: text_in=0.31 text_out=2.5 but "
        "cost_model.LIABILITY_PRICES['3.5-flash-lite'] = (0.3, 2.5)"
    ]


@pytest.mark.gateproof
def test_a_wrong_price_in_force_is_not_hidden_by_a_matching_future_row(model: cp.CostModel, seeds: cp.Seeds) -> None:
    # The guard prices calls with the row in force today (ops.price_row), not with the newest row.
    current = price_of(seeds, "gemini-3.5-flash-lite")
    wrong_now = dataclasses.replace(current, text_in=Decimal("0.31"))
    right_later = dataclasses.replace(current, effective_from="2026-12-01", status="future")
    rows = [r for r in seeds.model_prices if r.model != current.model] + [wrong_now, right_later]
    assert cp.compare(model, dataclasses.replace(seeds, model_prices=rows)) == [
        "ops.model_prices[gemini-3.5-flash-lite] in_force from 2026-10-08: text_in=0.31 text_out=2.5 but "
        "cost_model.LIABILITY_PRICES['3.5-flash-lite'] = (0.3, 2.5)"
    ]


@pytest.mark.gateproof
def test_a_future_price_row_that_drifts_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    # A row that takes effect later is checked now, so parity cannot go stale on that date.
    current = price_of(seeds, "gemini-3.1-flash-lite")
    newer = dataclasses.replace(current, effective_from="2026-12-01", text_out=Decimal("1.6"), status="future")
    errors = cp.compare(model, dataclasses.replace(seeds, model_prices=[*seeds.model_prices, newer]))
    assert errors == [
        "ops.model_prices[gemini-3.1-flash-lite] future from 2026-12-01: text_in=0.25 text_out=1.6 but "
        "cost_model.LIABILITY_PRICES['3.1-flash-lite'] = (0.25, 1.5)"
    ]


@pytest.mark.gateproof
def test_a_model_with_only_a_future_row_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    current = price_of(seeds, "gemini-3.8-flash")
    only_later = dataclasses.replace(current, effective_from="2026-12-01", status="future")
    rows = [r for r in seeds.model_prices if r.model != current.model] + [only_later]
    assert cp.compare(model, dataclasses.replace(seeds, model_prices=rows)) == [
        "ops.model_prices has no row in force today for gemini-3.8-flash (cost_model.LIABILITY_PRICES['3.8-flash'])"
    ]


@pytest.mark.gateproof
def test_a_micro_dollar_live_rate_change_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    current = price_of(seeds, "gemini-3.8-live")
    drifted = with_price(seeds, dataclasses.replace(current, audio_out=Decimal("18.000001")))
    assert cp.compare(model, drifted) == [
        "ops.model_prices[gemini-3.8-live] in_force from 2026-10-08: rates (1.125, 6.75, 4.5, 18.000001) but "
        "cost_model.VOICE x 1.5 = (1.125, 6.75, 4.5, 18) (text_in, text_out, audio_in, audio_out)"
    ]


@pytest.mark.gateproof
def test_a_missing_price_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    rows = [r for r in seeds.model_prices if r.model != "gemini-3.8-flash"]
    assert cp.compare(model, dataclasses.replace(seeds, model_prices=rows)) == [
        "ops.model_prices has no row in force today for gemini-3.8-flash (cost_model.LIABILITY_PRICES['3.8-flash'])"
    ]


@pytest.mark.gateproof
def test_a_missing_live_price_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    rows = [r for r in seeds.model_prices if r.model != "gemini-live-2.5-flash-native-audio"]
    assert cp.compare(model, dataclasses.replace(seeds, model_prices=rows)) == [
        "ops.model_prices has no row in force today for gemini-live-2.5-flash-native-audio "
        "(Live, cost_model.VOICE x 1.5)"
    ]


@pytest.mark.gateproof
def test_seeding_gemini_pro_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    pro = cp.PriceRow("gemini-3.1-pro-preview", SEED_DATE, Decimal("2.0"), Decimal("12.0"), None, None)
    assert cp.compare(model, with_price(seeds, pro)) == [
        "ops.model_prices seeds gemini-3.1-pro-preview: D-014 dropped Gemini 3.1 Pro from the product"
    ]


@pytest.mark.gateproof
def test_an_unaccounted_price_row_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    extra = cp.PriceRow("gemini-9-ultra", SEED_DATE, Decimal(1), Decimal(1), None, None)
    assert cp.compare(model, with_price(seeds, extra)) == [
        "ops.model_prices seeds gemini-9-ultra, which neither cost_model.LIABILITY_PRICES nor the Live rows define"
    ]


@pytest.mark.gateproof
def test_a_changed_runtime_limit_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    assert cp.compare(model, with_limit(seeds, "card", (128000, 1601))) == [
        "ops.call_limits['card'] = (128000, 1601) but cost_model.LIMITS['card'] = (128000, 1600)"
    ]


@pytest.mark.gateproof
def test_a_missing_runtime_limit_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    assert cp.compare(model, with_limit(seeds, "deep", None)) == [
        "ops.call_limits['deep'] = None but cost_model.LIMITS['deep'] = (128000, 3000)"
    ]


@pytest.mark.gateproof
@pytest.mark.parametrize("kind", ["generate", "validate"])
def test_seeding_a_d014_call_kind_fails(model: cp.CostModel, seeds: cp.Seeds, kind: str) -> None:
    assert cp.compare(model, with_limit(seeds, kind, model.limits[kind])) == [
        f"ops.call_limits seeds {kind!r}: D-014 removed it from the product (no runtime case generator)"
    ]


@pytest.mark.gateproof
def test_seeding_retranscribe_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    assert cp.compare(model, with_limit(seeds, "retranscribe", (15860, 2000))) == [
        "ops.call_limits seeds 'retranscribe': D7 removed it from the product (voice is display-only)"
    ]


@pytest.mark.gateproof
@pytest.mark.parametrize(("kind", "limits"), [("portrait", (2000, 1999)), ("portrait", None)])
def test_a_drifted_initial_value_limit_fails(
    model: cp.CostModel, seeds: cp.Seeds, kind: str, limits: tuple[int, int] | None
) -> None:
    want = cp.initial_value_limits(model)[kind]
    assert cp.compare(model, with_limit(seeds, kind, limits)) == [
        f"ops.call_limits[{kind!r}] = {limits} but S5 3.3's initial value is {want}"
    ]


@pytest.mark.gateproof
def test_an_unaccounted_call_kind_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    assert cp.compare(model, with_limit(seeds, "summarize", (1000, 100))) == [
        "ops.call_limits seeds 'summarize', which neither cost_model.LIMITS nor S5 3.3 defines"
    ]


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("attempts_per_call", 5, "ops.config.attempts_per_call = 5 but cost_model.ATTEMPTS = 4"),
        (
            "voice_session_reservation_usd",
            Decimal("3.392519"),
            "ops.config.voice_session_reservation_usd = 3.392519 but cost_model.VOICE_RESERVATION as the script "
            "prints it to 6 dp = 3.392520",
        ),
        (
            "voice_probe_reservation_usd",
            Decimal("0.424941"),
            "ops.config.voice_probe_reservation_usd = 0.424941 but cost_model.PROBE_RESERVATION as the script "
            "prints it to 6 dp = 0.424940",
        ),
        ("voice_sessions_total", 9, "ops.config.voice_sessions_total = 9 but cost_model.VOICE_SESSIONS = 8"),
        ("voice_probes_total", 31, "ops.config.voice_probes_total = 31 but cost_model.LIVE_PROBE[0] = 30"),
    ],
)
def test_a_drifted_config_seed_fails(
    model: cp.CostModel, seeds: cp.Seeds, field: str, value: int | Decimal, error: str
) -> None:
    fields = dataclasses.asdict(seeds.config)
    fields[field] = value
    errors = cp.compare(model, dataclasses.replace(seeds, config=cp.ConfigSeed(**fields)))
    assert error in errors


@pytest.mark.gateproof
def test_a_voice_shutoff_drift_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    # The database shuts a voice session off at two thirds of its reservation; that must be VOICE_SHUTOFF.
    shifted = dataclasses.replace(model, voice_shutoff=model.voice_shutoff + Decimal("0.000002"))
    assert cp.compare(shifted, seeds) == [
        "two thirds of ops.config.voice_session_reservation_usd = 2.261680 but cost_model.VOICE_SHUTOFF = 2.261682"
    ]


@pytest.mark.gateproof
def test_a_typed_ceiling_in_the_seed_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    buckets = {**seeds.budget_buckets, "global": (None, Decimal("74.0"))}
    assert cp.compare(model, dataclasses.replace(seeds, budget_buckets=buckets)) == [
        "ops.budget_buckets['global'] seeds (None, 74) but the fail-closed seed is budget_plan()'s shape at $0: "
        "(None, 0) (D-012)"
    ]


@pytest.mark.gateproof
def test_a_bucket_outside_the_plan_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    buckets = {**seeds.budget_buckets, "demo": ("global", Decimal(0))}
    assert cp.compare(model, dataclasses.replace(seeds, budget_buckets=buckets)) == [
        "ops.budget_buckets seeds 'demo', which budget_plan() does not define (D-013: one global ceiling)"
    ]


@pytest.mark.gateproof
def test_a_missing_plan_bucket_fails(model: cp.CostModel, seeds: cp.Seeds) -> None:
    assert cp.compare(model, dataclasses.replace(seeds, budget_buckets={})) == [
        "ops.budget_buckets['global'] seeds None but the fail-closed seed is budget_plan()'s shape at $0: "
        "(None, 0) (D-012)"
    ]


# ------------------------------------------------------------------ the database side


def completed(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["psql"], returncode, stdout, stderr)


def test_read_seeds_runs_one_psql_query(monkeypatch: pytest.MonkeyPatch, seeds: cp.Seeds) -> None:
    calls: list[tuple[str, list[str]]] = []

    def fake_run(tool: str, args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((tool, list(args)))
        return completed(seed_rows_json(seeds) + "\n")

    monkeypatch.setattr("tools.proc.run", fake_run)
    assert cp.read_seeds(DSN) == seeds
    (tool, args), *_more = calls
    assert (tool, len(calls)) == ("psql", 1)
    assert args[:6] == ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
    assert args[args.index("-d") + 1] == DSN
    assert "from ops.config" in args[args.index("-c") + 1]


@pytest.mark.gateproof
@pytest.mark.parametrize("name", cp.LIBPQ_REDIRECTS)
def test_a_libpq_redirect_in_the_environment_fails(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    calls: list[str] = []
    monkeypatch.setattr("tools.proc.run", lambda *a, **_k: calls.append(str(a)))
    monkeypatch.setenv(name, "10.9.9.9")
    with pytest.raises(cp.CostParityError, match=f"{name} set"):
        cp.read_seeds(DSN)
    assert calls == []  # refused before any connection


@pytest.mark.gateproof
def test_a_psql_failure_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tools.proc.run", lambda *_a, **_k: completed(stderr="connection refused", returncode=2))
    with pytest.raises(cp.CostParityError, match="psql exited 2: connection refused"):
        cp.read_seeds(DSN)


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda _d: "not json", "not valid JSON"),
        (lambda d: json.dumps({**d, "config": None}), "config"),
        (lambda d: json.dumps({**d, "call_limits": None}), "call_limits"),
        (lambda d: json.dumps({**d, "model_prices": [{"model": "x"}]}), "model_prices"),
        (
            lambda d: json.dumps({**d, "model_prices": [{**d["model_prices"][0], "status": "maybe"}]}),
            "status",
        ),
        (lambda d: json.dumps({**d, "budget_buckets": [{"name": "global", "parent": None}]}), "budget_buckets"),
        (lambda d: json.dumps({**d, "config": {**d["config"], "attempts_per_call": "4"}}), "attempts_per_call"),
    ],
)
def test_malformed_seed_rows_fail(
    monkeypatch: pytest.MonkeyPatch, seeds: cp.Seeds, mutate: Callable[[dict[str, object]], str], match: str
) -> None:
    doc = json.loads(seed_rows_json(seeds))
    monkeypatch.setattr("tools.proc.run", lambda *_a, **_k: completed(mutate(doc)))
    with pytest.raises(cp.CostParityError, match=match):
        cp.read_seeds(DSN)


# ------------------------------------------------------------------ main


def test_main_passes_on_matching_seeds(
    monkeypatch: pytest.MonkeyPatch, seeds: cp.Seeds, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cp, "read_seeds", lambda _dsn: seeds)
    assert cp.main(["--root", str(REPO_ROOT), "--dsn", DSN]) == 0
    assert "cost-parity: OK" in capsys.readouterr().out


@pytest.mark.gateproof
def test_main_fails_on_drift(
    monkeypatch: pytest.MonkeyPatch, seeds: cp.Seeds, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cp, "read_seeds", lambda _dsn: with_limit(seeds, "card", (128000, 1601)))
    assert cp.main(["--root", str(REPO_ROOT), "--dsn", DSN]) == 1
    assert "cost-parity: FAIL: ops.call_limits['card']" in capsys.readouterr().err


@pytest.mark.gateproof
def test_main_fails_when_the_database_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def unreachable(dsn: str) -> cp.Seeds:
        msg = f"psql exited 2: cannot reach {dsn}"
        raise cp.CostParityError(msg)

    monkeypatch.setattr(cp, "read_seeds", unreachable)
    assert cp.main(["--root", str(REPO_ROOT), "--dsn", DSN]) == 1
    assert "cost-parity: FAIL: psql exited 2" in capsys.readouterr().err


@pytest.mark.gateproof
def test_main_fails_when_psql_is_not_installed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("tools.proc.shutil.which", lambda _name: None)
    assert cp.main(["--root", str(REPO_ROOT), "--dsn", DSN]) == 1
    assert "psql is not on PATH" in capsys.readouterr().err


def test_main_without_a_dsn_checks_the_cost_model_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # py-check's cost-parity target: no database; the cost model must run and parse (db-test passes --dsn).
    monkeypatch.setattr(cp, "read_seeds", lambda _dsn: pytest.fail("no database is read without --dsn"))
    assert cp.main(["--root", str(REPO_ROOT)]) == 0
    assert "cost-parity: OK (cost_model.py" in capsys.readouterr().out


@pytest.mark.gateproof
def test_main_without_a_dsn_fails_on_a_broken_cost_model(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    model = tmp_path / cp.COST_MODEL_PATH
    model.parent.mkdir(parents=True)
    model.write_text("import sys\nsys.exit(3)\n")
    assert cp.main(["--root", str(tmp_path)]) == 1
    assert "cost-parity: FAIL" in capsys.readouterr().err
