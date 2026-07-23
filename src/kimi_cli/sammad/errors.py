"""Stable, safe error type for the sammad control-plane client."""

from __future__ import annotations


class SammadError(Exception):
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


class KeychainUnavailable(SammadError):
    """No OS keychain is available; sammad never falls back to plaintext."""

    def __init__(self, cause: object | None = None) -> None:
        super().__init__(
            "keychain_unavailable",
            "No OS keychain is available. sammad stores its session token only in the "
            "system keychain (macOS Keychain, Windows Credential Manager, or a Secret "
            "Service provider such as GNOME Keyring on Linux). Unlock or install one and "
            "retry — a plaintext fallback is intentionally not supported.",
        )
        self.__cause__ = cause if isinstance(cause, BaseException) else None
