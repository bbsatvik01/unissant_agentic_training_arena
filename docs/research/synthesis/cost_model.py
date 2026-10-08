"""Reproducible cost model for the arena bake-off (research artifact, not product code).

Every dollar figure in docs/research/synthesis/02-direction.md section 8 comes from this file.
Run: python3 -I -B docs/research/synthesis/cost_model.py

Design rule (critique rounds 1-2): each lineup is DATA (subjects, assistant stage schedules,
final-finding model, referee calls) and every costing path (dev pilot, sealed interactive,
replay) reads the same data. Estimates (expected/high) are kept separate from the worst-case
RESERVATION the spend guard must hold before a block starts.

Prices: Vertex AI (Agent Platform) global list prices per 1M tokens, captured 2026-10-08
(X8; confirmed by Codex rounds 1-2 against the official pricing page). Thinking tokens bill at
the output rate. Batch is 50% of list. No context-cache discount is assumed (the static prefix
may sit below the 4,096-6,144 token implicit-cache minimum; X3, unresolved).
Token counts are ASSUMPTIONS until the dev pilot measures them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PRICES = {  # model: (input $/1M, output $/1M)
    "3.1-flash-lite": (0.25, 1.50),
    "3.5-flash-lite": (0.30, 2.50),
    "3.8-flash": (0.75, 3.75),
    "3.1-pro-preview": (2.00, 12.00),
}
BATCH = 0.5
THINK = {"MINIMAL": (80, 200), "LOW": (400, 1000), "HIGH": (6000, 12000)}  # expected, high
THINK_CAP = {"MINIMAL": 512, "LOW": 2048, "HIGH": 16384}  # manifest caps used for reservations
EXCHANGES = 12          # sponsor cap (BKO-8); costed at the cap, not an average
CONTEXT_LIMIT = 8000    # manifest max input tokens per call (BKO-5), used for reservations
OUTPUT_CAP = 700        # manifest max output tokens per call, used for reservations
RELEASES = (3, 6)       # evidence-release events per trial (expected, high); each triggers a deep stage


@dataclass(frozen=True)
class Call:
    model: str
    tokens_in: int
    tokens_out: int
    think: str
    batch: bool = False

    def cost(self, high: bool) -> float:
        p_in, p_out = PRICES[self.model]
        scale = 1.25 if high else 1.0
        think = THINK[self.think][1 if high else 0]
        c = (self.tokens_in * scale * p_in + (self.tokens_out * scale + think) * p_out) / 1e6
        return c * (BATCH if self.batch else 1.0)

    def reservation(self) -> float:
        p_in, p_out = PRICES[self.model]
        c = (CONTEXT_LIMIT * p_in + (OUTPUT_CAP + THINK_CAP[self.think]) * p_out) / 1e6
        return c * (BATCH if self.batch else 1.0)

    def batched(self) -> "Call":
        return Call(self.model, self.tokens_in, self.tokens_out, self.think, batch=True)


@dataclass(frozen=True)
class Assistant:
    every_turn: Call                 # complete card each exchange: flags, follow-up, finding, confidence (AST-3)
    deep: Call | None = None         # optional deeper update
    deep_every: int = 3              # cadence of the deep update, plus one per evidence release
    final: Call | None = None        # committed final finding


@dataclass(frozen=True)
class Lineup:
    name: str
    subjects: dict[str, Call]
    assistants: dict[str, Assistant]
    referee: list[Call]              # per-trial offline calls (batch): independent labels, fidelity, flag support, questioning
    replay_referee: list[Call]       # replay has no live subject: flag support + questioning quality
    gen_hidden: Call = Call("3.1-pro-preview", 8000, 14000, "HIGH")
    gen_dev: Call = Call("3.8-flash", 8000, 14000, "LOW")
    gen_validate: list[Call] = field(default_factory=lambda: [Call("3.8-flash", 16000, 1200, "LOW")] * 3)


CARD_FLASH_LITE_35 = Call("3.5-flash-lite", 3000, 260, "MINIMAL")
CARD_SINGLE_35 = Call("3.5-flash-lite", 3200, 340, "MINIMAL")
CARD_SINGLE_31 = Call("3.1-flash-lite", 3200, 340, "MINIMAL")

REFEREE_38 = [  # different checkpoint from every power-first subject (F16)
    Call("3.8-flash", 8000, 1000, "LOW", batch=True),  # independent evasion labels + fidelity, every subject turn
    Call("3.8-flash", 7000, 700, "LOW", batch=True),   # flag support + questioning quality
]

LINEUPS = {
    "full": Lineup(
        name="full",
        subjects={"S1": Call("3.1-flash-lite", 3500, 200, "MINIMAL"),
                  "S2": Call("3.5-flash-lite", 3500, 200, "MINIMAL"),
                  "S3": Call("3.8-flash", 3500, 200, "LOW")},
        assistants={"A1": Assistant(CARD_FLASH_LITE_35, Call("3.8-flash", 3500, 250, "LOW"), 3,
                                    Call("3.8-flash", 4000, 250, "LOW")),
                    "A2": Assistant(CARD_SINGLE_35, final=Call("3.5-flash-lite", 4000, 250, "MINIMAL")),
                    "A3": Assistant(CARD_SINGLE_31, final=Call("3.1-flash-lite", 4000, 250, "MINIMAL"))},
        referee=REFEREE_38,
        replay_referee=[REFEREE_38[1]],
    ),
    "power-first": Lineup(
        name="power-first",
        subjects={"S1": Call("3.1-flash-lite", 3500, 200, "MINIMAL"),
                  "S2": Call("3.5-flash-lite", 3500, 200, "MINIMAL"),
                  "S3": Call("3.5-flash-lite", 3800, 200, "MINIMAL")},  # skilled-deceiver policy
        assistants={"A1": Assistant(CARD_FLASH_LITE_35, Call("3.5-flash-lite", 3500, 250, "MINIMAL"), 3,
                                    Call("3.5-flash-lite", 4000, 250, "MINIMAL")),
                    "A2": Assistant(CARD_SINGLE_35, final=Call("3.5-flash-lite", 4000, 250, "MINIMAL")),
                    "A3": Assistant(CARD_SINGLE_31, final=Call("3.1-flash-lite", 4000, 250, "MINIMAL"))},
        referee=REFEREE_38,
        replay_referee=[REFEREE_38[1]],
    ),
}

# Preparation experiments (section 13.1), costed explicitly (expected, high).
EXPERIMENTS = {
    "latency benchmark (complete card; 3 models x 2 context lengths x 200 calls)": (
        lambda high: 1200 * (CARD_SINGLE_35.cost(high) + CARD_SINGLE_31.cost(high)
                             + Call("3.8-flash", 3200, 340, "LOW").cost(high)) / 3),
    "Live probe matrix (~30 short sessions, assumed $0.05 each)": (lambda high: 30 * (0.05 if not high else 0.10)),
    "case-generation pilot (3 families)": (lambda high: 3 * (Call("3.1-pro-preview", 8000, 14000, "HIGH").cost(high)
                                                             + 3 * Call("3.8-flash", 16000, 1200, "LOW").cost(high))),
    "fidelity pilot (3 subjects x 2 roles x 3 cases x 12 turns)": (
        lambda high: 18 * EXCHANGES * Call("3.8-flash", 3500, 200, "LOW").cost(high)),
}


def deep_calls_per_trial(a: Assistant, high: bool) -> int:
    if a.deep is None:
        return 0
    return -(-EXCHANGES // a.deep_every) + RELEASES[1 if high else 0]


def assistant_trial(a: Assistant, high: bool, batch: bool = False) -> float:
    def c(call: Call) -> float:
        return (call.batched() if batch else call).cost(high)
    total = EXCHANGES * c(a.every_turn)
    if a.deep is not None:
        total += deep_calls_per_trial(a, high) * c(a.deep)
    if a.final is not None:
        total += c(a.final)
    return total


def trial_cost(lu: Lineup, a: str, s: str, high: bool) -> float:
    return (EXCHANGES * lu.subjects[s].cost(high) + assistant_trial(lu.assistants[a], high)
            + sum(r.cost(high) for r in lu.referee))


def trial_reservation(lu: Lineup, a: str, s: str) -> float:
    asst = lu.assistants[a]
    deep = (-(-EXCHANGES // asst.deep_every) + RELEASES[1]) if asst.deep else 0
    return (EXCHANGES * lu.subjects[s].reservation() + EXCHANGES * asst.every_turn.reservation()
            + (deep * asst.deep.reservation() if asst.deep else 0.0)
            + (asst.final.reservation() if asst.final else 0.0)
            + sum(r.reservation() for r in lu.referee))


def interactive(lu: Lineup, cases: int, repeats: int, high: bool) -> float:
    return sum(trial_cost(lu, a, s, high) for a in lu.assistants for s in lu.subjects) * cases * repeats


def replay(lu: Lineup, transcripts: int, high: bool) -> float:
    """Every assistant re-scores the same frozen transcripts (BKO-6) with the same stage schedule, batch-priced."""
    per = sum(assistant_trial(a, high, batch=True) + sum(r.cost(high) for r in lu.replay_referee)
              for a in lu.assistants.values())
    return per * transcripts


def generation(lu: Lineup, dev_families: int, hidden_families: int, high: bool) -> float:
    validate = sum(v.cost(high) for v in lu.gen_validate)
    return hidden_families * (lu.gen_hidden.cost(high) + validate) + dev_families * (lu.gen_dev.cost(high) + validate)


def experiments(high: bool) -> float:
    return sum(f(high) for f in EXPERIMENTS.values())


def plan(lu: Lineup, sealed_cases: int, repeats: int, dev_cases: int, high: bool) -> dict[str, float]:
    """Preparation = experiments + generation + dev pilot; bake-off = sealed interactive + replay. 15% reserve each."""
    prep = experiments(high) + generation(lu, dev_cases // 2, sealed_cases // 2, high) + interactive(lu, dev_cases, 1, high)
    bake = interactive(lu, sealed_cases, repeats, high) + replay(lu, sealed_cases, high)
    return {"prep": prep * 1.15, "bake": bake * 1.15, "total": (prep + bake) * 1.15}


def block_reservation(lu: Lineup) -> float:
    """Worst-case cost of one block (one family, both variants, all nine pairings, one repeat)."""
    return 2 * sum(trial_reservation(lu, a, s) for a in lu.assistants for s in lu.subjects)


if __name__ == "__main__":
    for lu in LINEUPS.values():
        print(f"\nLineup {lu.name}: per-trial expected / high (12 exchanges incl. referee)")
        for a in lu.assistants:
            print("  " + a + ": " + "  ".join(
                f"{s} ${trial_cost(lu, a, s, False):.4f}/${trial_cost(lu, a, s, True):.4f}" for s in lu.subjects))
        print(f"  worst-case reservation per block (18 trials): ${block_reservation(lu):.2f}")
    print("\nPreparation experiments (expected / high):")
    for k, f in EXPERIMENTS.items():
        print(f"  {k:<70} ${f(False):6.2f} / ${f(True):6.2f}")
    print("\nGrid (each part includes a 15% reserve). Columns: prep, bake-off, total as expected | high")
    for lu in LINEUPS.values():
        for sealed, reps, dev in ((40, 1, 20), (60, 1, 20), (80, 1, 20), (120, 1, 20), (120, 1, 40), (120, 2, 40)):
            e, h = plan(lu, sealed, reps, dev, False), plan(lu, sealed, reps, dev, True)
            label = f"{lu.name:<12} sealed 3x3x{sealed}x{reps}, dev {dev}"
            print(f"  {label:<40} prep {e['prep']:6.1f} | {h['prep']:6.1f}   bake {e['bake']:6.1f} | {h['bake']:6.1f}"
                  f"   total {e['total']:6.1f} | {h['total']:6.1f}")
