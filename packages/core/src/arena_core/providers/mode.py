"""Adapter selection by `ARENA_MODEL_MODE` (S5 10.4): `vertex` (default) or `fake` (local only, zero spend)."""

from __future__ import annotations

from collections.abc import Mapping

from arena_core.config import HOSTED_MARKER_VAR
from arena_core.providers.errors import ConfigError
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.types import ModelAdapter
from arena_core.providers.vertex import vertex_adapter

MODE_VAR = "ARENA_MODEL_MODE"
FAKE, VERTEX = "fake", "vertex"


def model_adapter(env: Mapping[str, str], *, canned: Mapping[str, str] | None = None) -> ModelAdapter:
    """The adapter the port uses in this process. Fake mode is refused on a hosted revision (S5 1.3)."""
    mode = env.get(MODE_VAR, "").strip() or VERTEX
    if mode == FAKE:
        if env.get(HOSTED_MARKER_VAR):
            msg = f"{MODE_VAR}=fake is refused when {HOSTED_MARKER_VAR} is set"
            raise ConfigError(msg)
        return FakeAdapter(canned=dict(canned or {}))
    if mode == VERTEX:
        return vertex_adapter(env)
    msg = f"{MODE_VAR} must be {FAKE!r} or {VERTEX!r}, got {mode!r}"
    raise ConfigError(msg)
