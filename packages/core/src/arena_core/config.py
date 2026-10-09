"""Typed settings per role and the boot checks every arena process runs before anything else (S5 1.3).

Adapted from TechnoMile `bh_core/providers/policy.py` (`refuse_gemini_api_keys`; ATTRIBUTIONS.md): the
API-key refusal is kept, the OpenRouter/Jev rules are dropped (D-001: Vertex only, so there is no other
gateway to police here). Everything else in this module is new: the role/DSN isolation check, the
`ARENA_GCP_PROJECT` guard (including the `kbg-production` refusal, PATTERNS.md permission wall), and
the local-vs-hosted shape check are specific to this repo's four-role, credential-per-process layout.

Each check raises `BootCheckError` with the exact reason; `boot()` is what a role's `__main__` calls,
and turns that into `sys.exit(1)` with the reason on stderr (S5 1.4: "exits non-zero with a message
naming the extra credential").
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum

# D-001: Vertex only. An API key would route around ADC / service-account impersonation.
FORBIDDEN_MODEL_KEYS: tuple[str, ...] = ("GOOGLE_API_KEY", "GEMINI_API_KEY")
# gokbase production (PATTERNS.md permission wall): the workstation's default gcloud project. No arena
# command may ever run against it, by accident or otherwise.
REFUSED_GCP_PROJECT = "kbg-production"
OWNER_DSN_VAR = "ARENA_OWNER_DSN"
LOOPBACK_HOSTS: frozenset[str] = frozenset({"127.0.0.1", "localhost", "::1"})
# Cloud Run sets this on every revision (S5 1.3); its presence means "this is not the operator's
# workstation", whatever ARENA_ENV claims.
HOSTED_MARKER_VAR = "K_SERVICE"


class BootCheckError(RuntimeError):
    """One S5 1.3 boot check failed; the message is the exact refusal reason."""


class ArenaRole(StrEnum):
    API = "api"
    SUBJECT = "subject"
    REFEREE = "referee"
    TOURNAMENT = "tournament"


# Role -> the one DSN env var that role's process may hold (S5 1.1: arena-tournament shares the
# arena_public credential with arena-api; arena-subject and arena-referee each hold their own).
ROLE_DSN_VAR: dict[ArenaRole, str] = {
    ArenaRole.API: "ARENA_PUBLIC_DSN",
    ArenaRole.SUBJECT: "ARENA_SUBJECT_DSN",
    ArenaRole.REFEREE: "ARENA_REFEREE_DSN",
    ArenaRole.TOURNAMENT: "ARENA_PUBLIC_DSN",
}
ALL_ROLE_DSN_VARS: frozenset[str] = frozenset({"ARENA_PUBLIC_DSN", "ARENA_SUBJECT_DSN", "ARENA_REFEREE_DSN"})


def refuse_gemini_api_keys(env: Mapping[str, str]) -> None:
    """D-001: refuse to start with a Gemini/Google API key in the environment."""
    present = [name for name in FORBIDDEN_MODEL_KEYS if env.get(name)]
    if present:
        msg = f"{', '.join(present)} set: D-001 forbids API-key model access; Vertex uses ADC only"
        raise BootCheckError(msg)


def require_gcp_project(env: Mapping[str, str]) -> str:
    """`ARENA_GCP_PROJECT` must be set explicitly, and must never be the gokbase production project."""
    project = env.get("ARENA_GCP_PROJECT", "").strip()
    if not project:
        msg = "ARENA_GCP_PROJECT is not set; every arena command must name the arena project explicitly"
        raise BootCheckError(msg)
    if project == REFUSED_GCP_PROJECT:
        msg = f"ARENA_GCP_PROJECT={REFUSED_GCP_PROJECT!r} refused (gokbase production; PATTERNS.md permission wall)"
        raise BootCheckError(msg)
    return project


def require_single_role_dsn(role: ArenaRole, env: Mapping[str, str]) -> str:
    """Exactly one role DSN present, matching `role`; the owner DSN never reaches a running role."""
    if env.get(OWNER_DSN_VAR):
        msg = (
            f"{OWNER_DSN_VAR} is present; the owner credential is used only from the operator's shell, "
            "never by a running role"
        )
        raise BootCheckError(msg)
    own_var = ROLE_DSN_VAR[role]
    present = sorted(var for var in ALL_ROLE_DSN_VARS if env.get(var))
    extra = [var for var in present if var != own_var]
    if extra:
        msg = f"extra credential(s) {extra} present for ARENA_ROLE={role.value}; only {own_var} may be set"
        raise BootCheckError(msg)
    if own_var not in present:
        msg = f"{own_var} is not set for ARENA_ROLE={role.value}"
        raise BootCheckError(msg)
    return env[own_var]


def require_local_shape(env: Mapping[str, str]) -> bool:
    """Whether this is a local run; `ARENA_ENV=local` is refused outright on a Cloud Run host."""
    is_local = env.get("ARENA_ENV", "local") == "local"
    hosted = bool(env.get(HOSTED_MARKER_VAR))
    if is_local and hosted:
        msg = (
            f"ARENA_ENV=local is refused when {HOSTED_MARKER_VAR} is set "
            "(local-only features never run on a hosted revision)"
        )
        raise BootCheckError(msg)
    return is_local


def require_loopback_bind(*, is_local: bool, bind_host: str) -> None:
    """A local run binds 127.0.0.1 only."""
    if is_local and bind_host not in LOOPBACK_HOSTS:
        msg = f"ARENA_ENV=local requires a loopback bind address, got {bind_host!r}"
        raise BootCheckError(msg)


@dataclass(frozen=True, kw_only=True)
class Settings:
    role: ArenaRole
    env_name: str
    gcp_project: str
    dsn: str
    is_local: bool
    bind_host: str


def _parse_role(raw: str | None) -> ArenaRole:
    try:
        return ArenaRole(raw or "")
    except ValueError:
        msg = f"ARENA_ROLE must be one of {[r.value for r in ArenaRole]}, got {raw!r}"
        raise BootCheckError(msg) from None


def load_settings(
    env: Mapping[str, str], *, expected_role: ArenaRole | None = None, bind_host: str = "127.0.0.1"
) -> Settings:
    """Run every S5 1.3 boot check in order and return typed settings, or raise BootCheckError.

    `expected_role` lets a service's own entry point (which already knows it is `arena_api`, say)
    assert that the launcher actually set `ARENA_ROLE` to match, instead of silently trusting it.
    """
    role = _parse_role(env.get("ARENA_ROLE"))
    if expected_role is not None and role is not expected_role:
        msg = f"ARENA_ROLE={role.value} does not match this process ({expected_role.value})"
        raise BootCheckError(msg)
    refuse_gemini_api_keys(env)
    gcp_project = require_gcp_project(env)
    dsn = require_single_role_dsn(role, env)
    is_local = require_local_shape(env)
    require_loopback_bind(is_local=is_local, bind_host=bind_host)
    return Settings(
        role=role,
        env_name=env.get("ARENA_ENV", "local"),
        gcp_project=gcp_project,
        dsn=dsn,
        is_local=is_local,
        bind_host=bind_host,
    )


def boot(
    expected_role: ArenaRole,
    env: Mapping[str, str] | None = None,
    *,
    bind_host: str = "127.0.0.1",
    exit_on_failure: bool = True,
) -> Settings:
    """Entry point every role's `__main__` calls first.

    On failure: writes the reason to stderr and calls `sys.exit(1)` (S5 1.4), unless
    `exit_on_failure=False`, in which case `BootCheckError` propagates for the caller to handle (tests).
    """
    resolved_env = os.environ if env is None else env
    try:
        return load_settings(resolved_env, expected_role=expected_role, bind_host=bind_host)
    except BootCheckError as exc:
        if not exit_on_failure:
            raise
        sys.stderr.write(f"arena boot check failed: {exc}\n")
        raise SystemExit(1) from exc
