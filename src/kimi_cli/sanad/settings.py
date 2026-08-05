"""sanad runtime configuration (environment-driven)."""

from __future__ import annotations

import os
from dataclasses import dataclass

# www, not the apex: the apex has no A/AAAA record at the registrar (GoDaddy
# forwards it), so only the www host actually resolves and serves the API.
DEFAULT_API_BASE_URL = "https://www.sanadcode.com"
KEYCHAIN_SERVICE = "sanad-cli"


@dataclass(frozen=True, slots=True)
class SanadSettings:
    """Where the CLI talks to the sanad control plane."""

    api_base_url: str = DEFAULT_API_BASE_URL
    request_timeout: float = 30.0

    @classmethod
    def load(cls, env: dict[str, str] | os._Environ[str] | None = None) -> SanadSettings:
        e = os.environ if env is None else env
        return cls(
            api_base_url=e.get("SANAD_API_BASE_URL", DEFAULT_API_BASE_URL).rstrip("/"),
            request_timeout=float(e.get("SANAD_REQUEST_TIMEOUT", "30")),
        )
