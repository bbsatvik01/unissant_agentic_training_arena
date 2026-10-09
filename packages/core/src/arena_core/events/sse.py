"""SSE framing of trial deltas (S5 6.2, 6.4; S6 5.1-5.2): one `ProjectedFrame` in, one SSE message out.

Only a frame that passed the projection is sent: anything that is not a `ProjectedFrame` raises, so a frame
built elsewhere cannot reach the wire (S5 1.2 item 2, S5 6.5). A persisted frame carries its `seq` as the SSE
`id`; a synthesized frame (`seq: null`) carries none, so it never moves the client's resume cursor. Every delta
is at most 16 KB of compact UTF-8 JSON (S4's 14,336-byte payload limit guarantees it, S5 6.2); a larger one is
a defect and raises rather than being sent. The ticketed stream loop lands with WP-13.
"""

from __future__ import annotations

from arena_core.events.projections import ProjectedFrame

MAX_DELTA_BYTES = 16 * 1024


def sse_message(projected: object) -> str:
    """The SSE message for one projected frame: `id: <seq>` when persisted, then `data: <json>`."""
    if not isinstance(projected, ProjectedFrame):
        msg = f"only a ProjectedFrame from arena_core.events.projections may be sent, not {type(projected).__name__}"
        raise TypeError(msg)
    frame = projected.frame
    data = frame.model_dump_json()
    if len(data.encode("utf-8")) > MAX_DELTA_BYTES:
        msg = f"delta of {len(data.encode('utf-8'))} bytes exceeds {MAX_DELTA_BYTES} (S5 6.2)"
        raise ValueError(msg)
    head = f"id: {frame.seq}\n" if frame.seq is not None else ""
    return f"{head}data: {data}\n\n"
