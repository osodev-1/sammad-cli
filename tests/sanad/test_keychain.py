"""KeychainStore: env-token override for headless (web-terminal) deployments."""

from __future__ import annotations

import keyring
import pytest
from keyring.errors import KeyringError

from kimi_cli.sanad.errors import KeychainUnavailable
from kimi_cli.sanad.keychain import KeychainStore


def test_env_token_wins_and_never_touches_keyring(monkeypatch):
    monkeypatch.setenv("SANAD_SESSION_TOKEN", "sess_env")

    def boom(*args: object, **kwargs: object) -> str:
        raise AssertionError("keyring must not be touched when the env token is set")

    monkeypatch.setattr(keyring, "get_password", boom)
    assert KeychainStore("https://cp.test").get() == "sess_env"


def test_no_env_falls_through_to_keyring(monkeypatch):
    monkeypatch.delenv("SANAD_SESSION_TOKEN", raising=False)
    monkeypatch.setattr(keyring, "get_password", lambda service, account: "sess_kc")
    assert KeychainStore("https://cp.test").get() == "sess_kc"


def test_headless_without_env_fails_closed(monkeypatch):
    monkeypatch.delenv("SANAD_SESSION_TOKEN", raising=False)

    def raise_keyring_error(*args: object, **kwargs: object) -> str:
        raise KeyringError("no backend")

    monkeypatch.setattr(keyring, "get_password", raise_keyring_error)
    with pytest.raises(KeychainUnavailable):
        KeychainStore("https://cp.test").get()


def test_empty_env_is_ignored(monkeypatch):
    monkeypatch.setenv("SANAD_SESSION_TOKEN", "")
    monkeypatch.setattr(keyring, "get_password", lambda service, account: "sess_kc")
    assert KeychainStore("https://cp.test").get() == "sess_kc"
