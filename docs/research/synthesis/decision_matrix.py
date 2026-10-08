"""Weighted decision matrices for docs/research/synthesis/02-direction.md section 5.

Run: python3 docs/research/synthesis/decision_matrix.py
Scores are 1-5 against the anchors in section 5; a (low, high) pair marks an unmeasured
quantity. Options that fail the constraint gate are listed in the document, not scored here.
Sensitivity: every pair of criteria trades 10 weight points; the script reports whether the
top option (judged on the midpoint of each range) ever changes.
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
        "A in-process, official only": [4, 5, 2, 5, 5],
        "B A + A2A exhibition track": [4, 4, 4, 5, 3],
        "C every candidate an A2A service": [4, 2, 4, (2, 4), 3],
    },
    "DM-3 Coaching latency design": {
        "A one call, Flash-Lite MINIMAL": [4, 5, 3, (2, 4), 4],
        "B two stages in one request": [5, 4, 4, (2, 4), 4],
        "C B + Priority tier": [5, 3, 4, (3, 5), 4],
        "D one Pro call": [5, 4, 3, 1, 4],
    },
    "DM-4 Voice engine (gate-passing)": {
        "A Vertex gemini-3.8-live": [3, 4, 5, (3, 5), 3],
        "B Vertex gemini-live-2.5-flash-native-audio": [3, 4, 4, (3, 5), 3],
        "C A + prebuilt Live Avatar": [3, 2, 5, (2, 4), 3],
    },
    "DM-5 Phoenix hosting (gate-passing)": {
        "A self-hosted on Cloud Run + read-back": [4, 3, 5, 5, 4],
        "B local only": [4, 5, 2, 5, 5],
    },
    "DM-6 Frontend hosting": {
        "A static build on Firebase Hosting": [4, 5, 4, 5, 4],
        "B Next.js server on Cloud Run": [4, 4, 4, 3, 4],
        "C Firebase App Hosting": [4, 3, 4, 3, 4],
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
        print(f"  winner at base weights: {base}")
        print("  flips under a 10-point shift: " + ("none" if not flips else "; ".join(flips)))
