"""Reproducible cost model for the arena bake-off (research artifact, not product code).

Every figure in docs/research/synthesis/02-direction.md section 8 comes from this file.
Run: python3 docs/research/synthesis/cost_model.py

Prices are Vertex AI (Agent Platform) global list prices per 1M tokens, captured 2026-10-08
(X8, confirmed by Codex round 1 against cloud.google.com/gemini-enterprise-agent-platform/
generative-ai/pricing). Thinking tokens bill at the output rate. Batch is 50% of list.
Token counts are ASSUMPTIONS to be replaced by the dev-pilot measurements; the "high"
scenario raises every uncertain quantity so the sealed run is sized against it.
No context-cache discount is applied: the static prefix (case packet + policy) may sit
below the 4,096-6,144 token implicit-cache minimum (X3 contradiction, unresolved).
"""

from __future__ import annotations

from dataclasses import dataclass

PRICES = {  # model: (input $/1M, output $/1M)
    "3.1-flash-lite": (0.25, 1.50),
    "3.5-flash-lite": (0.30, 2.50),
    "3.8-flash": (0.75, 3.75),
    "3.1-pro-preview": (2.00, 12.00),
}
BATCH = 0.5

# Thinking tokens per call by thinking level (assumed ranges: expected, high).
THINK = {"MINIMAL": (80, 200), "LOW": (400, 1000), "HIGH": (6000, 12000)}


@dataclass(frozen=True)
class Call:
    model: str
    tokens_in: int
    tokens_out: int
    think: str
    batch: bool = False

    def cost(self, high: bool) -> float:
        p_in, p_out = PRICES[self.model]
        think = THINK[self.think][1 if high else 0]
        scale = 1.25 if high else 1.0  # high scenario: prompts and outputs 25% longer
        c = (self.tokens_in * scale * p_in + (self.tokens_out * scale + think) * p_out) / 1e6
        return c * (BATCH if self.batch else 1.0)


EXCHANGES = 12  # sponsor cap (BKO-8); sized at the cap, not an average

# Candidate lineups (section 8 of the direction). Subjects play both roles.
# "full": S3 on 3.8-flash (no MINIMAL tier, so LOW thinking). "lean": S3 is a
# skilled-deceiver policy on 3.5-flash-lite, so subjects differ by model and policy.
SUBJECT_LINEUPS = {
    "full": {
        "S1": Call("3.1-flash-lite", 3500, 200, "MINIMAL"),
        "S2": Call("3.5-flash-lite", 3500, 200, "MINIMAL"),
        "S3": Call("3.8-flash", 3500, 200, "LOW"),
    },
    "lean": {
        "S1": Call("3.1-flash-lite", 3500, 200, "MINIMAL"),
        "S2": Call("3.5-flash-lite", 3500, 200, "MINIMAL"),
        "S3": Call("3.5-flash-lite", 3800, 200, "MINIMAL"),
    },
}
SUBJECTS = SUBJECT_LINEUPS["full"]
STAGE2_EVERY = 3  # A1 runs its deep stage every 3rd exchange and on new evidence
# Assistant per-exchange calls. A1 is two-stage; A2 and A3 are single-call designs.
ASSISTANTS = {
    "A1": [Call("3.5-flash-lite", 3000, 180, "MINIMAL"), Call("3.8-flash", 3500, 250, "LOW")],
    "A2": [Call("3.5-flash-lite", 3200, 300, "MINIMAL")],
    "A3": [Call("3.1-flash-lite", 3200, 300, "MINIMAL")],
}
FINAL_FINDING = {"A1": Call("3.8-flash", 4000, 250, "LOW"),
                 "A2": Call("3.5-flash-lite", 4000, 250, "MINIMAL"),
                 "A3": Call("3.1-flash-lite", 4000, 250, "MINIMAL")}

# Power-first variant: every assistant stage, final finding and scorer call on Flash-Lite
# tiers, two combined scoring calls, so 120 hidden cases fit the cap.
POWER_FIRST_ASSISTANTS = {
    "A1": [Call("3.5-flash-lite", 3000, 180, "MINIMAL"), Call("3.5-flash-lite", 3500, 250, "MINIMAL")],
    "A2": [Call("3.5-flash-lite", 3200, 300, "MINIMAL")],
    "A3": [Call("3.1-flash-lite", 3200, 300, "MINIMAL")],
}
POWER_FIRST_SCORING = [
    Call("3.5-flash-lite", 8000, 1000, "MINIMAL", batch=True),  # evasion labels + fidelity
    Call("3.5-flash-lite", 7000, 700, "MINIMAL", batch=True),   # flag support + questioning quality
]

# Offline scoring per trial, batch-priced, independent of the subject (F16):
# evasion-event labels for every subject turn, flag-support judge (F17),
# subject fidelity judge, questioning-quality judge.
SCORING = [
    Call("3.8-flash", 7000, 600, "LOW", batch=True),  # independent evasion labels
    Call("3.8-flash", 7000, 400, "LOW", batch=True),  # flag support
    Call("3.8-flash", 7000, 500, "LOW", batch=True),  # subject fidelity
    Call("3.8-flash", 5000, 300, "LOW", batch=True),  # questioning quality
]
REPLAY_SCORING = [SCORING[1], SCORING[3]]  # replay has no live subject: flag support + questioning quality


def assistant_turns(a: str, high: bool) -> float:
    calls = ASSISTANTS[a]
    first = calls[0].cost(high) * EXCHANGES
    deep = sum(c.cost(high) for c in calls[1:]) * -(-EXCHANGES // STAGE2_EVERY)
    return first + deep


def trial_cost(a: str, s: str, high: bool, lineup: str = "full") -> float:
    subject = SUBJECT_LINEUPS[lineup][s].cost(high) * EXCHANGES
    once = FINAL_FINDING[a].cost(high) + sum(c.cost(high) for c in SCORING)
    return subject + assistant_turns(a, high) + once


def interactive(cases: int, repeats: int, high: bool, lineup: str = "full") -> float:
    return sum(trial_cost(a, s, high, lineup) for a in ASSISTANTS for s in SUBJECT_LINEUPS[lineup]) * cases * repeats


def replay(transcripts: int, high: bool) -> float:
    """Every assistant scores the same frozen transcripts (BKO-6); not latency-bound, so batch."""
    total = 0.0
    for a, calls in ASSISTANTS.items():
        per_turn = sum(Call(c.model, c.tokens_in, c.tokens_out, c.think, batch=True).cost(high) for c in calls)
        fin = FINAL_FINDING[a]
        once = Call(fin.model, fin.tokens_in, fin.tokens_out, fin.think, batch=True).cost(high)
        once += sum(c.cost(high) for c in REPLAY_SCORING)  # flag support + questioning quality
        total += transcripts * (EXCHANGES * per_turn + once)
    return total


def generation(dev_families: int, hidden_families: int, high: bool) -> float:
    """Hidden families on Pro (HIGH thinking); dev families on 3.8-flash; three Flash validation passes each."""
    validate = 3 * Call("3.8-flash", 16000, 1200, "LOW").cost(high)
    hidden = Call("3.1-pro-preview", 8000, 14000, "HIGH").cost(high) + validate
    dev = Call("3.8-flash", 8000, 14000, "LOW").cost(high) + validate
    return hidden_families * hidden + dev_families * dev


def plan(sealed_cases: int, sealed_repeats: int, dev_cases: int, high: bool, lineup: str) -> dict[str, float]:
    """Preparation (generation + dev pilot) and bake-off proper (sealed + replay), each with a 15% reserve."""
    prep = generation(dev_cases // 2, sealed_cases // 2, high) + interactive(dev_cases, 1, high, lineup)
    bake = interactive(sealed_cases, sealed_repeats, high, lineup) + replay(sealed_cases, high)
    return {"preparation": prep * 1.15, "bake-off": bake * 1.15, "total": (prep + bake) * 1.15}


def power_first(sealed_cases: int, dev_cases: int, high: bool) -> dict[str, float]:
    """All Flash-Lite tiers; hidden families still generated on Pro; lean subject lineup."""
    global ASSISTANTS, SCORING, REPLAY_SCORING
    saved = (ASSISTANTS, SCORING, REPLAY_SCORING)
    ASSISTANTS, SCORING, REPLAY_SCORING = POWER_FIRST_ASSISTANTS, POWER_FIRST_SCORING, [POWER_FIRST_SCORING[1]]
    try:
        return plan(sealed_cases, 1, dev_cases, high, "lean")
    finally:
        ASSISTANTS, SCORING, REPLAY_SCORING = saved


if __name__ == "__main__":
    for lineup in ("full", "lean"):
        print(f"\nPer-trial cost, lineup={lineup} (12 exchanges incl. offline scoring), expected / high:")
        for a in ASSISTANTS:
            row = "  ".join(f"{s}: ${trial_cost(a, s, False, lineup):.4f} / ${trial_cost(a, s, True, lineup):.4f}"
                            for s in SUBJECT_LINEUPS[lineup])
            print(f"  {a}: {row}")
    print("\nPlans (dollars, each part includes a 15% retry reserve); expected | high")
    print(f"  {'plan':<34}{'lineup':<7}{'prep':>16}{'bake-off':>18}{'total':>18}")
    for sealed, reps, dev in ((120, 1, 40), (120, 2, 40), (80, 1, 40), (60, 1, 20), (60, 2, 20), (40, 1, 20)):
        for lineup in ("full", "lean"):
            e = plan(sealed, reps, dev, False, lineup)
            h = plan(sealed, reps, dev, True, lineup)
            name = f"sealed 3x3x{sealed}x{reps}, dev {dev}"
            print(f"  {name:<34}{lineup:<7}"
                  f"{e['preparation']:>7.1f} | {h['preparation']:<6.1f}"
                  f"{e['bake-off']:>9.1f} | {h['bake-off']:<6.1f}"
                  f"{e['total']:>9.1f} | {h['total']:<6.1f}")
    for sealed, dev in ((120, 20), (120, 40)):
        e, h = power_first(sealed, dev, False), power_first(sealed, dev, True)
        name = f"POWER-FIRST 3x3x{sealed}x1, dev {dev}"
        print(f"  {name:<34}{'lean':<7}"
              f"{e['preparation']:>7.1f} | {h['preparation']:<6.1f}"
              f"{e['bake-off']:>9.1f} | {h['bake-off']:<6.1f}"
              f"{e['total']:>9.1f} | {h['total']:<6.1f}")
