"""Async client for the control plane's server-to-server terminal endpoints."""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel


class ControlPlaneError(Exception):
    """A redeem failure with the control plane's error code attached."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(f"{code}: {message} (HTTP {status})")
        self.code = code
        self.message = message
        self.status = status


class RedeemedTicket(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    session_token: str
    user_id: str
    org_id: str
    email: str | None = None
    display_name: str | None = None


class ControlPlaneClient:
    """Thin wrapper over httpx; transport injectable for tests."""

    def __init__(
        self,
        base_url: str,
        shared_secret: str,
        *,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(base_url=base_url, timeout=timeout, transport=transport)
        self._secret = shared_secret

    async def redeem_ticket(self, ticket: str) -> RedeemedTicket:
        """Exchange a one-time ticket for the CLI session token + identity.

        Maps the control plane's error envelope onto ControlPlaneError with the
        codes the WS handler branches on: invalid_ticket / ticket_expired /
        redeem_failed.
        """
        try:
            resp = await self._http.post(
                "/api/v1/terminal/redeem",
                json={"ticket": ticket},
                headers={"x-terminal-secret": self._secret},
            )
        except httpx.HTTPError as exc:
            raise ControlPlaneError("redeem_failed", str(exc), 0) from exc

        payload: dict[str, Any]
        try:
            payload = resp.json()
        except ValueError:
            payload = {}

        if resp.status_code != 200:
            error = payload.get("error") or {}
            upstream_code = str(error.get("code", "unknown"))
            message = str(error.get("message", "redeem failed"))
            if resp.status_code == 410:
                code = "ticket_expired"
            elif resp.status_code in (404, 409):
                code = "invalid_ticket"
            else:
                code = "redeem_failed"
            raise ControlPlaneError(code, f"{upstream_code}: {message}", resp.status_code)

        try:
            return RedeemedTicket.model_validate(payload.get("data") or {})
        except ValidationError as exc:
            raise ControlPlaneError(
                "redeem_failed", f"malformed redeem response: {exc}", resp.status_code
            ) from exc

    async def aclose(self) -> None:
        await self._http.aclose()
