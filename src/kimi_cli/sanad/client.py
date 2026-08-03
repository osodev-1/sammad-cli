"""Synchronous client for the sanad control plane (device flow + runtime tokens).

The CLI only ever holds an opaque session token (ADR-016). Every response is
parsed into a typed model; error envelopes become :class:`SanadError`.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import httpx

from kimi_cli.sanad.errors import SanadError
from kimi_cli.sanad.models import DevicePoll, DeviceStart, Me, MintResponse
from kimi_cli.sanad.settings import SanadSettings


class SanadClient:
    def __init__(
        self,
        settings: SanadSettings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._http = httpx.Client(
            base_url=settings.api_base_url,
            timeout=settings.request_timeout,
            transport=transport,
        )

    # -- low level --------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict | None = None,
        session_token: str | None = None,
    ) -> object:
        headers: dict[str, str] = {}
        if session_token is not None:
            headers["authorization"] = f"Bearer {session_token}"
        try:
            resp = self._http.request(method, path, json=json, headers=headers)
        except httpx.HTTPError as exc:
            raise SanadError(
                "network_error", f"Could not reach the sanad control plane: {exc}", retryable=True
            ) from exc
        if resp.status_code == 204:
            return None
        payload: object = None
        if resp.content:
            try:
                payload = resp.json()
            except ValueError:
                payload = None
        if resp.status_code >= 400:
            err = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(err, dict):
                raise SanadError(
                    str(err.get("code", "internal_error")),
                    str(err.get("message", "Request failed.")),
                    status=resp.status_code,
                    retryable=bool(err.get("retryable")),
                )
            raise SanadError(
                "internal_error",
                f"HTTP {resp.status_code}",
                status=resp.status_code,
                retryable=True,
            )
        if isinstance(payload, dict) and "data" in payload:
            return payload["data"]
        return payload

    # -- auth -------------------------------------------------------------
    def device_start(self) -> DeviceStart:
        return DeviceStart.model_validate(self._request("POST", "/api/v1/auth/device/start"))

    def device_poll(self, device_auth_id: str) -> DevicePoll:
        return DevicePoll.model_validate(
            self._request("POST", "/api/v1/auth/device/poll", json={"deviceAuthId": device_auth_id})
        )

    def me(self, session_token: str) -> Me:
        return Me.model_validate(
            self._request("GET", "/api/v1/auth/me", session_token=session_token)
        )

    def logout(self, session_token: str) -> None:
        self._request("POST", "/api/v1/auth/logout", session_token=session_token)

    # -- runtime tokens ---------------------------------------------------
    def mint_runtime_token(self, session_token: str) -> MintResponse:
        return MintResponse.model_validate(
            self._request("POST", "/api/v1/runtime-tokens", json={}, session_token=session_token)
        )

    def renew_runtime_token(self, session_token: str, token_id: str) -> str:
        data = self._request(
            "POST",
            "/api/v1/runtime-tokens/renew",
            json={"tokenId": token_id},
            session_token=session_token,
        )
        return str(data["expiresAt"]) if isinstance(data, dict) else ""

    def revoke_runtime_token_family(self, session_token: str, family_id: str) -> None:
        self._request(
            "POST",
            "/api/v1/runtime-tokens/revoke",
            json={"familyId": family_id},
            session_token=session_token,
        )

    # -- high level -------------------------------------------------------
    def poll_until_complete(
        self,
        start: DeviceStart,
        *,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
        deadline_seconds: float | None = None,
    ) -> DevicePoll:
        """Poll the device authorization until it completes, expires, or errors."""
        budget = deadline_seconds if deadline_seconds is not None else float(60 * 15)
        started = now()
        while True:
            if now() - started > budget:
                raise SanadError("device_authorization_expired", "Sign-in timed out.", status=410)
            result = self.device_poll(start.device_auth_id)
            if result.status == "complete":
                return result
            sleep(float(start.poll_interval_seconds))

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> SanadClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
