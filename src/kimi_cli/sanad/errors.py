"""Stable, safe error type for the sanad control-plane client."""

from __future__ import annotations


class SanadError(Exception):
    """Carries the backend's machine error code so commands can map it cleanly."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable


class NotLoggedIn(SanadError):
    """No session token is stored; the user must run ``sanad login`` first."""

    def __init__(self) -> None:
        super().__init__(
            "not_logged_in",
            "You are not signed in. Run `sanad login` to authenticate.",
        )


class KeychainUnavailable(SanadError):
    """No OS keychain is available; sanad never falls back to plaintext."""

    def __init__(self, cause: object | None = None) -> None:
        super().__init__(
            "keychain_unavailable",
            "No OS keychain is available. sanad stores its session token only in the "
            "system keychain (macOS Keychain, Windows Credential Manager, or a Secret "
            "Service provider such as GNOME Keyring on Linux). Unlock or install one and "
            "retry — a plaintext fallback is intentionally not supported.",
        )
        self.__cause__ = cause if isinstance(cause, BaseException) else None
