"""Unit tests for the session service and runtime-token renewer (no network)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from kimi_cli.config import get_default_config
from kimi_cli.sammad.client import SammadClient
from kimi_cli.sammad.errors import NotLoggedIn, SammadError
from kimi_cli.sammad.models import MintResponse
from kimi_cli.sammad.session import RuntimeTokenRenewer, SammadSession
from kimi_cli.sammad.settings import SammadSettings

BASE = "http://cp.test"


class FakeKeychain:
    def __init__(self, token: str | None = None) -> None:
        self.token = token

    def get(self) -> str | None:
        return self.token

    def set(self, token: str) -> None:
        self.token = token

    def delete(self) -> None:
        self.token = None


def ok(data: dict) -> httpx.Response:
    return httpx.Response(200, json={"data": data, "meta": {"requestId": "r"}})


def make_session(handler, *, token: str | None = None) -> tuple[SammadSession, FakeKeychain]:
    client = SammadClient(SammadSettings(api_base_url=BASE), transport=httpx.MockTransport(handler))
    kc = FakeKeychain(token)
    return SammadSession(client=client, keychain=kc), kc  # type: ignore[arg-type]


def test_login_stores_session_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/device/start":
            return ok(
                {
                    "deviceAuthId": "dev_1",
                    "userCode": "WXYZ",
                    "verificationUri": "https://microsoft.com/devicelogin",
                    "expiresAt": "2026-07-23T00:10:00Z",
                    "pollIntervalSeconds": 1,
                }
            )
        if request.url.path == "/api/v1/auth/device/poll":
            return ok(
                {
                    "status": "complete",
                    "cliSessionToken": "sess-xyz",
                    "user": {"id": "usr_1", "email": "a@b.test"},
                    "organization": {"id": "org_1", "name": "Northwind", "slug": "nw"},
                    "membership": {"id": "mem_1", "role": "owner"},
                }
            )
        raise AssertionError(request.url.path)

    session, kc = make_session(handler)
    prompts: list[str] = []
    result = session.login(on_prompt=lambda s: prompts.append(s.user_code), sleep=lambda _s: None)

    assert result.cli_session_token == "sess-xyz"
    assert kc.token == "sess-xyz"
    assert prompts == ["WXYZ"]


def test_whoami_without_token_raises_not_logged_in() -> None:
    session, _ = make_session(lambda req: ok({}))
    with pytest.raises(NotLoggedIn):
        session.whoami()


def test_logout_clears_local_token_even_if_server_fails() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"code": "internal_error", "message": "x"}})

    session, kc = make_session(handler, token="sess-xyz")
    session.logout()
    assert kc.token is None


def test_configure_run_writes_provider_model_and_default(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/runtime-tokens"
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
                    "capabilities": ["thinking"],
                },
            }
        )

    session, _ = make_session(handler, token="sess-xyz")
    config = get_default_config()
    config_file = tmp_path / "config.toml"

    mint = session.configure_run(config, config_file=config_file)

    assert mint.token == "rtok-plain"
    assert config.default_model == "sammad-default"
    provider = config.providers[config.models["sammad-default"].provider]
    assert provider.type == "openai_legacy"
    assert provider.base_url == "http://gw.test/v1"
    assert provider.api_key.get_secret_value() == "rtok-plain"
    assert config.models["sammad-default"].max_context_size == 128000
    # The config validates end to end (model references an existing provider).
    assert config_file.exists()


# -- renewer ---------------------------------------------------------------

BASE_TIME = datetime(2026, 7, 23, 0, 0, 0, tzinfo=UTC)


def _mint(expires_minutes: int = 10, absolute_hours: int = 24) -> MintResponse:
    return MintResponse.model_validate(
        {
            "token": "rtok",
            "tokenId": "rtok_1",
            "familyId": "fam_1",
            "expiresAt": (BASE_TIME + timedelta(minutes=expires_minutes)).isoformat(),
            "absoluteExpiresAt": (BASE_TIME + timedelta(hours=absolute_hours)).isoformat(),
            "allowedModelAliases": ["agent-default"],
            "gatewayBaseUrl": "http://gw.test/v1",
            "modelSettings": {"name": "agent-default", "maxContextSize": 1000},
        }
    )


class FakeRenewClient:
    def __init__(self, new_expiry: str | None = None, error: SammadError | None = None) -> None:
        self.new_expiry = new_expiry
        self.error = error
        self.calls = 0

    def renew_runtime_token(self, session_token: str, token_id: str) -> str:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.new_expiry or ""


def test_seconds_until_renew_is_clamped_to_min() -> None:
    client = FakeRenewClient()
    r = RuntimeTokenRenewer(
        client,  # type: ignore[arg-type]
        "sess",
        _mint(expires_minutes=1),
        renew_skew_seconds=120.0,
        min_sleep_seconds=5.0,
        now=lambda: BASE_TIME,  # expiry is 60s out, minus 120s skew → negative → clamp
    )
    assert r.seconds_until_renew() == 5.0


def test_renew_once_extends_expiry_and_continues() -> None:
    client = FakeRenewClient(new_expiry=(BASE_TIME + timedelta(minutes=20)).isoformat())
    r = RuntimeTokenRenewer(
        client,  # type: ignore[arg-type]
        "sess",
        _mint(),
        now=lambda: BASE_TIME,
    )
    assert r.renew_once() is True
    assert client.calls == 1
    # Next renewal now targets the extended expiry (~20 min out, minus skew).
    assert r.seconds_until_renew() > 900


def test_renew_once_stops_at_absolute_cap_without_calling() -> None:
    client = FakeRenewClient()
    r = RuntimeTokenRenewer(
        client,  # type: ignore[arg-type]
        "sess",
        _mint(absolute_hours=24),
        now=lambda: BASE_TIME + timedelta(hours=25),
    )
    assert r.renew_once() is False
    assert client.calls == 0


def test_renew_once_stops_on_nonretryable_error() -> None:
    errors: list[SammadError] = []
    client = FakeRenewClient(error=SammadError("revoked", "gone", status=401, retryable=False))
    r = RuntimeTokenRenewer(
        client,  # type: ignore[arg-type]
        "sess",
        _mint(),
        now=lambda: BASE_TIME,
        on_error=errors.append,
    )
    assert r.renew_once() is False
    assert [e.code for e in errors] == ["revoked"]
