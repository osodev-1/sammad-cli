"""Unit tests for the sammad client — no network, httpx.MockTransport."""

from __future__ import annotations

import httpx
import pytest

from kimi_cli.sammad.client import SammadClient
from kimi_cli.sammad.errors import SammadError
from kimi_cli.sammad.settings import SammadSettings

BASE = "http://cp.test"


def make_client(handler):
    return SammadClient(SammadSettings(api_base_url=BASE), transport=httpx.MockTransport(handler))


def ok(data):
    return httpx.Response(200, json={"data": data, "meta": {"requestId": "req_1"}})


def err(status, code, retryable=False):
    return httpx.Response(
        status,
        json={"error": {"code": code, "message": "nope", "requestId": "r", "retryable": retryable}},
    )


def test_device_start_and_poll_pending_then_complete():
    calls = {"poll": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/device/start":
            return httpx.Response(
                201,
                json={
                    "data": {
                        "deviceAuthId": "dev_1",
                        "userCode": "ABCD1234",
                        "verificationUri": "https://microsoft.com/devicelogin",
                        "expiresAt": "2026-07-23T00:10:00Z",
                        "pollIntervalSeconds": 1,
                    }
                },
            )
        if request.url.path == "/api/v1/auth/device/poll":
            calls["poll"] += 1
            if calls["poll"] < 2:
                return ok({"status": "pending"})
            return ok(
                {
                    "status": "complete",
                    "cliSessionToken": "sess-xyz",
                    "user": {"id": "usr_1", "email": "a@b.test", "displayName": "A"},
                    "organization": {"id": "org_1", "name": "Northwind", "slug": "nw"},
                    "membership": {"id": "mem_1", "role": "owner"},
                }
            )
        raise AssertionError(request.url.path)

    client = make_client(handler)
    start = client.device_start()
    assert start.user_code == "ABCD1234"
    result = client.poll_until_complete(start, sleep=lambda _s: None)
    assert result.status == "complete"
    assert result.cli_session_token == "sess-xyz"
    assert result.organization.name == "Northwind"
    assert calls["poll"] == 2


def test_error_envelope_becomes_sammad_error():
    client = make_client(lambda req: err(403, "tenant_not_allowed"))
    with pytest.raises(SammadError) as excinfo:
        client.device_poll("dev_x")
    assert excinfo.value.code == "tenant_not_allowed"
    assert excinfo.value.status == 403


def test_mint_parses_model_settings_and_gateway():
    def handler(req):
        assert req.headers["authorization"] == "Bearer sess-xyz"
        return ok(
            {
                "token": "rtok-plain",
                "tokenId": "rtok_1",
                "familyId": "rtfam_1",
                "expiresAt": "2026-07-23T00:10:00Z",
                "absoluteExpiresAt": "2026-07-24T00:00:00Z",
                "allowedModelAliases": ["agent-default"],
                "gatewayBaseUrl": "http://gw.test/v1",
                "modelSettings": {
                    "name": "agent-default",
                    "maxContextSize": 128000,
                    "capabilities": ["thinking", "tool_use"],
                },
            }
        )

    mint = make_client(handler).mint_runtime_token("sess-xyz")
    assert mint.token == "rtok-plain"
    assert mint.gateway_base_url == "http://gw.test/v1"
    assert mint.model_settings.max_context_size == 128000


def test_logout_204_is_none():
    client = make_client(lambda req: httpx.Response(204))
    assert client.logout("sess") is None
