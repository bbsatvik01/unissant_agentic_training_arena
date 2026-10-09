"""Weighted decision matrices for docs/research/synthesis/02-direction.md section 5.

Run: python3 docs/research/synthesis/decision_matrix.py
Scores are 1-5 against the anchors in section 5; a (low, high) pair marks an unmeasured
quantity. Options that fail the constraint gate are listed in the document, not scored here.
Two sensitivity checks (critique round 2, F20):
- weight sensitivity: every pair of criteria trades 10 weight points; winner judged at range MIDPOINTS;
- score-range sensitivity: the leader is "robust" only if its lowest possible total beats every other
  option's highest possible total; otherwise the comparison depends on unmeasured scores.
Latency anchors: 5 needs a measurement; anything unmeasured is a range, and options that do not change
coaching latency get identical latency scores.
"""

from __future__ import annotations

from itertools import permutations

WEIGHTS = {"fidelity": 0.30, "delivery": 0.30, "demo": 0.15, "latency": 0.15, "security": 0.10}
ORDER = list(WEIGHTS)

R = tuple  # (low, high) range for an unmeasured score

MATRICES: dict[str, dict[str, list]] = {
    "DM-1 Agent runtime": {
        "A typed port, stateless calls": [5, 5, 3, (3, 5), 4],
        "B ADK LlmAgent per candidate": [4, 3, 3, (3, 5), 5],
        "C LangGraph spine + ADK loops": [4, 2, 3, (3, 5), 4],
        "D Pydantic AI + DBOS": [4, 2, 3, (3, 5), 4],
    },
    "DM-2 Candidate transport": {
        "A in-process, official only": [4, 5, 2, (3, 5), 5],
        "B A + A2A exhibition track": [4, 4, 4, (3, 5), 3],
        "C every candidate an A2A service": [4, 2, 4, (2, 4), 3],
    },
    "DM-3 Coaching design (both A and B emit the complete AST-3 card every turn)": {
        "A one complete call per turn, Flash-Lite MINIMAL": [5, 5, 3, (2, 4), 4],
        "B complete card + deeper update in the same request": [5, 4, 4, (2, 4), 4],
        "C B + Priority tier": [5, 3, 4, (3, 5), 4],
        "D one Pro call per turn": [5, 4, 3, 1, 4],
    },
    "DM-4 Voice engine (gate-passing)": {
        "A Vertex gemini-3.8-live": [3, 4, 5, (3, 5), 3],
        "B Vertex gemini-live-2.5-flash-native-audio": [3, 4, 4, (3, 5), 3],
        "C A + prebuilt Live Avatar": [3, 2, 5, (2, 4), 3],
    },
    "DM-5 Phoenix hosting (gate-passing; neither changes coaching latency)": {
        "A hosted Phoenix, trace mirror as store, request-based CPU": [4, 3, 5, 3, 4],
        "B local only": [4, 5, 2, 3, 5],
    },
    "DM-6 Frontend hosting": {
        "A static build served same-origin by arena-api behind IAP": [4, 5, 4, (4, 5), 4],
        "B Next.js server on Cloud Run": [4, 4, 4, (2, 4), 4],
        "C Firebase App Hosting": [4, 3, 4, (2, 4), 4],
    },
}


def bounds(scores: list, weights: dict[str, float]) -> tuple[float, float]:
    lo = hi = 0.0
    for name, s in zip(ORDER, scores):
        a, b = (s if isinstance(s, tuple) else (s, s))
        lo += weights[name] * a
        hi += weights[name] * b
    return round(lo, 2), round(hi, 2)


def midpoint_winner(options: dict[str, list], weights: dict[str, float]) -> str:
    return max(options, key=lambda k: sum(bounds(options[k], weights)) / 2)


def shifted(src: str, dst: str) -> dict[str, float] | None:
    w = dict(WEIGHTS)
    if w[src] < 0.10:
        return None
    w[src] = round(w[src] - 0.10, 2)
    w[dst] = round(w[dst] + 0.10, 2)
    return w


if __name__ == "__main__":
    for title, options in MATRICES.items():
        print(f"\n{title}")
        for name, scores in options.items():
            lo, hi = bounds(scores, WEIGHTS)
            total = f"{lo:.2f}" if lo == hi else f"{lo:.2f}-{hi:.2f}"
            print(f"  {name:<46} {total}")
        base = midpoint_winner(options, WEIGHTS)
        flips = sorted({f"{s}->{d}: {midpoint_winner(options, w)}"
                        for s, d in permutations(ORDER, 2)
                        if (w := shifted(s, d)) and midpoint_winner(options, w) != base})
        lead_lo = bounds(options[base], WEIGHTS)[0]
        overlaps = [k for k in options if k != base and bounds(options[k], WEIGHTS)[1] > lead_lo]
        print(f"  midpoint winner at base weights: {base}")
        print("  midpoint flips under a 10-point weight shift: " + ("none" if not flips else "; ".join(flips)))
        print("  score-range check: " + ("robust" if not overlaps else "depends on unmeasured scores vs " + ", ".join(overlaps)))


# UI decisions (docs/research/synthesis/03-ui-direction.md). Different criteria: the owner's UI mandate
# ("stunning, smooth, clean, pets") weighs visual impact, against delivery risk inside a 25-day build.
WEIGHTS_UI = {"impact": 0.30, "delivery": 0.30, "fit": 0.20, "performance": 0.10, "cost": 0.10}
# fit = PRB-4 and accessibility fit (demeanor independent of role, reduced motion, WCAG 2.2 AA)
UI_MATRICES: dict[str, dict[str, list]] = {
    "UI-1 Coach companion pet": {
        "A port gokbase kin FSM, new SVG art, CSS-variable rig": [4, 5, 5, 5, 5],
        "B Rive data-bound state machine": [5, 3, 4, 4, 3],
        "C dotLottie state machine": [4, 3, 4, 4, 4],
    },
    "UI-2 Subject avatar": {
        "A Gemini-generated portrait set, vectorized, amplitude-driven mouth": [4, 4, 5, 5, 5],
        "B Rive-rigged 2D": [5, 2, 4, 4, 3],
        "C three-vrm 3D + TalkingHead lip sync": [5, 2, 3, 2, 4],
    },
    "UI-3 Motion stack": {
        "A Motion for state-driven UI + GSAP for signature sequences + CSS for per-frame rigs": [5, 4, 5, 4, 5],
        "B CSS-only (TechnoMile discipline)": [3, 5, 5, 5, 5],
        "C Motion only": [4, 4, 5, 4, 5],
    },
    "UI-4 Agents-at-work view": {
        "A pipeline rail + canvas, with an office 'theater' toggle for the demo": [5, 4, 4, 4, 5],
        "B pipeline rail + canvas only": [3, 5, 5, 5, 5],
        "C isometric agent office only": [4, 3, 3, 3, 5],
    },
}


def ui_report() -> None:
    order = list(WEIGHTS_UI)
    for title, options in UI_MATRICES.items():
        print(f"\n{title}")
        totals = {name: round(sum(WEIGHTS_UI[k] * v for k, v in zip(order, scores)), 2) for name, scores in options.items()}
        for name, t in totals.items():
            print(f"  {name:<86} {t:.2f}")
        best = max(totals, key=totals.get)
        flips = set()
        for a in order:
            for b in order:
                if a == b or WEIGHTS_UI[a] < 0.10:
                    continue
                w = dict(WEIGHTS_UI); w[a] = round(w[a] - 0.10, 2); w[b] = round(w[b] + 0.10, 2)
                alt = max(options, key=lambda n: sum(w[k] * v for k, v in zip(order, options[n])))
                if alt != best:
                    flips.add(f"{a}->{b}: {alt.split(' ')[0]}")
        print(f"  winner: {best.split(' ')[0]}; flips under a 10-point shift: {'none' if not flips else '; '.join(sorted(flips))}")


if __name__ == "__main__":
    ui_report()
