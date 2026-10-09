"""S5 1.3/1.4 boot checks: every acceptance bullet as a test, plus the gateproof for each refusal."""

from collections.abc import Iterator, Mapping

import pytest

from arena_core import config

GOOD_ENV: dict[str, str] = {
    "ARENA_ROLE": "api",
    "ARENA_GCP_PROJECT": "cna-guardian",
    "ARENA_PUBLIC_DSN": "postgresql://api:not-a-real-password@127.0.0.1/arena",
    "ARENA_ENV": "local",
}


def env(**overrides: str | None) -> dict[str, str]:
    """GOOD_ENV with overrides; a None value deletes the key."""
    merged = dict(GOOD_ENV)
    for key, value in overrides.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def test_a_clean_local_api_environment_boots() -> None:
    settings = config.load_settings(env())
    assert settings.role is config.ArenaRole.API
    assert settings.dsn == GOOD_ENV["ARENA_PUBLIC_DSN"]
    assert settings.gcp_project == "cna-guardian"
    assert settings.is_local is True
    assert settings.bind_host == "127.0.0.1"


@pytest.mark.parametrize("role", list(config.ArenaRole))
def test_every_role_boots_with_its_own_dsn_only(role: config.ArenaRole) -> None:
    own_var = config.ROLE_DSN_VAR[role]
    e = {
        "ARENA_ROLE": role.value,
        "ARENA_GCP_PROJECT": "cna-guardian",
        "ARENA_ENV": "local",
        own_var: "postgresql://x/db",
    }
    settings = config.load_settings(e)
    assert settings.role is role
    assert settings.dsn == "postgresql://x/db"


def test_unknown_role_is_refused() -> None:
    with pytest.raises(config.BootCheckError, match="ARENA_ROLE must be one of"):
        config.load_settings(env(ARENA_ROLE="made-up"))


def test_expected_role_mismatch_is_refused() -> None:
    with pytest.raises(config.BootCheckError, match="does not match this process"):
        config.load_settings(env(), expected_role=config.ArenaRole.SUBJECT)


# ---------------------------------------------------------------- S5 1.4 bullet: GEMINI_API_KEY
@pytest.mark.gateproof
@pytest.mark.parametrize("var", ["GOOGLE_API_KEY", "GEMINI_API_KEY"])
def test_any_role_with_a_gemini_api_key_is_refused(var: str) -> None:
    with pytest.raises(config.BootCheckError, match="D-001 forbids API-key model access"):
        config.load_settings(env(**{var: "fake-key-value"}))


def test_refuse_gemini_api_keys_names_every_key_present() -> None:
    with pytest.raises(config.BootCheckError, match="GOOGLE_API_KEY, GEMINI_API_KEY"):
        config.refuse_gemini_api_keys({"GOOGLE_API_KEY": "a", "GEMINI_API_KEY": "b"})


# ---------------------------------------------------------------- ARENA_GCP_PROJECT
@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_or_blank_gcp_project_is_refused(value: str | None) -> None:
    with pytest.raises(config.BootCheckError, match="ARENA_GCP_PROJECT is not set"):
        config.load_settings(env(ARENA_GCP_PROJECT=value))


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "value",
    [
        "kbg-production",
        " kbg-production ",
        "KBG-Production",
        "gen-lang-client-0635695834",
        "arena-dev-000000",
        "cna-guardian-2",
        "CNA-Guardian",
        " cna-guardian ",
        "cna-guardian\n",
        "\tcna-guardian",
        "cna_guardian",
    ],
)
def test_any_project_but_cna_guardian_is_refused(value: str) -> None:
    """D-015: the allowlist is exactly one project; every other spelling or project is refused."""
    with pytest.raises(config.BootCheckError, match="D-015"):
        config.load_settings(env(ARENA_GCP_PROJECT=value))


def test_cna_guardian_is_accepted_exactly() -> None:
    assert config.load_settings(env(ARENA_GCP_PROJECT="cna-guardian")).gcp_project == "cna-guardian"


# ---------------------------------------------------------------- S5 1.4 bullet: credential isolation
@pytest.mark.gateproof
def test_extra_role_dsn_is_refused_and_named() -> None:
    with pytest.raises(config.BootCheckError, match=r"extra credential\(s\) \['ARENA_SUBJECT_DSN'\]"):
        config.load_settings(env(ARENA_SUBJECT_DSN="postgresql://subject/db"))


@pytest.mark.gateproof
def test_owner_dsn_present_is_refused() -> None:
    with pytest.raises(config.BootCheckError, match="ARENA_OWNER_DSN"):
        config.load_settings(env(ARENA_OWNER_DSN="postgresql://owner/db"))


def test_own_dsn_missing_is_refused() -> None:
    with pytest.raises(config.BootCheckError, match="ARENA_PUBLIC_DSN is not set"):
        config.load_settings(env(ARENA_PUBLIC_DSN=None))


def test_settings_never_print_the_credential() -> None:
    """A logged Settings object must not leak the DSN (it carries the role's database password)."""
    settings = config.load_settings(env())
    assert "not-a-real-password" not in repr(settings)
    assert "not-a-real-password" not in str(settings)


# ---------------------------------------------------------------- S5 1.4 bullet: local shape / loopback
@pytest.mark.gateproof
def test_local_env_refused_when_hosted_marker_is_set() -> None:
    with pytest.raises(config.BootCheckError, match="K_SERVICE"):
        config.load_settings(env(K_SERVICE="arena-api"))


@pytest.mark.gateproof
def test_unset_arena_env_counts_as_local_and_is_refused_on_cloud_run() -> None:
    with pytest.raises(config.BootCheckError, match="K_SERVICE"):
        config.load_settings(env(ARENA_ENV=None, K_SERVICE="arena-api"))


@pytest.mark.parametrize("value", [None, "", "  "])
def test_unset_or_blank_arena_env_means_local(value: str | None) -> None:
    assert config.load_settings(env(ARENA_ENV=value)).is_local is True


@pytest.mark.gateproof
@pytest.mark.parametrize("value", ["Local", "dev", "staging", "production", "hosted "])
def test_an_unknown_arena_env_is_refused(value: str) -> None:
    with pytest.raises(config.BootCheckError, match="ARENA_ENV must be one of"):
        config.load_settings(env(ARENA_ENV=value))


# S5 1.3: "with ARENA_ENV=local the server binds 127.0.0.1 only" (S5 10.4 acceptance: a socket check
# finds every process on 127.0.0.1). Other loopback spellings are refused too: "localhost" resolves
# through /etc/hosts and "::1" is a different socket than the one the acceptance check inspects.
@pytest.mark.gateproof
@pytest.mark.parametrize("host", ["::", "10.1.2.3", "192.168.1.20", "::1", "localhost", "127.0.0.2", " ", ""])
def test_local_run_must_bind_127_0_0_1_only(host: str) -> None:
    with pytest.raises(config.BootCheckError, match="loopback bind address"):
        config.load_settings(env(ARENA_BIND_HOST=host))


def test_hosted_run_may_bind_any_host() -> None:
    settings = config.load_settings(env(ARENA_ENV="hosted", ARENA_BIND_HOST="10.1.2.3"))
    assert settings.is_local is False
    assert settings.bind_host == "10.1.2.3"


def test_hosted_run_defaults_to_loopback_unless_told_otherwise() -> None:
    assert config.load_settings(env(ARENA_ENV="hosted")).bind_host == "127.0.0.1"


@pytest.mark.parametrize("host", ["", "   "])
def test_hosted_run_refuses_a_blank_bind_host(host: str) -> None:
    with pytest.raises(config.BootCheckError, match="ARENA_BIND_HOST is blank"):
        config.load_settings(env(ARENA_ENV="hosted", ARENA_BIND_HOST=host))


# ---------------------------------------------------------------- boot() wraps load_settings as SystemExit
def test_boot_exits_1_with_reason_on_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    bad = env(ARENA_GCP_PROJECT="kbg-production")
    with pytest.raises(SystemExit) as exc_info:
        config.boot(config.ArenaRole.API, bad)
    assert exc_info.value.code == 1
    assert "D-015" in capsys.readouterr().err


def test_boot_propagates_when_exit_on_failure_is_false() -> None:
    bad = env(ARENA_GCP_PROJECT="kbg-production")
    with pytest.raises(config.BootCheckError, match="D-015"):
        config.boot(config.ArenaRole.API, bad, exit_on_failure=False)


def test_boot_returns_settings_on_success() -> None:
    settings = config.boot(config.ArenaRole.API, env())
    assert settings.role is config.ArenaRole.API


def test_boot_reads_os_environ_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.environ", env(), raising=False)
    settings = config.boot(config.ArenaRole.API)
    assert settings.role is config.ArenaRole.API


def test_load_settings_accepts_a_plain_mapping() -> None:
    class Frozen(Mapping[str, str]):
        def __init__(self, data: dict[str, str]) -> None:
            self._data = data

        def __getitem__(self, key: str) -> str:
            return self._data[key]

        def __iter__(self) -> Iterator[str]:
            return iter(self._data)

        def __len__(self) -> int:
            return len(self._data)

    settings = config.load_settings(Frozen(env()))
    assert settings.role is config.ArenaRole.API
