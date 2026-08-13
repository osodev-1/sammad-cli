"""OS-keychain storage for the opaque CLI session token (fail-closed)."""

from __future__ import annotations

import os

import keyring
from keyring.errors import KeyringError, PasswordDeleteError

from kimi_cli.sanad.errors import KeychainUnavailable
from kimi_cli.sanad.settings import ENV_SESSION_TOKEN, KEYCHAIN_SERVICE


class KeychainStore:
    """The session token lives only here — never on disk in plaintext (Q16).

    The account is the API base URL so tokens for different deployments coexist.

    Containerized runs (the web terminal) have no Secret Service; the parent
    process injects the token per-session via ``SANAD_SESSION_TOKEN``, which
    ``get()`` honors before touching any keyring backend. With the env var set,
    ``logout`` still clears only the keychain — the env token keeps working for
    the life of the process, which is the desired server-side behavior.
    """

    def __init__(self, account: str, *, service: str = KEYCHAIN_SERVICE) -> None:
        self._service = service
        self._account = account

    def get(self) -> str | None:
        # Checked first so a headless host never touches (or blocks probing)
        # a keyring backend.
        if env_token := os.environ.get(ENV_SESSION_TOKEN):
            return env_token
        try:
            return keyring.get_password(self._service, self._account)
        except KeyringError as exc:
            raise KeychainUnavailable(exc) from exc

    def set(self, token: str) -> None:
        try:
            keyring.set_password(self._service, self._account, token)
        except KeyringError as exc:
            raise KeychainUnavailable(exc) from exc

    def delete(self) -> None:
        try:
            keyring.delete_password(self._service, self._account)
        except PasswordDeleteError:
            pass  # deleting a nonexistent credential is a no-op
        except KeyringError as exc:
            raise KeychainUnavailable(exc) from exc
