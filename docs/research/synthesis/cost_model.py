"""Reproducible cost model for the arena bake-off (research artifact, not product code).

Every dollar figure in docs/research/synthesis/02-direction.md section 8 comes from this file.
Run: python3 -I -B docs/research/synthesis/cost_model.py

Design rule (critique rounds 1-2): each lineup is DATA (subjects, assistant stage schedules,
final-finding model, referee calls) and every costing path (dev pilot, sealed interactive,
replay) reads the same data. Estimates (expected/high) are kept separate from the worst-case
RESERVATION the spend guard must hold before a block starts.

Prices: Vertex AI (Agent Platform) global list prices per 1M tokens, captured 2026-10-08
(X8; confirmed by Codex rounds 1-4 against the official pricing page). Thinking tokens bill at
the output rate. No batch pricing anywhere (critique round 4): batch has no SLA, completed batch work
stays billable after cancellation, and queued batch work holds reservations; the referee therefore runs
online as each block finishes and replay runs in bounded online chunks. No context-cache discount is
assumed (the static prefix may sit below the 4,096-6,144 token implicit-cache minimum; X3, unresolved).
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
THINK = {"MINIMAL": (80, 200), "LOW": (400, 1000), "HIGH": (6000, 12000)}  # expected, high
EXCHANGES = 12          # sponsor cap (BKO-8); costed at the cap, not an average
RELEASES = (3, 6)       # evidence-release events per trial (expected, high); each triggers a deep stage
MAX_RELEASES = 6        # hard limit the generator enforces on every sealed case (validator rejects more)
ATTEMPTS = 1 + 1 + 2    # first try + one schema repair + two transient retries, the most any call may make

# Enforceable request limits per call type (critique round 3, F01). thinking_level is qualitative, so the
# only hard bound on thinking is max_output_tokens, which caps thinking + visible output together.
# Spec v2.3 D11: the input limit bounds the UTF-8 BYTES of the largest request including the repair allowance
# (REPAIR_BYTES 5,200); tokens never exceed bytes, so a reservation on bytes is a true upper bound. The port
# refuses any request whose bytes exceed the limit and sets max_output_tokens = output_limit. Values come from
# S2 section 2's rendered-context budget at the input caps (600-character questions).
LIMITS = {  # call type: (input_limit_bytes, output_limit_including_thinking)
    "subject": (80000, 1600),
    "card": (128000, 1600),
    "deep": (128000, 3000),
    "final": (128000, 3000),
    "referee": (160000, 4000),
    "generate": (12000, 40000),
    "validate": (20000, 4000),
    # Stage 8 (owner-approved real voices): one spoken line through gemini-3.8-flash-tts. Input: a 900-character line
    # and its 120-character style at up to 12 escaped bytes a character plus the request JSON; output: 80 s of audio
    # at 25 tokens a second.
    "tts": (14000, 2000),
    # One designed voice (scripts/design_voices.py): a description of at most 400 characters at up to 12 escaped
    # bytes each plus the request JSON; output: the model's hard output-token limit (16,384), since CreateVoice takes no
    # output cap (the sample is about 1,100 tokens in Google's example).
    "voice_design": (6000, 16384),
    # UI v2 (D-035): a colleague NPC's reply on the Gemini fallback, when no free endpoint answers. Input: the
    # persona prompt plus at most 12 history lines and the message (400 characters each, up to 12 escaped bytes a
    # character) and the repair allowance; output: a short reply at MINIMAL thinking.
    "npc": (72000, 1000),
}


@dataclass(frozen=True)
class Call:
    model: str
    tokens_in: int
    tokens_out: int
    think: str
    kind: str = "card"

    def __post_init__(self) -> None:
        lim_in, lim_out = LIMITS[self.kind]
        high_in = self.tokens_in * 1.25
        high_out = self.tokens_out * 1.25 + THINK[self.think][1]
        assert high_in <= lim_in, f"{self.kind}: modeled input {high_in:.0f} exceeds limit {lim_in}"
        assert high_out <= lim_out, f"{self.kind}: modeled output+thinking {high_out:.0f} exceeds limit {lim_out}"

    def cost(self, high: bool) -> float:
        p_in, p_out = PRICES[self.model]
        scale = 1.25 if high else 1.0
        think = THINK[self.think][1 if high else 0]
        return (self.tokens_in * scale * p_in + (self.tokens_out * scale + think) * p_out) / 1e6

    def reservation(self) -> float:
        """Worst case the spend guard holds: full limits, every allowed attempt, list price (batch may fall back online)."""
        p_in, p_out = PRICES[self.model]
        lim_in, lim_out = LIMITS[self.kind]
        return ATTEMPTS * (lim_in * p_in + lim_out * p_out) / 1e6




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
    referee: list[Call]              # per-trial online calls after the trial: independent labels, fidelity, flag support, questioning
    replay_referee: list[Call]       # replay has no live subject: flag support + questioning quality
    gen_hidden: Call = Call("3.1-pro-preview", 8000, 14000, "HIGH", kind="generate")
    gen_dev: Call = Call("3.8-flash", 8000, 14000, "LOW", kind="generate")
    gen_validate: list[Call] = field(
        default_factory=lambda: [Call("3.8-flash", 16000, 1200, "LOW", kind="validate")] * 3)


CARD_FLASH_LITE_35 = Call("3.5-flash-lite", 3000, 260, "MINIMAL", kind="card")
CARD_SINGLE_35 = Call("3.5-flash-lite", 3200, 340, "MINIMAL", kind="card")
CARD_SINGLE_31 = Call("3.1-flash-lite", 3200, 340, "MINIMAL", kind="card")

REFEREE_38 = [  # different checkpoint from every power-first subject (F16)
    Call("3.8-flash", 8000, 1000, "LOW", kind="referee"),  # independent labels + fidelity, every subject turn
    Call("3.8-flash", 7000, 700, "LOW", kind="referee"),   # flag support + questioning quality
]

LINEUPS = {
    "full": Lineup(
        name="full",
        subjects={"S1": Call("3.1-flash-lite", 3500, 200, "MINIMAL", kind="subject"),
                  "S2": Call("3.5-flash-lite", 3500, 200, "MINIMAL", kind="subject"),
                  "S3": Call("3.8-flash", 3500, 200, "LOW", kind="subject")},
        assistants={"A1": Assistant(CARD_FLASH_LITE_35, Call("3.8-flash", 3500, 250, "LOW", kind="deep"), 3,
                                    Call("3.8-flash", 4000, 250, "LOW", kind="final")),
                    "A2": Assistant(CARD_SINGLE_35, final=Call("3.5-flash-lite", 4000, 250, "MINIMAL", kind="final")),
                    "A3": Assistant(CARD_SINGLE_31, final=Call("3.1-flash-lite", 4000, 250, "MINIMAL", kind="final"))},
        referee=REFEREE_38,
        replay_referee=[REFEREE_38[1]],
    ),
    "power-first": Lineup(
        name="power-first",
        subjects={"S1": Call("3.1-flash-lite", 3500, 200, "MINIMAL", kind="subject"),
                  "S2": Call("3.5-flash-lite", 3500, 200, "MINIMAL", kind="subject"),
                  "S3": Call("3.5-flash-lite", 3800, 200, "MINIMAL", kind="subject")},  # skilled-deceiver policy
        assistants={"A1": Assistant(CARD_FLASH_LITE_35, Call("3.5-flash-lite", 3500, 250, "MINIMAL", kind="deep"), 3,
                                    Call("3.5-flash-lite", 4000, 250, "MINIMAL", kind="final")),
                    "A2": Assistant(CARD_SINGLE_35, final=Call("3.5-flash-lite", 4000, 250, "MINIMAL", kind="final")),
                    "A3": Assistant(CARD_SINGLE_31, final=Call("3.1-flash-lite", 4000, 250, "MINIMAL", kind="final"))},
        referee=REFEREE_38,
        replay_referee=[REFEREE_38[1]],
    ),
}

# Preparation experiments (section 13.1), costed explicitly (expected, high).
EXPERIMENTS = {
    "latency benchmark (complete card; 3 models x 2 context lengths x 200 calls)": (
        lambda high: 1200 * (CARD_SINGLE_35.cost(high) + CARD_SINGLE_31.cost(high)
                             + Call("3.8-flash", 3200, 340, "LOW", kind="card").cost(high)) / 3),
    "Live probe matrix (~30 short sessions, assumed $0.05 each)": (lambda high: 30 * (0.05 if not high else 0.10)),
    "case-generation pilot (3 families)": (
        lambda high: 3 * (Call("3.1-pro-preview", 8000, 14000, "HIGH", kind="generate").cost(high)
                          + 3 * Call("3.8-flash", 16000, 1200, "LOW", kind="validate").cost(high))),
    "fidelity pilot (3 subjects x 2 roles x 3 cases x 12 turns)": (
        lambda high: 18 * EXCHANGES * Call("3.8-flash", 3500, 200, "LOW", kind="subject").cost(high)),
}


EXPERIMENTS_LEAN = {
    "latency benchmark (complete card; 3 models x 2 context lengths x 100 calls)": (
        lambda high: EXPERIMENTS["latency benchmark (complete card; 3 models x 2 context lengths x 200 calls)"](high) / 2),
    "Live probe matrix (~30 short sessions)": EXPERIMENTS["Live probe matrix (~30 short sessions, assumed $0.05 each)"],
    "case-generation pilot (2 families)": (
        lambda high: EXPERIMENTS["case-generation pilot (3 families)"](high) * 2 / 3),
    "fidelity pilot (3 subjects x 2 roles x 2 cases x 12 turns)": (
        lambda high: EXPERIMENTS["fidelity pilot (3 subjects x 2 roles x 3 cases x 12 turns)"](high) * 2 / 3),
}


def deep_calls_per_trial(a: Assistant, high: bool) -> int:
    if a.deep is None:
        return 0
    return -(-EXCHANGES // a.deep_every) + RELEASES[1 if high else 0]


def assistant_trial(a: Assistant, high: bool) -> float:
    total = EXCHANGES * a.every_turn.cost(high)
    if a.deep is not None:
        total += deep_calls_per_trial(a, high) * a.deep.cost(high)
    if a.final is not None:
        total += a.final.cost(high)
    return total


def assistant_reservation(a: Assistant) -> float:
    deep = (-(-EXCHANGES // a.deep_every) + MAX_RELEASES) if a.deep else 0
    return (EXCHANGES * a.every_turn.reservation() + (deep * a.deep.reservation() if a.deep else 0.0)
            + (a.final.reservation() if a.final else 0.0))


def trial_cost(lu: Lineup, a: str, s: str, high: bool) -> float:
    return (EXCHANGES * lu.subjects[s].cost(high) + assistant_trial(lu.assistants[a], high)
            + sum(r.cost(high) for r in lu.referee))


def trial_reservation(lu: Lineup, a: str, s: str) -> float:
    return (EXCHANGES * lu.subjects[s].reservation() + assistant_reservation(lu.assistants[a])
            + sum(r.reservation() for r in lu.referee))


def interactive(lu: Lineup, cases: int, repeats: int, high: bool) -> float:
    return sum(trial_cost(lu, a, s, high) for a in lu.assistants for s in lu.subjects) * cases * repeats


def replay_per_transcript(lu: Lineup, high: bool) -> float:
    """All assistants re-score one frozen transcript (BKO-6) with the same stage schedule, online."""
    return sum(assistant_trial(a, high) + sum(r.cost(high) for r in lu.replay_referee) for a in lu.assistants.values())


def replay_reservation_per_transcript(lu: Lineup) -> float:
    return sum(assistant_reservation(a) + sum(r.reservation() for r in lu.replay_referee) for a in lu.assistants.values())


def corpus_per_transcript(lu: Lineup, high: bool) -> float:
    """Replay corpus production: the fixed harness asks a predeclared neutral question script (no assistant
    input) to one subject per hidden case (subjects rotate by case); the referee labels its turns."""
    avg_subject = sum(c.cost(high) for c in lu.subjects.values()) / len(lu.subjects)
    return EXCHANGES * avg_subject + lu.referee[0].cost(high)


def corpus_reservation_per_transcript(lu: Lineup) -> float:
    worst_subject = max(c.reservation() for c in lu.subjects.values())
    return EXCHANGES * worst_subject + lu.referee[0].reservation()


def replay(lu: Lineup, transcripts: int, high: bool) -> float:
    return (replay_per_transcript(lu, high) + corpus_per_transcript(lu, high)) * transcripts


def generation(lu: Lineup, dev_families: int, hidden_families: int, high: bool) -> float:
    validate = sum(v.cost(high) for v in lu.gen_validate)
    return hidden_families * (lu.gen_hidden.cost(high) + validate) + dev_families * (lu.gen_dev.cost(high) + validate)


def experiments(high: bool) -> float:
    return sum(f(high) for f in EXPERIMENTS.values())


def plan(lu: Lineup, sealed_cases: int, repeats: int, dev_cases: int, high: bool) -> dict[str, float]:
    """Preparation = experiments + generation + dev pilot; bake-off = sealed interactive + online referee + replay.

    Each part carries a 15% retry reserve.
    """
    prep = experiments(high) + generation(lu, dev_cases // 2, sealed_cases // 2, high) + interactive(lu, dev_cases, 1, high)
    bake = interactive(lu, sealed_cases, repeats, high) + replay(lu, sealed_cases, high)
    return {"prep": prep * 1.15, "bake": bake * 1.15, "total": (prep + bake) * 1.15}


def simulate_admission(lu: Lineup, sealed_cases: int, cap: float, high: bool, chunk: int = 5) -> dict:
    """Sponsor order (BKO-2): replay track first, then interactive blocks.

    Replay: produce and seal the corpus, then all assistants score it in chunks of `chunk` transcripts.
    Interactive: sequential blocks, referee online at the end of each block. Before every unit the guard
    requires cap - settled_spend >= the unit's worst-case reservation; units settle at modeled cost x 1.15.
    Nothing is queued, so no reservation is outstanding when the next unit is admitted.
    """
    spent = 0.0
    transcripts = sealed_cases
    chunk_cost = chunk * (replay_per_transcript(lu, high) + corpus_per_transcript(lu, high)) * 1.15
    chunk_res = chunk * (replay_reservation_per_transcript(lu) + corpus_reservation_per_transcript(lu))
    chunks_needed, chunks = -(-transcripts // chunk), 0
    for _ in range(chunks_needed):
        if cap - spent < chunk_res:
            break
        spent += chunk_cost
        chunks += 1
    block_cost = 2 * sum(trial_cost(lu, a, s, high) for a in lu.assistants for s in lu.subjects) * 1.15
    block_res = block_reservation(lu)
    blocks = 0
    for _ in range(sealed_cases // 2):
        if cap - spent < block_res:
            break
        spent += block_cost
        blocks += 1
    return {"blocks": blocks, "blocks_needed": sealed_cases // 2, "replay_chunks": chunks,
            "replay_chunks_needed": chunks_needed, "spent": spent, "block_reservation": block_res,
            "chunk_reservation": chunk_res}


def block_reservation(lu: Lineup) -> float:
    """Worst-case cost of one block (one family, both variants, all nine pairings, one repeat)."""
    return 2 * sum(trial_reservation(lu, a, s) for a in lu.assistants for s in lu.subjects)


if __name__ == "__main__" and "--plan-json" not in __import__("sys").argv:
    for lu in LINEUPS.values():
        print(f"\nLineup {lu.name}: per-trial expected / high (12 exchanges incl. referee)")
        for a in lu.assistants:
            print("  " + a + ": " + "  ".join(
                f"{s} ${trial_cost(lu, a, s, False):.4f}/${trial_cost(lu, a, s, True):.4f}" for s in lu.subjects))
        print(f"  worst-case reservation per block (18 trials): ${block_reservation(lu):.2f}")
    print("\nPreparation experiments (expected / high):")
    for k, f in EXPERIMENTS.items():
        print(f"  {k:<70} ${f(False):6.2f} / ${f(True):6.2f}")
    print(f"\nReservation basis: {ATTEMPTS} attempts per call, MAX_RELEASES={MAX_RELEASES}, limits {LIMITS}")
    print("\nGrid, all online (each part includes a 15% reserve). Columns as expected | high")
    for lu in LINEUPS.values():
        for sealed, reps, dev in ((40, 1, 20), (60, 1, 20), (80, 1, 20), (120, 1, 20), (120, 1, 40), (120, 2, 40)):
            e, h = plan(lu, sealed, reps, dev, False), plan(lu, sealed, reps, dev, True)
            label = f"{lu.name:<12} 3x3x{sealed}x{reps}, dev {dev}"
            print(f"  {label:<33} prep {e['prep']:6.1f}|{h['prep']:6.1f}  bake {e['bake']:6.1f}|{h['bake']:6.1f}"
                  f"  total {e['total']:6.1f}|{h['total']:6.1f}")
    print("\nAdmission simulation (replay first per BKO-2, then sequential blocks; online referee; chunks of 5):")
    for lu_name, cases, cap in (("power-first", 80, 100.0), ("power-first", 120, 100.0), ("power-first", 120, 145.0),
                                ("full", 80, 100.0)):
        for high in (False, True):
            r = simulate_admission(LINEUPS[lu_name], cases, cap, high)
            tag = "high" if high else "expected"
            print(f"  {lu_name:<12} {cases} cases, cap ${cap:.0f}, {tag:<8}: blocks {r['blocks']}/{r['blocks_needed']}, "
                  f"replay chunks {r['replay_chunks']}/{r['replay_chunks_needed']}, settled ${r['spent']:.2f} "
                  f"(block reservation ${r['block_reservation']:.2f}, chunk reservation ${r['chunk_reservation']:.2f})")


# ---------------------------------------------------------------------------------------------------
# D-009: total GCP spend hard cap $75, target $50 (critique round 5 rebuilt this section).
# ---------------------------------------------------------------------------------------------------
# Liability rates: Google describes the 3.8 Flash promotion as credits back on net spend, so the hard
# envelope uses the undiscounted list rate until the project's credit treatment is verified; promotional
# savings are upside only (R5-02).
LIABILITY_PRICES = dict(PRICES, **{"3.8-flash": (1.50, 7.50)})
# gemini-3.8-flash-tts (global): $0.50 per 1M text tokens in and $9.00 per 1M audio tokens out through 2026-12-31,
# doubling to $1.00 and $18.00 on 2027-01-01 (Gemini pricing page, checked 2026-10-12). The envelope uses the higher
# 2027 list rate from today, so no reservation falls short when the price rises. Designing a voice bills at the same
# rates (text in for the description, audio out for the sample the Voices API returns). Not in PRICES: no
# research-time unit (block, replay, corpus) makes a speech call.
LIABILITY_PRICES["3.8-flash-tts"] = (1.00, 18.00)
RETRY_FACTOR = 1.15        # average extra spend from repairs and transient retries
ADMIT_FACTOR = 1.5         # soft completeness rule: start a unit only if 1.5 x its high cost remains


def liab_cost(c: Call, high: bool) -> float:
    p_in, p_out = LIABILITY_PRICES[c.model]
    scale = 1.25 if high else 1.0
    return (c.tokens_in * scale * p_in + (c.tokens_out * scale + THINK[c.think][1 if high else 0]) * p_out) / 1e6


def liab_reservation(c: Call) -> float:
    p_in, p_out = LIABILITY_PRICES[c.model]
    lim_in, lim_out = LIMITS[c.kind]
    return ATTEMPTS * (lim_in * p_in + lim_out * p_out) / 1e6


# D-009 lineup: no promotional model on the bake-off path. Subjects keep two tiers; the referee's
# subject-facing call runs on 3.1-flash-lite at LOW thinking (shares a checkpoint with S1 only, disclosed);
# all families are generated on Pro and validated on 3.5-flash-lite.
REFEREE_D009 = [Call("3.1-flash-lite", 8000, 1000, "LOW", kind="referee"),
                Call("3.5-flash-lite", 7000, 700, "MINIMAL", kind="referee")]
LINEUPS["d009"] = Lineup(
    name="d009",
    subjects=LINEUPS["power-first"].subjects,
    assistants=LINEUPS["power-first"].assistants,
    referee=REFEREE_D009,
    replay_referee=[REFEREE_D009[1]],
    gen_hidden=Call("3.1-pro-preview", 8000, 14000, "HIGH", kind="generate"),
    gen_dev=Call("3.1-pro-preview", 8000, 14000, "HIGH", kind="generate"),
    gen_validate=[Call("3.5-flash-lite", 16000, 1200, "LOW", kind="validate")] * 3,
)


def unit_trial_calls(lu: Lineup, a: str, s: str, high: bool) -> list[Call]:
    """Ordered calls of one interactive trial (deep stages counted at the high or expected release count)."""
    asst = lu.assistants[a]
    calls: list[Call] = []
    deep_total = deep_calls_per_trial(asst, high)
    deep_done = 0
    for t in range(EXCHANGES):
        calls.append(lu.subjects[s])
        calls.append(asst.every_turn)
        if asst.deep is not None and deep_done < deep_total and (t % asst.deep_every == asst.deep_every - 1
                                                                  or deep_total - deep_done >= EXCHANGES - t):
            calls.append(asst.deep)
            deep_done += 1
    if asst.final is not None:
        calls.append(asst.final)
    calls.extend(lu.referee)
    return calls


def block_calls(lu: Lineup, high: bool) -> list[Call]:
    return [c for _ in range(2) for a in lu.assistants for s in lu.subjects for c in unit_trial_calls(lu, a, s, high)]


def corpus_calls(lu: Lineup, case_index: int) -> list[Call]:
    """One frozen transcript: the harness's neutral script against one subject (rotating by case) + labels."""
    subj = list(lu.subjects.values())[case_index % len(lu.subjects)]
    return [subj] * EXCHANGES + [lu.referee[0]]


def replay_scoring_calls(lu: Lineup, high: bool) -> list[Call]:
    calls: list[Call] = []
    for asst in lu.assistants.values():
        calls += [asst.every_turn] * EXCHANGES
        if asst.deep is not None:
            calls += [asst.deep] * deep_calls_per_trial(asst, high)
        if asst.final is not None:
            calls.append(asst.final)
        calls += lu.replay_referee
    return calls


# D-014 (owner, 2026-10-08): case families are authored once, offline, by Claude agents with Codex review;
# no Vertex generation or validation calls, and gemini-3.1-pro-preview is not used. The generation calls
# below remain only for the older lineups and the research history.
CASE_AUTHORING = "offline"


def family_generation_calls(lu: Lineup, hidden: bool) -> list[Call]:
    if CASE_AUTHORING == "offline" and lu.name == "d009":
        return []
    return [lu.gen_hidden if hidden else lu.gen_dev] + list(lu.gen_validate)


def experiment_calls(high: bool) -> list[Call]:
    calls = [CARD_SINGLE_35, CARD_SINGLE_31, CARD_FLASH_LITE_35] * 200            # lineup models x 2 contexts x 100
    for _ in range(2):                                                          # case-generation pilot (none, D-014)
        calls += family_generation_calls(LINEUPS["d009"], hidden=True)
    calls += [Call("3.5-flash-lite", 3500, 200, "MINIMAL", kind="subject")] * (2 * 3 * 2 * EXCHANGES)  # fidelity pilot
    return calls


# Live voice reference session (F25). Rates are the gokbase rate card for the Live model family
# (audio $3/$12, text $0.75/$4.50 per 1M) because no Vertex 3.8 Live table was retrieved; the high case
# multiplies durations and rates by 1.5. Accumulated context is rebilled every turn.
VOICE = {"exchanges": 12, "in_s": 12, "out_s": 14, "tok_per_s": 32, "system_tokens": 2000,
         "transcript_tokens_per_turn": 200, "audio_in": 3.0, "audio_out": 12.0, "text_in": 0.75, "text_out": 4.50,
         "retranscribe_per_min": 0.016}


def voice_session_cost(high: bool) -> float:
    v, k = VOICE, (1.5 if high else 1.0)
    turn_in, turn_out = v["in_s"] * k * v["tok_per_s"], v["out_s"] * k * v["tok_per_s"]
    audio_ctx = sum((t * (turn_in + turn_out) + turn_in) for t in range(v["exchanges"]))
    live = (audio_ctx * v["audio_in"] * k + v["exchanges"] * v["system_tokens"] * v["text_in"] * k
            + v["exchanges"] * turn_out * v["audio_out"] * k
            + v["exchanges"] * v["transcript_tokens_per_turn"] * v["text_out"] * k) / 1e6
    coaching = v["exchanges"] * liab_cost(CARD_SINGLE_35, high)
    retranscribe = (v["exchanges"] * v["out_s"] * k / 60) * v["retranscribe_per_min"]
    return live + coaching + retranscribe


# Enforced per-session limits (the gokbase safety loop closes the socket at any of them): 12 exchanges, 480 s
# of audio in total, no context compression. The whole-session liability below is computed from those
# limits (every turn rebills the maximum possible accumulated context; rates x1.5 for the unconfirmed Vertex
# price), reserved BEFORE the Live session opens, and released after settlement. The meter shuts the session
# at two thirds of the reservation, so in-flight usage between 2-second checks stays inside it (R6-01).
VOICE_LIMITS = {"exchanges": 12, "audio_seconds": 480}


def voice_session_reservation(exchanges: int = VOICE_LIMITS["exchanges"],
                              audio_seconds: int = VOICE_LIMITS["audio_seconds"]) -> float:
    v, k = VOICE, 1.5
    max_ctx = audio_seconds * v["tok_per_s"]                       # all audio ever spoken fits the session limit
    live = (exchanges * (max_ctx * v["audio_in"] * k + v["system_tokens"] * v["text_in"] * k)
            + max_ctx * v["audio_out"] * k + exchanges * 2 * v["transcript_tokens_per_turn"] * v["text_out"] * k) / 1e6
    coaching = exchanges * CARD_SINGLE_35.reservation()
    retranscribe = (audio_seconds / 60) * v["retranscribe_per_min"] * k
    return live + coaching + retranscribe


VOICE_RESERVATION = voice_session_reservation()
VOICE_SHUTOFF = VOICE_RESERVATION * 2 / 3
LIVE_PROBE = (30, 0.05)                                            # day-1 probe sessions, expected $ each
PROBE_RESERVATION = voice_session_reservation(exchanges=2, audio_seconds=60)
VOICE_SESSIONS = 8                                                 # 4 for development testing, 4 for judges and the demo
TEXT_SESSIONS = 40
# Training and KPI-1 (spec S3 6.1 and OQ-1, S8 C-15 and C-43): every scored training session gets R3, which is
# the two referee calls (REFEREE_D009) run in investigator mode. KPI-1: up to 10 volunteers x (4 assessment-mode
# test sessions + 3 practice sessions), each a full 12-exchange session (subject + card calls; cards are still
# produced in assessment mode for the debrief), plus R3 on each; calibration scores 20 transcripts with R3.
# KPI-1 needs 4 more development families than the dev pilot (S1 OQ-9): generated, never run as dev blocks.
TRAINING = {"volunteers": 10, "sessions_each": 7, "calibration_transcripts": 20}
KPI1_EXTRA_DEV_FAMILIES = 4
# Character art (UI direction 03, UI-06): capped at 62 images = 12 characters x (1 sheet + 3 variants) + 30%
# retries; drafts on Nano Banana 2.1 ($0.0336 per 1K image), finals on Gemini 3 Pro Image ($0.134 per 1K-2K
# image, C2PA supported). Expected average ~$0.07; high assumes finals and retries at the Pro price, $0.10.
PORTRAITS = (62, 0.07, 0.10)   # count, expected $/image, high $/image; every generation passes the guard

# Non-model GCP costs from the first probe (2026-10-09) to teardown (2026-11-09), at gross rates.
# Critique rounds 5-8 showed these cannot be hard-capped: GCP has no project-wide cap, usage metrics lag, and
# Cloud Run can briefly exceed max-instances. So they are NOT claimed as a guaranteed bound. They are
# minimized by design (min-instances 0, low max-instances, Identity-Aware Proxy in front of the only public
# service, which also serves the static web same-origin; every other service IAM-private; size caps; log
# exclusions; teardown on 2026-11-09), estimated below, and given an ALLOWANCE with margin that is set aside
# before model work. Backstop: budget notifications at $25/$50/$65 and an automated billing-disable at $70
# (notifications lag by hours, which is what the margin is for).
NON_MODEL_CAPS = {   # name: (quantity, unit, gross $ per unit, expected fraction actually used)
    "Cloud Run services vCPU-seconds": (150_000, "vCPU-s", 0.000024, 0.15),
    "Cloud Run services GiB-seconds": (300_000, "GiB-s", 0.0000025, 0.15),
    "Cloud Run job vCPU-seconds (tournament, 6 h x 2 vCPU)": (43_200, "vCPU-s", 0.000024, 0.5),
    "Cloud Run job GiB-seconds (6 h x 4 GiB)": (86_400, "GiB-s", 0.0000025, 0.5),
    "Cloud Run requests": (2_000_000, "requests", 0.0000004, 0.05),
    "Artifact Registry storage (cleanup keeps <= 3 GB)": (3, "GB-month", 0.10, 0.5),
    "Cloud Storage (<= 2 GB)": (2, "GB-month", 0.026, 0.5),
    "Secret Manager active versions (<= 12)": (12, "version-month", 0.06, 1.0),
    "Cloud Logging ingestion (exclusions + sampling, <= 3 GiB)": (3, "GiB", 0.50, 0.3),
    "Internet egress from Cloud Run (<= 5 GB)": (5, "GB", 0.12, 0.2),
    "Billing-disable backstop (event-driven function, invoked only by budget notifications)": (1, "month", 0.10, 1.0),
}
NON_MODEL_ALLOWANCE = 15.0   # hosted mode: about 1.6x the itemized high estimate, to absorb lag and burst
# D-011 (owner, 2026-10-08): build and run locally first; GCP hosting only if time permits. In local mode the
# only GCP charges are Vertex model calls (all reserved by the guard); Cloud Run, IAP, storage, logging and
# egress are not used, so the non-model allowance drops to a $1 margin for stray console usage.
HOSTING = "local"
NON_MODEL_ALLOWANCE_LOCAL = 1.0
NON_MODEL = {k: (q * r * f, q * r) for k, (q, _, r, f) in NON_MODEL_CAPS.items()}   # (expected, enforced bound)


def r3(high: bool) -> float:
    return sum(liab_cost(c, high) for c in REFEREE_D009)


def session_text(high: bool) -> float:
    return EXCHANGES * (liab_cost(CARD_SINGLE_35, high) + liab_cost(LINEUPS["d009"].subjects["S2"], high)) + r3(high)


def training_bucket(high: bool) -> float:
    sessions = TRAINING["volunteers"] * TRAINING["sessions_each"]
    return (sessions * session_text(high) + TRAINING["calibration_transcripts"] * r3(high)) * RETRY_FACTOR


def demo_bucket(high: bool) -> dict[str, float]:
    text = TEXT_SESSIONS * session_text(high)
    voice = VOICE_SESSIONS * voice_session_cost(high)
    portraits = PORTRAITS[0] * (PORTRAITS[2] if high else PORTRAITS[1])
    return {"text": text * RETRY_FACTOR, "voice": voice, "portraits": portraits}


def demo_ceiling() -> float:
    """Demo bucket allocation, set aside first and treated as an aggregate (not simulated call by call).

    It equals the bucket's conservative usage plus one in-flight voice reservation. Inside the bucket every
    call still reserves its own worst case at call time and each voice session reserves its whole-session
    liability before opening, so when the allocation runs out new demo work is refused; the bucket cannot
    overshoot. Reservations cover only work in flight, never all future calls at once.
    """
    return sum(demo_bucket(True).values()) + VOICE_RESERVATION


def simulate_d009(sealed_cases: int, dev_cases: int, high: bool, cap: float = 75.0) -> dict:
    """Call-level simulation of the spend guard (F01).

    The non-model envelope (high) and the demo ceiling are set aside. Model work then runs in order:
    experiments, family generation, dev blocks, replay transcripts, interactive blocks. Each unit is
    admitted only if ADMIT_FACTOR x its high cost remains (soft); each call is admitted only if its full
    worst-case reservation at liability rates remains (hard), else the unit is truncated and work stops.
    Each admitted call settles at its modeled cost x RETRY_FACTOR.
    """
    lu = LINEUPS["d009"]
    allowance = NON_MODEL_ALLOWANCE_LOCAL if HOSTING == "local" else NON_MODEL_ALLOWANCE
    avail = cap - allowance - demo_ceiling() - training_bucket(True)
    spent = 0.0
    report = {"truncated": None}
    phase_spend: dict[str, float] = {}

    def run(name: str, calls: list[Call], high_calls: list[Call]) -> bool:
        nonlocal spent
        if avail - spent < ADMIT_FACTOR * sum(liab_cost(c, True) for c in high_calls) * RETRY_FACTOR:
            return False
        for c in calls:
            if avail - spent < liab_reservation(c):
                report["truncated"] = name
                return False
            spent += liab_cost(c, high) * RETRY_FACTOR
            phase_spend[name] = phase_spend.get(name, 0.0) + liab_cost(c, high) * RETRY_FACTOR
        return True

    counts = {}
    ok = run("experiments", experiment_calls(high), experiment_calls(True))
    for _ in range(LIVE_PROBE[0]):             # each probe reserves its whole-session liability before opening
        if not ok or avail - spent < PROBE_RESERVATION:
            ok = False
            break
        spent += LIVE_PROBE[1] if not high else PROBE_RESERVATION
        phase_spend["experiments"] = phase_spend.get("experiments", 0.0) + (LIVE_PROBE[1] if not high else PROBE_RESERVATION)
    counts["experiments"] = int(ok)
    gens = 0
    dev_families = dev_cases // 2 + KPI1_EXTRA_DEV_FAMILIES
    for i in range(dev_families + sealed_cases // 2):
        fam = family_generation_calls(lu, hidden=i >= dev_families)
        if not (ok and run("generation", fam, fam)):
            ok = False
            break
        gens += 1
    counts["families_generated"] = gens
    dev_done = 0
    for _ in range(dev_cases // 2):                                     # dev pilot first (section 3.2)
        if not (ok and run("dev_blocks", block_calls(lu, high), block_calls(lu, True))):
            ok = False if report["truncated"] else ok
            break
        dev_done += 1
    counts["dev_blocks"] = (dev_done, dev_cases // 2)
    corpus_all = [c for i in range(sealed_cases) for c in corpus_calls(lu, i)]
    corpus_ok = ok and run("replay_corpus", corpus_all, corpus_all)     # whole corpus produced and sealed before scoring
    counts["replay_corpus"] = int(corpus_ok)
    ok = ok and corpus_ok
    for key, n, maker, maker_high in (
            ("replay_transcripts", sealed_cases, lambda: replay_scoring_calls(lu, high),
             lambda: replay_scoring_calls(lu, True)),
            ("interactive_blocks", sealed_cases // 2, lambda: block_calls(lu, high), lambda: block_calls(lu, True))):
        done = 0
        for _ in range(n):
            if not (ok and run(key, maker(), maker_high())):
                ok = False if report["truncated"] else ok
                break
            done += 1
        counts[key] = (done, n)
    demo = sum(demo_bucket(high).values()) + training_bucket(high)
    non_model = (0.0 if not high else NON_MODEL_ALLOWANCE_LOCAL) if HOSTING == "local" else \
        sum((h if high else e) for e, h in NON_MODEL.values())
    return {**counts, "model_spend": spent, "demo": demo, "non_model": non_model,
            "total": spent + demo + non_model, "set_aside": cap - avail, "phase_spend": phase_spend, **report}


CAP = 75.0
BUILD_PHASES = ("experiments", "generation", "dev_pilot", "replay", "interactive")


PLAN = {"sealed": 30, "dev": 10}   # baseline that completes at conservative usage (D-014); 34 if the dev pilot tracks expected


def budget_plan(hosting: str = HOSTING) -> dict[str, tuple[str | None, float]]:
    """Spend-guard ceiling applied by the operator (S4 ops.set_bucket_ceiling); D-013: one global ceiling.

    The SQL migrations seed only the `global` row at $0 (fail-closed, D-012); applying this plan opens it.
    global = CAP - the non-model allowance for the hosting mode. Every model call and every voice session
    reserves its worst case against it before running, so total GCP model spend cannot exceed the cap.
    Per-phase sizing is deferred (D-013); see simulate_d009() for the reference schedule.
    """
    allowance = NON_MODEL_ALLOWANCE_LOCAL if hosting == "local" else NON_MODEL_ALLOWANCE
    return {"global": (None, CAP - allowance)}


if __name__ == "__main__" and "--plan-json" not in __import__("sys").argv:
    print(f"\nD-009 (total GCP hard cap $75, target $50), hosting={HOSTING}, lineup d009, liability rates:")
    exp_e = sum(liab_cost(c, False) for c in experiment_calls(False)) * RETRY_FACTOR + LIVE_PROBE[0] * LIVE_PROBE[1]
    exp_h = sum(liab_cost(c, True) for c in experiment_calls(True)) * RETRY_FACTOR + LIVE_PROBE[0] * PROBE_RESERVATION
    print(f"  day-1 experiments incl. Live probe: expected ${exp_e:.2f}, high ${exp_h:.2f}")
    print(f"  voice reference session: expected ${voice_session_cost(False):.2f}, high ${voice_session_cost(True):.2f}; "
          f"whole-session reservation ${VOICE_RESERVATION:.2f} (shutoff ${VOICE_SHUTOFF:.2f}) x {VOICE_SESSIONS} sessions; "
          f"probe reservation ${PROBE_RESERVATION:.2f} x {LIVE_PROBE[0]}")
    print(f"  demo ceiling set aside ${demo_ceiling():.2f}; non-model estimate expected "
          f"${sum(e for e, _ in NON_MODEL.values()):.2f}, itemized high ${sum(h for _, h in NON_MODEL.values()):.2f}, "
          f"allowance set aside ${NON_MODEL_ALLOWANCE_LOCAL if HOSTING == 'local' else NON_MODEL_ALLOWANCE:.2f} "
          f"({HOSTING}; hosted allowance ${NON_MODEL_ALLOWANCE:.2f})")
    assert voice_session_cost(True) <= VOICE_SHUTOFF, "a conservative voice session must finish before the shutoff"
    conservative_seconds = VOICE["exchanges"] * (VOICE["in_s"] + VOICE["out_s"]) * 1.5
    assert conservative_seconds <= VOICE_LIMITS["audio_seconds"], "the conservative session must fit the audio limit"
    print(f"  conservative reference session audio: {conservative_seconds:.0f} s of {VOICE_LIMITS['audio_seconds']} s allowed")
    for sealed in (20, 24, 26, 30, 34):
        for high in (False, True):
            r = simulate_d009(sealed, 10, high)
            tag = "high" if high else "expected"
            print(f"  sealed {sealed} cases, {tag:<8}: families {r['families_generated']}, dev {r['dev_blocks'][0]}/"
                  f"{r['dev_blocks'][1]}, replay {r['replay_transcripts'][0]}/{r['replay_transcripts'][1]}, interactive "
                  f"{r['interactive_blocks'][0]}/{r['interactive_blocks'][1]}; total ${r['total']:.2f} (model "
                  f"${r['model_spend']:.2f}, demo ${r['demo']:.2f}, non-model ${r['non_model']:.2f})"
                  + (f"; truncated in {r['truncated']}" if r["truncated"] else ""))
            assert r["total"] <= 75.0
    plan = budget_plan()
    assert plan["global"][1] + NON_MODEL_ALLOWANCE_LOCAL == CAP
    print(f"\n  spend guard (D-013): one global ceiling ${plan['global'][1]:.2f} ({HOSTING}); SQL seeds it at $0, the "
          f"operator applies this plan; hosted mode would be ${budget_plan('hosted')['global'][1]:.2f}")

if __name__ == "__main__" and "--plan-json" in __import__("sys").argv:
    import json
    print(json.dumps({k: {"parent": par, "ceiling_usd": v} for k, (par, v) in budget_plan().items()}))
