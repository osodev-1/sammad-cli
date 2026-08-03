"""Command tests for the sanad Typer app (fake session, no network)."""

from __future__ import annotations

import httpx
from typer.testing import CliRunner

from kimi_cli.sanad import cli as cli_mod
from kimi_cli.sanad.client import SanadClient
from kimi_cli.sanad.session import SanadSession
from kimi_cli.sanad.settings import SanadSettings
from tests.sanad.test_session import FakeKeychain, ok

runner = CliRunner()


def install_session(monkeypatch, handler, *, token=None):
    client = SanadClient(
        SanadSettings(api_base_url="http://cp.test"), transport=httpx.MockTransport(handler)
    )
    session = SanadSession(client=client, keychain=FakeKeychain(token))  # type: ignore[arg-type]
    monkeypatch.setattr(cli_mod, "_build_session", lambda: session)
    return session


def test_login_prints_prompt_and_success(monkeypatch):
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
        return ok(
            {
                "status": "complete",
                "cliSessionToken": "sess-xyz",
                "user": {"id": "usr_1", "email": "a@b.test"},
                "organization": {"id": "org_1", "name": "Northwind", "slug": "nw"},
                "membership": {"id": "mem_1", "role": "owner"},
            }
        )

    session = install_session(monkeypatch, handler)
    result = runner.invoke(cli_mod.sanad_app, ["login"])

    assert result.exit_code == 0, result.output
    assert "WXYZ" in result.output
    assert "a@b.test" in result.output
    assert session.stored_token() == "sess-xyz"


def test_whoami_not_logged_in_exits_nonzero(monkeypatch):
    install_session(monkeypatch, lambda req: ok({}))
    result = runner.invoke(cli_mod.sanad_app, ["whoami"])
    assert result.exit_code == 1
    assert "not signed in" in result.output.lower()


def test_whoami_shows_identity(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return ok(
            {
                "userId": "usr_1",
                "organizationId": "org_1",
                "membershipId": "mem_1",
                "role": "owner",
                "permissions": [],
            }
        )

    install_session(monkeypatch, handler, token="sess-xyz")
    result = runner.invoke(cli_mod.sanad_app, ["whoami"])
    assert result.exit_code == 0, result.output
    assert "owner" in result.output


def test_logout_clears_and_reports(monkeypatch):
    session = install_session(monkeypatch, lambda req: httpx.Response(204), token="sess-xyz")
    result = runner.invoke(cli_mod.sanad_app, ["logout"])
    assert result.exit_code == 0, result.output
    assert "Signed out" in result.output
    assert session.stored_token() is None


def test_doctor_reports_valid_session(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return ok(
            {
                "userId": "usr_1",
                "organizationId": "org_1",
                "membershipId": "mem_1",
                "role": "member",
                "permissions": [],
            }
        )

    install_session(monkeypatch, handler, token="sess-xyz")
    result = runner.invoke(cli_mod.sanad_app, ["doctor"])
    assert result.exit_code == 0, result.output
    assert "session valid" in result.output


def test_doctor_when_not_signed_in(monkeypatch):
    install_session(monkeypatch, lambda req: ok({}))
    result = runner.invoke(cli_mod.sanad_app, ["doctor"])
    assert result.exit_code == 0, result.output
    assert "not signed in" in result.output.lower()


def test_run_not_logged_in_fails_fast(monkeypatch):
    install_session(monkeypatch, lambda req: ok({}))
    result = runner.invoke(cli_mod.sanad_app, ["run"])
    assert result.exit_code == 1
    assert "not signed in" in result.output.lower()


def test_governed_env_disables_moonshot_egress_by_default():
    env: dict[str, str] = {}
    cli_mod._apply_governed_env(env)
    assert env["KIMI_DISABLE_TELEMETRY"] == "1"
    assert env["KIMI_CLI_NO_AUTO_UPDATE"] == "1"


def test_governed_env_respects_operator_override():
    env = {"KIMI_DISABLE_TELEMETRY": "0", "KIMI_CLI_NO_AUTO_UPDATE": "0"}
    cli_mod._apply_governed_env(env)
    # An operator who deliberately opts in still wins.
    assert env["KIMI_DISABLE_TELEMETRY"] == "0"
    assert env["KIMI_CLI_NO_AUTO_UPDATE"] == "0"
