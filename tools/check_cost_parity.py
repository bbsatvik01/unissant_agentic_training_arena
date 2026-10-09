"""Cost-parity gate (S4 WI-S4-08, S5 4.9): the spend-guard seeds of a migrated database equal cost_model.py.

`make db-test` runs this against the freshly migrated disposable database (``--dsn``; the password comes from
PGPASSWORD). Without ``--dsn`` (``make cost-parity`` in py-check) it only checks that cost_model.py runs and that its
``--plan-json`` output and the constants below parse. With a database it reads ``ops.config``,
``ops.model_prices``, ``ops.call_limits`` and ``ops.budget_buckets`` with psql and compares them with
``docs/research/synthesis/cost_model.py``, which it runs in isolation (``python -I -B``), exactly as the spec
documents:

- every runtime ``LIMITS`` row (byte-based input limits, D11) equals ``ops.call_limits``; ``portrait`` (not in
  ``LIMITS``) equals S5 3.3's initial value; ``generate``, ``validate`` (D-014) and ``retranscribe`` (D7) are absent;
  no other call kind is seeded;
- every ``LIABILITY_PRICES`` model has an ``ops.model_prices`` row in force today with equal text rates, and so
  does every future-dated row (the guard prices a call with ``ops.price_row``: the newest row whose date has come;
  superseded rows are history); the two Live models equal the ``VOICE`` rates x 1.5 the same way; no other model
  is seeded;
- ``ops.config``: ``attempts_per_call`` = ``ATTEMPTS``; the voice amounts = ``VOICE_RESERVATION`` and
  ``PROBE_RESERVATION`` as the script prints them to 6 dp (S4 8.4: $3.392520, $0.424940); two thirds of the
  session amount = ``VOICE_SHUTOFF``; the session and probe totals = ``VOICE_SESSIONS`` and ``LIVE_PROBE[0]``;
- the bucket table is ``budget_plan()``'s shape (``--plan-json``, one global ceiling) at $0: no ceiling is typed
  in a migration (D-012, D-013).

Every value is compared exactly (``Decimal``), so a one-cent or one-micro-dollar drift fails. Run it as the
migration owner (db-test does): it asks ``ops.price_row`` itself which price row is in force.
"""

import argparse
import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from tools import proc

COST_MODEL_PATH = "docs/research/synthesis/cost_model.py"
SIX_DP = Decimal("0.000001")
PAIR = 2  # (input, output) limits; (input, output) rates

# The only cost-model entries not compared for equality, each by name. D-014 (docs/handoff/DECISIONS.md,
# 2026-10-08): case families are authored offline by Claude agents with Codex review, so no runtime call generates
# or validates a case, and Gemini 3.1 Pro is dropped from the product. cost_model.py keeps these entries for its
# research-time costing only. The gate asserts the database does NOT seed them (a reservation naming them is
# refused, AR007), rather than skipping them silently.
D014_REMOVED_CALL_KINDS: frozenset[str] = frozenset({"generate", "validate"})
D014_REMOVED_PRICE_KEYS: frozenset[str] = frozenset({"3.1-pro-preview"})
# D7 (S4 8.4, TESTS.md BU-01): voice is display-only, so no retranscription call exists and none is seeded.
D7_REMOVED_CALL_KINDS: frozenset[str] = frozenset({"retranscribe"})

# cost_model.py names models without the Vertex prefix ("3.5-flash-lite"); ops.model_prices holds the model id.
MODEL_ID_PREFIX = "gemini-"

# The Live models (S4 8.2) are priced at cost_model.VOICE's rates x 1.5 until the Vertex Live price is confirmed:
# the factor is the k = 1.5 of cost_model.voice_session_reservation(), which sizes VOICE_RESERVATION.
LIVE_MODEL_IDS: tuple[str, ...] = ("gemini-3.8-live", "gemini-live-2.5-flash-native-audio")
LIVE_RATE_FACTOR = Decimal("1.5")

# The call kind absent from cost_model.LIMITS, at S5 3.3's initial value (X-09; tuned in the dev pilot). It moves to
# arena_core/spend/limits.py with WP-05.
PORTRAIT_LIMITS = (2000, 2000)

# Runs cost_model.py as a module (its report blocks are guarded by __name__ == "__main__") and prints the
# constants this gate compares. Floats print as their repr and are read back as Decimal.
_EXPORT = """
import json, runpy, sys
m = runpy.run_path(sys.argv[1], run_name="cost_model_parity")
names = ("LIMITS", "LIABILITY_PRICES", "VOICE", "VOICE_RESERVATION", "PROBE_RESERVATION",
         "VOICE_SHUTOFF", "ATTEMPTS", "VOICE_SESSIONS", "LIVE_PROBE")
print(json.dumps({name: m[name] for name in names}))
"""

# Each price row carries the database's own verdict on it: `in_force` (what ops.price_row returns today, the row
# every reservation and receipt is priced with), `future` (takes effect later) or `superseded` (history).
_SEED_QUERY = """
select json_build_object(
  'config', (select row_to_json(c) from ops.config c),
  'model_prices', (select coalesce(json_agg(json_build_object(
                       'model', p.model, 'effective_from', p.effective_from, 'text_in', p.text_in,
                       'text_out', p.text_out, 'audio_in', p.audio_in, 'audio_out', p.audio_out,
                       'status', case when p.effective_from > current_date then 'future'
                                      when p.effective_from = (select r.effective_from from ops.price_row(p.model) r)
                                        then 'in_force'
                                      else 'superseded' end)
                     order by p.model, p.effective_from), '[]'::json)
                     from ops.model_prices p),
  'call_limits', (select coalesce(json_agg(row_to_json(l) order by l.call_kind), '[]'::json) from ops.call_limits l),
  'budget_buckets', (select coalesce(json_agg(row_to_json(b) order by b.name), '[]'::json) from ops.budget_buckets b))
"""


class CostParityError(ValueError):
    """The cost model or the database could not be read, or held a malformed value."""


@dataclass(frozen=True)
class CostModel:
    limits: dict[str, tuple[int, int]]
    liability_prices: dict[str, tuple[Decimal, Decimal]]
    voice_rates: tuple[Decimal, Decimal, Decimal, Decimal]  # text_in, text_out, audio_in, audio_out per 1M tokens
    voice_reservation: Decimal
    probe_reservation: Decimal
    voice_shutoff: Decimal
    attempts: int
    voice_sessions: int
    live_probes: int
    plan: dict[str, tuple[str | None, Decimal]]


PRICE_STATUSES: tuple[str, ...] = ("in_force", "future", "superseded")


@dataclass(frozen=True)
class PriceRow:
    model: str
    effective_from: str
    text_in: Decimal
    text_out: Decimal
    audio_in: Decimal | None
    audio_out: Decimal | None
    status: str = "in_force"  # the database's verdict (_SEED_QUERY): in_force, future or superseded


@dataclass(frozen=True)
class ConfigSeed:
    attempts_per_call: int
    voice_session_reservation_usd: Decimal
    voice_probe_reservation_usd: Decimal
    voice_sessions_total: int
    voice_probes_total: int


@dataclass(frozen=True)
class Seeds:
    config: ConfigSeed
    model_prices: list[PriceRow]
    call_limits: dict[str, tuple[int, int]]
    budget_buckets: dict[str, tuple[str | None, Decimal]]


# ------------------------------------------------------------------ typed reads of parsed JSON


def _int(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        msg = f"{where} must be an integer, got {value!r}"
        raise CostParityError(msg)
    return value


def _dec(value: object, where: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        msg = f"{where} must be a number, got {value!r}"
        raise CostParityError(msg)
    number = Decimal(value)
    if not number.is_finite() or number < 0:
        msg = f"{where} must be a finite non-negative number, got {value!r}"
        raise CostParityError(msg)
    return number


def _status(value: object, where: str) -> str:
    if value not in PRICE_STATUSES:
        msg = f"{where} must be one of {PRICE_STATUSES}, got {value!r}"
        raise CostParityError(msg)
    return str(value)


def _opt_dec(value: object, where: str) -> Decimal | None:
    return None if value is None else _dec(value, where)


def _str(value: object, where: str) -> str:
    if not isinstance(value, str):
        msg = f"{where} must be a string, got {value!r}"
        raise CostParityError(msg)
    return value


def _obj(value: object, where: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        msg = f"{where} must be a JSON object, got {value!r}"
        raise CostParityError(msg)
    return value


def _list(value: object, where: str) -> list[object]:
    if not isinstance(value, list):
        msg = f"{where} must be a JSON array, got {value!r}"
        raise CostParityError(msg)
    return value


def _pair(value: object, where: str) -> list[object]:
    pair = _list(value, where)
    if len(pair) != PAIR:
        msg = f"{where} must hold two values, got {value!r}"
        raise CostParityError(msg)
    return pair


def _loads(text: str, what: str) -> object:
    try:
        return json.loads(text, parse_float=Decimal)
    except json.JSONDecodeError as exc:
        msg = f"{what} is not valid JSON: {exc}"
        raise CostParityError(msg) from exc


# ------------------------------------------------------------------ the cost model


def parse_plan_json(stdout: str) -> dict[str, tuple[str | None, Decimal]]:
    """``cost_model.py --plan-json``: ``{bucket: {"parent": name or null, "ceiling_usd": number}}``."""
    try:
        parsed = json.loads(stdout, parse_float=Decimal)
    except json.JSONDecodeError as exc:
        msg = f"cost_model.py --plan-json did not print valid JSON: {exc}"
        raise CostParityError(msg) from exc
    if not isinstance(parsed, dict) or not parsed:
        msg = f"cost_model.py --plan-json printed {parsed!r}, expected a non-empty JSON object"
        raise CostParityError(msg)
    plan: dict[str, tuple[str | None, Decimal]] = {}
    for name, entry in parsed.items():
        body = _obj(entry, f"--plan-json[{name!r}]")
        parent = body.get("parent")
        if parent is not None and not isinstance(parent, str):
            msg = f"--plan-json[{name!r}].parent must be a bucket name or null, got {parent!r}"
            raise CostParityError(msg)
        plan[name] = (parent, _dec(body.get("ceiling_usd"), f"--plan-json[{name!r}].ceiling_usd"))
    return plan


def run_plan_json(root: Path) -> str:
    """Invoke cost_model.py the way the spec documents it: ``python3 -I -B ... --plan-json``."""
    result = proc.run("python", ["-I", "-B", str(_cost_model(root)), "--plan-json"], cwd=root)
    if result.returncode != 0:
        msg = f"cost_model.py --plan-json exited {result.returncode}: {result.stderr.strip()}"
        raise CostParityError(msg)
    return result.stdout


def run_cost_model_export(root: Path) -> str:
    """The constants this gate compares, as JSON, from an isolated run of cost_model.py."""
    result = proc.run("python", ["-I", "-B", "-c", _EXPORT, str(_cost_model(root))], cwd=root)
    if result.returncode != 0:
        msg = f"cost_model.py export exited {result.returncode}: {result.stderr.strip()[-500:]}"
        raise CostParityError(msg)
    return result.stdout


def _cost_model(root: Path) -> Path:
    path = root / COST_MODEL_PATH
    if not path.is_file():
        msg = f"{COST_MODEL_PATH} is missing"
        raise CostParityError(msg)
    return path


def parse_cost_model(export_stdout: str, plan_stdout: str) -> CostModel:
    doc = _obj(_loads(export_stdout, "the cost_model.py export"), "the cost_model.py export")
    limits = {
        kind: (_int(pair[0], f"LIMITS[{kind!r}]"), _int(pair[1], f"LIMITS[{kind!r}]"))
        for kind, value in _obj(doc.get("LIMITS"), "LIMITS").items()
        for pair in [_pair(value, f"LIMITS[{kind!r}]")]
    }
    prices = {
        key: (_dec(pair[0], f"LIABILITY_PRICES[{key!r}]"), _dec(pair[1], f"LIABILITY_PRICES[{key!r}]"))
        for key, value in _obj(doc.get("LIABILITY_PRICES"), "LIABILITY_PRICES").items()
        for pair in [_pair(value, f"LIABILITY_PRICES[{key!r}]")]
    }
    voice = _obj(doc.get("VOICE"), "VOICE")
    live_probe = _list(doc.get("LIVE_PROBE"), "LIVE_PROBE")
    if not live_probe:
        msg = "LIVE_PROBE must start with the probe-session count"
        raise CostParityError(msg)
    return CostModel(
        limits=limits,
        liability_prices=prices,
        voice_rates=(
            _dec(voice.get("text_in"), "VOICE['text_in']"),
            _dec(voice.get("text_out"), "VOICE['text_out']"),
            _dec(voice.get("audio_in"), "VOICE['audio_in']"),
            _dec(voice.get("audio_out"), "VOICE['audio_out']"),
        ),
        voice_reservation=_dec(doc.get("VOICE_RESERVATION"), "VOICE_RESERVATION"),
        probe_reservation=_dec(doc.get("PROBE_RESERVATION"), "PROBE_RESERVATION"),
        voice_shutoff=_dec(doc.get("VOICE_SHUTOFF"), "VOICE_SHUTOFF"),
        attempts=_int(doc.get("ATTEMPTS"), "ATTEMPTS"),
        voice_sessions=_int(doc.get("VOICE_SESSIONS"), "VOICE_SESSIONS"),
        live_probes=_int(live_probe[0], "LIVE_PROBE[0]"),
        plan=parse_plan_json(plan_stdout),
    )


def load_cost_model(root: Path) -> CostModel:
    return parse_cost_model(run_cost_model_export(root), run_plan_json(root))


def printed6(value: Decimal) -> Decimal:
    """The value as cost_model.py prints it to 6 decimals (S4 8.4 seeds $3.392520 and $0.424940). The export carries
    each float's shortest repr (0.42494000000000004), so its binary noise below 1e-6 never moves a cent here."""
    return value.quantize(SIX_DP, rounding=ROUND_HALF_UP)


def live_rates(cm: CostModel) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    text_in, text_out, audio_in, audio_out = (rate * LIVE_RATE_FACTOR for rate in cm.voice_rates)
    return text_in, text_out, audio_in, audio_out


def initial_value_limits(cm: CostModel) -> dict[str, tuple[int, int]]:
    """S5 3.3's initial values for the call kinds cost_model.LIMITS lacks (the cost model wins once it has one)."""
    initial = {"portrait": PORTRAIT_LIMITS}
    return {kind: limits for kind, limits in initial.items() if kind not in cm.limits}


# ------------------------------------------------------------------ the database


def parse_seeds(stdout: str) -> Seeds:
    doc = _obj(_loads(stdout.strip(), "the seed query result"), "the seed query result")
    config = _obj(doc.get("config"), "config")
    prices = []
    for i, raw in enumerate(_list(doc.get("model_prices"), "model_prices")):
        row = _obj(raw, f"model_prices[{i}]")
        model = _str(row.get("model"), f"model_prices[{i}].model")
        prices.append(
            PriceRow(
                model=model,
                effective_from=_str(row.get("effective_from"), f"model_prices[{model}].effective_from"),
                text_in=_dec(row.get("text_in"), f"model_prices[{model}].text_in"),
                text_out=_dec(row.get("text_out"), f"model_prices[{model}].text_out"),
                audio_in=_opt_dec(row.get("audio_in"), f"model_prices[{model}].audio_in"),
                audio_out=_opt_dec(row.get("audio_out"), f"model_prices[{model}].audio_out"),
                status=_status(row.get("status"), f"model_prices[{model}].status"),
            )
        )
    limits = {}
    for i, raw in enumerate(_list(doc.get("call_limits"), "call_limits")):
        row = _obj(raw, f"call_limits[{i}]")
        kind = _str(row.get("call_kind"), f"call_limits[{i}].call_kind")
        limits[kind] = (
            _int(row.get("input_limit"), f"call_limits[{kind}].input_limit"),
            _int(row.get("output_limit"), f"call_limits[{kind}].output_limit"),
        )
    buckets = {}
    for i, raw in enumerate(_list(doc.get("budget_buckets"), "budget_buckets")):
        row = _obj(raw, f"budget_buckets[{i}]")
        name = _str(row.get("name"), f"budget_buckets[{i}].name")
        parent = row.get("parent")
        buckets[name] = (
            None if parent is None else _str(parent, f"budget_buckets[{name}].parent"),
            _dec(row.get("ceiling_usd"), f"budget_buckets[{name}].ceiling_usd"),
        )
    return Seeds(
        config=ConfigSeed(
            attempts_per_call=_int(config.get("attempts_per_call"), "config.attempts_per_call"),
            voice_session_reservation_usd=_dec(
                config.get("voice_session_reservation_usd"), "config.voice_session_reservation_usd"
            ),
            voice_probe_reservation_usd=_dec(
                config.get("voice_probe_reservation_usd"), "config.voice_probe_reservation_usd"
            ),
            voice_sessions_total=_int(config.get("voice_sessions_total"), "config.voice_sessions_total"),
            voice_probes_total=_int(config.get("voice_probes_total"), "config.voice_probes_total"),
        ),
        model_prices=prices,
        call_limits=limits,
        budget_buckets=buckets,
    )


# libpq environment variables that would send psql somewhere other than --dsn says (PGHOSTADDR wins over a host
# name; a service file can add a hostaddr). The gate refuses to run with any of them set rather than compare the
# seeds of an unintended database.
LIBPQ_REDIRECTS: tuple[str, ...] = ("PGHOSTADDR", "PGHOST", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE")


def read_seeds(dsn: str) -> Seeds:
    """One read-only query through psql (no Python driver in the gate environment)."""
    redirects = [name for name in LIBPQ_REDIRECTS if os.environ.get(name)]
    if redirects:
        msg = f"{', '.join(redirects)} set: libpq could connect somewhere other than --dsn; unset it"
        raise CostParityError(msg)
    result = proc.run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", dsn, "-c", _SEED_QUERY])
    if result.returncode != 0:
        msg = f"psql exited {result.returncode}: {result.stderr.strip()}"
        raise CostParityError(msg)
    return parse_seeds(result.stdout)


# ------------------------------------------------------------------ the comparison


def _num(value: Decimal | None) -> str:
    return "None" if value is None else format(value.normalize(), "f")


def _compare_limits(cm: CostModel, seeds: Seeds) -> list[str]:
    errors = []
    for kind, want in cm.limits.items():
        got = seeds.call_limits.get(kind)
        if kind in D014_REMOVED_CALL_KINDS:
            if got is not None:
                errors.append(
                    f"ops.call_limits seeds {kind!r}: D-014 removed it from the product (no runtime case generator)"
                )
        elif got != want:
            errors.append(f"ops.call_limits[{kind!r}] = {got} but cost_model.LIMITS[{kind!r}] = {want}")
    errors.extend(
        f"ops.call_limits seeds {kind!r}: D7 removed it from the product (voice is display-only)"
        for kind in sorted(D7_REMOVED_CALL_KINDS & set(seeds.call_limits))
    )
    initial = initial_value_limits(cm)
    for kind, want in initial.items():
        got = seeds.call_limits.get(kind)
        if got != want:
            errors.append(f"ops.call_limits[{kind!r}] = {got} but S5 3.3's initial value is {want}")
    known = set(cm.limits) | set(initial) | D7_REMOVED_CALL_KINDS
    errors.extend(
        f"ops.call_limits seeds {kind!r}, which neither cost_model.LIMITS nor S5 3.3 defines"
        for kind in sorted(set(seeds.call_limits) - known)
    )
    return errors


def _compare_prices(cm: CostModel, seeds: Seeds) -> list[str]:
    in_force: dict[str, PriceRow] = {}
    binding: dict[str, list[PriceRow]] = {}  # rows that price calls now (in force) or later (future)
    for seeded in seeds.model_prices:
        if seeded.status == "superseded":
            continue  # prices are append-only by date: a superseded row is history, never used again
        binding.setdefault(seeded.model, []).append(seeded)
        if seeded.status == "in_force":
            in_force[seeded.model] = seeded
    errors = []
    accounted = set(LIVE_MODEL_IDS)
    for key, (p_in, p_out) in cm.liability_prices.items():
        model = MODEL_ID_PREFIX + key
        accounted.add(model)
        if key in D014_REMOVED_PRICE_KEYS:
            if any(r.model == model for r in seeds.model_prices):
                errors.append(f"ops.model_prices seeds {model}: D-014 dropped Gemini 3.1 Pro from the product")
            continue
        if model not in in_force:
            errors.append(
                f"ops.model_prices has no row in force today for {model} (cost_model.LIABILITY_PRICES[{key!r}])"
            )
        errors.extend(
            f"ops.model_prices[{model}] {row.status} from {row.effective_from}: text_in={_num(row.text_in)} "
            f"text_out={_num(row.text_out)} but cost_model.LIABILITY_PRICES[{key!r}] = ({_num(p_in)}, {_num(p_out)})"
            for row in binding.get(model, [])
            if (row.text_in, row.text_out) != (p_in, p_out)
        )
    want = live_rates(cm)
    for model in LIVE_MODEL_IDS:
        if model not in in_force:
            errors.append(f"ops.model_prices has no row in force today for {model} (Live, cost_model.VOICE x 1.5)")
        for row in binding.get(model, []):
            got = (row.text_in, row.text_out, row.audio_in, row.audio_out)
            if got != want:
                errors.append(
                    f"ops.model_prices[{model}] {row.status} from {row.effective_from}: rates "
                    f"({', '.join(map(_num, got))}) but cost_model.VOICE x 1.5 = ({', '.join(map(_num, want))}) "
                    "(text_in, text_out, audio_in, audio_out)"
                )
    errors.extend(
        f"ops.model_prices seeds {model}, which neither cost_model.LIABILITY_PRICES nor the Live rows define"
        for model in sorted(set(binding) - accounted)
    )
    return errors


def _compare_config(cm: CostModel, seeds: Seeds) -> list[str]:
    config = seeds.config
    errors = [
        f"ops.config.{field} = {got} but cost_model.{source} = {want}"
        for field, got, source, want in (
            ("attempts_per_call", config.attempts_per_call, "ATTEMPTS", cm.attempts),
            ("voice_sessions_total", config.voice_sessions_total, "VOICE_SESSIONS", cm.voice_sessions),
            ("voice_probes_total", config.voice_probes_total, "LIVE_PROBE[0]", cm.live_probes),
        )
        if got != want
    ]
    errors.extend(
        f"ops.config.{field} = {got:f} but cost_model.{source} as the script prints it to 6 dp = {want:f}"
        for field, got, source, want in (
            (
                "voice_session_reservation_usd",
                config.voice_session_reservation_usd,
                "VOICE_RESERVATION",
                printed6(cm.voice_reservation),
            ),
            (
                "voice_probe_reservation_usd",
                config.voice_probe_reservation_usd,
                "PROBE_RESERVATION",
                printed6(cm.probe_reservation),
            ),
        )
        if got != want
    )
    # The database shuts a voice session off at two thirds of its reservation (ops.record_usage, ops.reserve_voice).
    shutoff = (config.voice_session_reservation_usd * 2 / 3).quantize(SIX_DP, rounding=ROUND_HALF_UP)
    want_shutoff = cm.voice_shutoff.quantize(SIX_DP, rounding=ROUND_HALF_UP)
    if shutoff != want_shutoff:
        errors.append(
            f"two thirds of ops.config.voice_session_reservation_usd = {shutoff:f} but cost_model.VOICE_SHUTOFF = "
            f"{want_shutoff:f}"
        )
    return errors


def _compare_buckets(cm: CostModel, seeds: Seeds) -> list[str]:
    errors = []
    for name, (parent, _ceiling) in cm.plan.items():
        got = seeds.budget_buckets.get(name)
        if got != (parent, Decimal(0)):
            shown = "None" if got is None else f"({got[0]!r}, {_num(got[1])})"
            errors.append(
                f"ops.budget_buckets[{name!r}] seeds {shown} but the fail-closed seed is budget_plan()'s shape at $0: "
                f"({parent!r}, 0) (D-012)"
            )
    errors.extend(
        f"ops.budget_buckets seeds {name!r}, which budget_plan() does not define (D-013: one global ceiling)"
        for name in sorted(set(seeds.budget_buckets) - set(cm.plan))
    )
    return errors


def compare(cm: CostModel, seeds: Seeds) -> list[str]:
    return [
        *_compare_limits(cm, seeds),
        *_compare_prices(cm, seeds),
        *_compare_config(cm, seeds),
        *_compare_buckets(cm, seeds),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--dsn", help="a freshly migrated database (password from PGPASSWORD); db-test passes it")
    args = parser.parse_args(argv)
    try:
        model = load_cost_model(args.root)
        if args.dsn is None:
            sys.stdout.write(
                "cost-parity: OK (cost_model.py runs; --plan-json and the parity constants parse; the seed parity "
                "runs in db-test)\n"
            )
            return 0
        errors = compare(model, read_seeds(args.dsn))
    except (CostParityError, LookupError) as exc:
        sys.stderr.write(f"cost-parity: FAIL: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"cost-parity: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write(
        f"cost-parity: OK ({len(model.limits) - len(D014_REMOVED_CALL_KINDS)} LIMITS rows, "
        f"{len(model.liability_prices) - len(D014_REMOVED_PRICE_KEYS)} LIABILITY_PRICES models, "
        f"{len(LIVE_MODEL_IDS)} Live rows, voice amounts and the $0 plan-shaped seed equal cost_model.py)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
