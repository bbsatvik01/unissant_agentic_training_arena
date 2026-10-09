"""SSE writing of trial deltas (S5 6.2, 6.4; S6 5.1-5.2): the stream writes only the bytes the projection returns.

`write_deltas` takes the stored events and the viewer, asks `events.projections.wire_deltas` for the finished
SSE messages and writes them; it never sees a frame object, so a frame that did not pass the projection cannot
reach the wire (S5 1.2 item 2, S5 6.5). The ticketed stream loop, pings and `stream_max_s` land with WP-13.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from arena_core.events.projections import StoredEvent, Viewer, wire_deltas


def write_deltas(write: Callable[[bytes], object], rows: Iterable[StoredEvent], viewer: Viewer) -> int:
    """Write this viewer's deltas for these stored events; returns how many messages were written."""
    messages = wire_deltas(rows, viewer)
    for message in messages:
        write(message)
    return len(messages)
