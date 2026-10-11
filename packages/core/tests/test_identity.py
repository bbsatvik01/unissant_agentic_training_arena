"""Dev identity (S5 9.3, 10.3): allowlist loading, email-to-user_id mapping, resolve_dev_user."""

from __future__ import annotations

from pathlib import Path

import pytest

from arena_core.identity import (
    IdentityError,
    load_allowlist,
    resolve_dev_user,
    user_id_for,
)

ALLOWLIST = """
[[users]]
email = "Trainer@Example.Test"
display_name = "T. Rainer"
roles = ["trainer"]

[[users]]
email = "admin@example.test"
display_name = "A. Dmin"
roles = ["admin", "trainer"]
"""


def write_allowlist(tmp_path: Path, text: str = ALLOWLIST) -> Path:
    path = tmp_path / "users.toml"
    path.write_text(text)
    return path


def test_user_id_for_is_stable_and_case_insensitive() -> None:
    a = user_id_for("Someone@Example.Test")
    b = user_id_for("someone@example.test")
    assert a == b


def test_user_id_for_differs_across_emails() -> None:
    assert user_id_for("a@example.test") != user_id_for("b@example.test")


def test_load_allowlist_lowercases_email_and_parses_roles(tmp_path: Path) -> None:
    path = write_allowlist(tmp_path)
    users = load_allowlist(path)
    assert set(users) == {"trainer@example.test", "admin@example.test"}
    assert users["admin@example.test"].roles == frozenset({"admin", "trainer"})


def test_load_allowlist_refuses_unknown_role(tmp_path: Path) -> None:
    bad_role = '[[users]]\nemail = "x@example.test"\ndisplay_name = "X"\nroles = ["superadmin"]\n'
    path = write_allowlist(tmp_path, bad_role)
    with pytest.raises(IdentityError, match="unknown role"):
        load_allowlist(path)


def test_load_allowlist_refuses_duplicate_email(tmp_path: Path) -> None:
    dup = '[[users]]\nemail = "x@example.test"\ndisplay_name = "X"\nroles = ["admin"]\n' * 2
    path = write_allowlist(tmp_path, dup)
    with pytest.raises(IdentityError, match="twice"):
        load_allowlist(path)


def test_load_allowlist_refuses_missing_file(tmp_path: Path) -> None:
    with pytest.raises(IdentityError, match="does not exist"):
        load_allowlist(tmp_path / "missing.toml")


def test_load_allowlist_refuses_malformed_toml(tmp_path: Path) -> None:
    path = write_allowlist(tmp_path, "not valid toml {{{")
    with pytest.raises(IdentityError, match="not valid TOML"):
        load_allowlist(path)


def test_resolve_dev_user_matches_case_insensitively(tmp_path: Path) -> None:
    path = write_allowlist(tmp_path)
    env = {"ARENA_DEV_USER": "ADMIN@EXAMPLE.TEST", "ARENA_USERS_FILE": str(path)}
    identity = resolve_dev_user(env)
    assert identity.email == "admin@example.test"
    assert identity.has_role("admin")
    assert identity.user_id == user_id_for("admin@example.test")


def test_resolve_dev_user_refuses_email_outside_allowlist(tmp_path: Path) -> None:
    path = write_allowlist(tmp_path)
    env = {"ARENA_DEV_USER": "nobody@example.test", "ARENA_USERS_FILE": str(path)}
    with pytest.raises(IdentityError, match="not in the allowlist"):
        resolve_dev_user(env)


def test_resolve_dev_user_refuses_unset_dev_user(tmp_path: Path) -> None:
    path = write_allowlist(tmp_path)
    with pytest.raises(IdentityError, match="ARENA_DEV_USER"):
        resolve_dev_user({"ARENA_USERS_FILE": str(path)})


def test_resolve_dev_user_refuses_unset_users_file() -> None:
    with pytest.raises(IdentityError, match="ARENA_USERS_FILE"):
        resolve_dev_user({"ARENA_DEV_USER": "admin@example.test"})
