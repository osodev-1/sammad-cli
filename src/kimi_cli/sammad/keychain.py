"""OS-keychain storage for the opaque CLI session token (fail-closed)."""

from __future__ import annotations

import keyring
from keyring.errors import KeyringError

from kimi_cli.sammad.errors import KeychainUnavailable
from kimi_cli.sammad.settings import KEYCHAIN_SERVICE


class KeychainStore:
    """The session token lives only here — never on disk in plaintext (Q16).

    The account is the API base URL so tokens for different deployments coexist.
    """

    def __init__(self, account: str, *, service: str = KEYCHAIN_SERVICE) -> None:
        self._service = service
        self._account = account

    def get(self) -> str | None:
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
        except keyring.errors.PasswordDeleteError:
            pass  # deleting a nonexistent credential is a no-op
        except KeyringError as exc:
            raise KeychainUnavailable(exc) from exc
