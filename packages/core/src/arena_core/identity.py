"""Allowlist, email-to-user_id mapping, dev identity (S5 9.3, 10.3).

Local identity: `ARENA_ENV=local` resolves the acting user from `ARENA_DEV_USER` (an email) checked against
`ARENA_USERS_FILE` (a gitignored TOML allowlist of email, display name and roles), with
`user_id = uuid5(ARENA_NAMESPACE, lowercased email)` -- the same mapping the hosted variant (WP-33) applies to
the IAP email, so a user's id never changes between the two. One acting user per run (S5 10.3): the allowlist
and the dev user are read once, by `resolve_dev_user`, and whoever calls it holds that identity until the
process restarts.

This module is the shared allowlist/mapping logic every role's dev-identity wiring uses; a service's own
ASGI middleware (`arena-api`'s investigator sessions, `arena-referee`'s admin and trainer consoles) calls
`resolve_dev_user` and acts on its `roles`.
"""

from __future__ import annotations

import tomllib
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# Fixed across every environment (local and hosted alike), so `uuid5(ARENA_NAMESPACE, email)` names the same
# user everywhere: generated once from a fixed string, never from a run's own randomness.
ARENA_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "arena.unissant.internal")

# S5 10.3: "roles from investigator, judge, trainer, admin"; UI v2 (D-036) adds instructor (arena-referee's
# instructor mode: the class, case assignments and notes on a trainee's recording).
ROLES = frozenset({"investigator", "judge", "trainer", "admin", "instructor"})


class IdentityError(RuntimeError):
    """The allowlist file is malformed, or `ARENA_DEV_USER` names no allowlisted email."""


@dataclass(frozen=True)
class AllowlistedUser:
    email: str  # lowercased
    display_name: str
    roles: frozenset[str]


@dataclass(frozen=True)
class DevIdentity:
    user_id: uuid.UUID
    email: str
    display_name: str
    roles: frozenset[str]

    def has_role(self, role: str) -> bool:
        return role in self.roles


def user_id_for(email: str) -> uuid.UUID:
    """`user_id = uuid5(ARENA_NAMESPACE, lowercased email)` (S5 10.3; the same mapping WP-33 applies to the
    IAP email)."""
    return uuid.uuid5(ARENA_NAMESPACE, email.strip().lower())


def _user_from_row(row: Mapping[str, object], path: Path) -> AllowlistedUser:
    email = row.get("email")
    display_name = row.get("display_name")
    roles = row.get("roles")
    if not isinstance(email, str) or not email.strip():
        msg = f"{path}: a [[users]] row needs a non-empty email"
        raise IdentityError(msg)
    if not isinstance(display_name, str) or not display_name.strip():
        msg = f"{path}: {email}: a [[users]] row needs a non-empty display_name"
        raise IdentityError(msg)
    if not isinstance(roles, list) or not roles or not all(isinstance(r, str) for r in roles):
        msg = f"{path}: {email}: roles must be a non-empty list of strings"
        raise IdentityError(msg)
    unknown = sorted(set(roles) - ROLES)
    if unknown:
        msg = f"{path}: {email}: unknown role(s) {unknown}; roles are {sorted(ROLES)}"
        raise IdentityError(msg)
    return AllowlistedUser(email=email.strip().lower(), display_name=display_name.strip(), roles=frozenset(roles))


def load_allowlist(path: Path) -> dict[str, AllowlistedUser]:
    """`ARENA_USERS_FILE`: `[[users]]` rows of `email`, `display_name`, `roles`. Keyed by lowercased email;
    a repeated email is refused (one row decides a user, never a later one silently overriding an earlier)."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        msg = f"ARENA_USERS_FILE {path} does not exist"
        raise IdentityError(msg) from None
    except tomllib.TOMLDecodeError as exc:
        msg = f"{path} is not valid TOML: {exc}"
        raise IdentityError(msg) from exc
    rows = raw.get("users")
    if not isinstance(rows, list) or not rows:
        msg = f"{path}: needs at least one [[users]] row"
        raise IdentityError(msg)
    out: dict[str, AllowlistedUser] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            msg = f"{path}: every [[users]] row must be a table"
            raise IdentityError(msg)
        user = _user_from_row(row, path)
        if user.email in out:
            msg = f"{path}: {user.email} appears twice"
            raise IdentityError(msg)
        out[user.email] = user
    return out


def resolve_dev_user(env: Mapping[str, str]) -> DevIdentity:
    """`ARENA_DEV_USER` (an email) checked against `ARENA_USERS_FILE`; refuses an unset variable, a file that
    does not parse, or an email the allowlist does not carry (S5 10.4: "an email outside the allowlist makes
    arena-api refuse every /api/* request with 403" -- the 403 is the caller's; this raises so it can)."""
    dev_user = env.get("ARENA_DEV_USER", "").strip()
    if not dev_user:
        msg = "ARENA_DEV_USER is not set"
        raise IdentityError(msg)
    users_file = env.get("ARENA_USERS_FILE", "").strip()
    if not users_file:
        msg = "ARENA_USERS_FILE is not set"
        raise IdentityError(msg)
    allowlist = load_allowlist(Path(users_file))
    user = allowlist.get(dev_user.strip().lower())
    if user is None:
        msg = f"{dev_user} is not in the allowlist"
        raise IdentityError(msg)
    return DevIdentity(
        user_id=user_id_for(user.email), email=user.email, display_name=user.display_name, roles=user.roles
    )
