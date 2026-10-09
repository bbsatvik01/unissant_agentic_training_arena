"""The one projection (S5 6.2): the only code that turns event rows into wire frames, and the only code that
can hand a frame to the stream writer.

The guarantee is on the send path, not on construction: Python cannot stop a module from building a Pydantic
frame, so a frame reaches the wire only as a `ProjectedFrame`, and only this module can create one (its
constructor requires `_SEAL`, a module-private sentinel). `events.sse` refuses anything else.
`tools/check_roles.py` is a tripwire on top of this: outside this module it rejects importing a frame model
by name and importing this module's private names.

The row-to-frame mapping, the synthesized frames and the visibility filter land with WP-13 (S5 6.2); they
return frames through `_seal`.
"""

from __future__ import annotations

from typing import Final

from arena_core.contracts.events import ReplayFrame, TrialFrame

_SEAL: Final = object()

Frame = TrialFrame | ReplayFrame


class ProjectedFrame:
    """A frame the projection authorized for one viewer; the stream writer sends nothing else."""

    __slots__ = ("_frame",)

    def __init__(self, frame: Frame, seal: object) -> None:
        if seal is not _SEAL:
            msg = "a ProjectedFrame is created only by arena_core.events.projections"
            raise PermissionError(msg)
        self._frame = frame

    @property
    def frame(self) -> Frame:
        return self._frame


def _seal(frame: Frame) -> ProjectedFrame:
    """Authorize a frame this module built (the projection's own last step)."""
    return ProjectedFrame(frame, _SEAL)
