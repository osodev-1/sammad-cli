"""Async client for the control plane's server-to-server terminal endpoints."""

from __future__ import annotations

from typing import Any

import httpx
from loguru import logger
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
    """Thin wrapper over httpx; transport injectable for tests.

    railway mode authenticates redeems with the shared service secret; task
    mode with the derived per-machine credential (token + the run nonce the
    control plane derives it from).
    """

    def __init__(
        self,
        base_url: str,
        shared_secret: str,
        *,
        machine_token: str = "",
        machine_nonce: str = "",
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(base_url=base_url, timeout=timeout, transport=transport)
        self._secret = shared_secret
        self._machine_token = machine_token
        self._machine_nonce = machine_nonce

    def _redeem_headers(self) -> dict[str, str]:
        if self._machine_token:
            return {
                "x-machine-token": self._machine_token,
                "x-machine-nonce": self._machine_nonce,
            }
        return {"x-terminal-secret": self._secret}

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
                headers=self._redeem_headers(),
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

    async def report_run_completion(
        self, run_id: str, agentd_token: str, payload: dict[str, Any]
    ) -> None:
        """POST a worker run's terminal outcome to `/api/v1/runs/{run_id}/complete`.

        Authenticated with the machine's OWN bearer (the task-mode `AGENTD_TOKEN`,
        the same credential every other `/internal/*` request on this machine
        carries in reverse) — deliberately NOT the redeem-flow headers
        `_redeem_headers` builds (`x-machine-token`/`x-terminal-secret`), which
        authenticate the machine to the control plane for a *different*
        purpose (ticket redemption) and aren't accepted by this endpoint.

        Fire-and-forget semantics end-to-end: a missing token (railway mode,
        or any machine that never got one) skips the call entirely rather than
        sending a bearer-less request that could only ever 401; any other
        failure (network error or a non-2xx response) is logged and
        swallowed, never raised. The control plane's reaper is the backstop
        for a machine that dies before a retry — see the P0 worker-panel
        design note this method implements.
        """
        if not agentd_token:
            logger.warning(
                "run {} finished but no agentd token is configured; "
                "skipping completion report (reaper will reap it)",
                run_id,
            )
            return
        try:
            resp = await self._http.post(
                f"/api/v1/runs/{run_id}/complete",
                json=payload,
                headers={"Authorization": f"Bearer {agentd_token}"},
            )
            if not resp.is_success:
                logger.warning(
                    "run completion report rejected run_id={} status={} body={}",
                    run_id,
                    resp.status_code,
                    resp.text,
                )
        except httpx.HTTPError as exc:
            logger.warning("run completion report failed run_id={}: {}", run_id, exc)

    async def aclose(self) -> None:
        await self._http.aclose()
