"""sammad runtime configuration (environment-driven)."""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_API_BASE_URL = "http://127.0.0.1:3001"
KEYCHAIN_SERVICE = "sammad-cli"
"""The org model alias exposed to users; resolved to a deployment server-side."""
DEFAULT_MODEL_ALIAS = "agent-default"


@dataclass(frozen=True, slots=True)
class SammadSettings:
    """Where the CLI talks to the sammad control plane."""

    api_base_url: str = DEFAULT_API_BASE_URL
    request_timeout: float = 30.0

    @classmethod
    def load(cls, env: dict[str, str] | os._Environ[str] | None = None) -> SammadSettings:
        e = os.environ if env is None else env
        return cls(
            api_base_url=e.get("SAMMAD_API_BASE_URL", DEFAULT_API_BASE_URL).rstrip("/"),
            request_timeout=float(e.get("SAMMAD_REQUEST_TIMEOUT", "30")),
        )
