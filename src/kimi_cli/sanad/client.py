"""Synchronous client for the sanad control plane (device flow + runtime tokens).

The CLI only ever holds an opaque session token (ADR-016). Every response is
parsed into a typed model; error envelopes become :class:`SanadError`.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import httpx

from kimi_cli.sanad.errors import SanadError
from kimi_cli.sanad.models import (
    DeployResult,
    DevicePoll,
    DeviceStart,
    Me,
    MintResponse,
    RunRow,
    UsageSummary,
)
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
    def _send(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, object] | None = None,
        params: dict[str, str | int] | None = None,
        session_token: str | None = None,
        follow_redirects: bool = False,
    ) -> httpx.Response:
        headers: dict[str, str] = {}
        if session_token is not None:
            headers["authorization"] = f"Bearer {session_token}"
        try:
            return self._http.request(
                method,
                path,
                json=json,
                params=params,
                headers=headers,
                follow_redirects=follow_redirects,
            )
        except httpx.HTTPError as exc:
            raise SanadError(
                "network_error", f"Could not reach the sanad control plane: {exc}", retryable=True
            ) from exc

    def _unwrap(self, resp: httpx.Response) -> object:
        """Unwrap a ``{data: ...}`` envelope, raising :class:`SanadError` on ``{error: ...}``."""
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

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, object] | None = None,
        params: dict[str, str | int] | None = None,
        session_token: str | None = None,
    ) -> object:
        resp = self._send(method, path, json=json, params=params, session_token=session_token)
        return self._unwrap(resp)

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

    def usage(self, session_token: str) -> UsageSummary:
        return UsageSummary.model_validate(
            self._request("GET", "/api/v1/usage", session_token=session_token)
        )

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

    # -- worker agents ------------------------------------------------------
    def deploy_agent(
        self,
        session_token: str,
        *,
        name: str,
        files: dict[str, str],
        env: str,
        workspace: str = "default",
    ) -> DeployResult:
        """Upsert the agent, publish a new version, then deploy it to ``env``.

        Three sequential calls, in order — an agent must exist before it can
        take a version, and a version must exist before it can be deployed.
        Each response's envelope shape is the route's own (see
        ``control-plane/artifacts/sanad-web/app/api/v1/agents/route.ts`` and
        siblings): the agent-create response nests ``agentId`` (not ``id``),
        which is easy to get wrong copying from the wire shape by eye.
        """
        created = self._request(
            "POST",
            "/api/v1/agents",
            json={"name": name, "workspace": workspace},
            session_token=session_token,
        )
        agent_id = str(created["agentId"]) if isinstance(created, dict) else ""

        version = self._request(
            "POST",
            f"/api/v1/agents/{name}/versions",
            json={"files": files},
            session_token=session_token,
        )
        version_id = str(version["versionId"]) if isinstance(version, dict) else ""
        content_hash = str(version["contentHash"]) if isinstance(version, dict) else ""

        deployment = self._request(
            "POST",
            f"/api/v1/agents/{name}/deployments",
            json={"versionId": version_id, "env": env},
            session_token=session_token,
        )
        deployment_id = str(deployment["deploymentId"]) if isinstance(deployment, dict) else ""

        return DeployResult(
            agent_id=agent_id,
            version_id=version_id,
            deployment_id=deployment_id,
            content_hash=content_hash,
        )

    def set_deployment_status(
        self, session_token: str, *, agent: str, env: str, status: str
    ) -> None:
        """PATCH the deployment status (``active``/``paused``) for ``agent``/``env``."""
        self._request(
            "PATCH",
            f"/api/v1/agents/{agent}/deployments",
            json={"env": env, "status": status},
            session_token=session_token,
        )

    def list_runs(
        self,
        session_token: str,
        *,
        agent: str | None = None,
        env: str | None = None,
        limit: int = 20,
    ) -> list[RunRow]:
        params: dict[str, str | int] = {"limit": limit}
        if agent is not None:
            params["agent"] = agent
        if env is not None:
            params["env"] = env
        data = self._request("GET", "/api/v1/runs", params=params, session_token=session_token)
        rows = data.get("runs") if isinstance(data, dict) else None
        return [RunRow.model_validate(row) for row in (rows or [])]

    def get_run(self, session_token: str, run_id: str) -> RunRow:
        data = self._request("GET", f"/api/v1/runs/{run_id}", session_token=session_token)
        run = data.get("run") if isinstance(data, dict) else None
        return RunRow.model_validate(run)

    def get_run_trace_url(self, session_token: str, run_id: str) -> str:
        """Follow-less GET: the trace endpoint 307s to a presigned URL rather
        than proxying the object, so we read ``location`` off the redirect
        response itself instead of letting httpx chase it.
        """
        resp = self._send(
            "GET",
            f"/api/v1/runs/{run_id}/trace",
            session_token=session_token,
            follow_redirects=False,
        )
        if resp.is_redirect:
            location = resp.headers.get("location")
            if location:
                return location
        # Not a redirect (or a redirect without Location, which shouldn't
        # happen): let _unwrap raise the server's error envelope (e.g. 404
        # trace_unavailable), or fall through to a generic failure below.
        self._unwrap(resp)
        raise SanadError(
            "internal_error",
            "Trace endpoint did not return a redirect.",
            status=resp.status_code,
            retryable=True,
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
