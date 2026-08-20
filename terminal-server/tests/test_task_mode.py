"""agentd task mode: single fixed user, bearer auth, machine-credential redeem."""

import json
import sys
from collections.abc import Mapping
from pathlib import Path

import httpx
import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import SettingsError, TerminalSettings
from starlette.testclient import TestClient

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="PTYs are POSIX-only")

IDENTITY = {
    "sessionToken": "sess_abc",
    "userId": "user_1",
    "orgId": "personal_user_1",
    "email": "a@b.test",
    "displayName": "A",
}
OTHER_IDENTITY = {**IDENTITY, "sessionToken": "sess_zzz", "userId": "user_2"}


def task_settings(tmp_path: Path, **overrides: object) -> TerminalSettings:
    defaults: dict[str, object] = {
        "mode": "task",
        "fixed_user": "user_1",
        "agentd_token": "derived-token",
        "machine_nonce": "nonce-1",
        "data_dir": tmp_path / "data",
        "spawn_argv": ("bash", "-c", "echo READY; exec cat"),
        "allowed_origins": ("https://allowed.test",),
        "auth_frame_timeout_seconds": 0.3,
        "child_api_base_url": "https://cp.test",
    }
    defaults.update(overrides)
    return TerminalSettings(**defaults)  # type: ignore[arg-type]


def machine_control_plane(tickets: Mapping[str, Mapping[str, object]]) -> ControlPlaneClient:
    """Verifies the machine-credential headers on every redeem."""
    seen: set[str] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-machine-token") == "derived-token"
        assert request.headers.get("x-machine-nonce") == "nonce-1"
        assert "x-terminal-secret" not in request.headers
        ticket = str(json.loads(request.content)["ticket"])
        if ticket in seen or ticket not in tickets:
            return httpx.Response(
                404,
                json={
                    "error": {
                        "code": "not_found",
                        "message": "nope",
                        "requestId": "r",
                        "retryable": False,
                    }
                },
            )
        seen.add(ticket)
        return httpx.Response(200, json={"data": tickets[ticket], "meta": {"requestId": "r"}})

    return ControlPlaneClient(
        "https://cp.test",
        "",
        machine_token="derived-token",
        machine_nonce="nonce-1",
        transport=httpx.MockTransport(handler),
    )


def drain_until_ready(ws) -> dict[str, object]:
    while True:
        msg = ws.receive()
        if msg.get("text"):
            frame = json.loads(msg["text"])
            if frame["type"] == "ready":
                return frame


# -- settings ------------------------------------------------------------------


def test_task_mode_settings_requirements():
    with pytest.raises(SettingsError, match="SANAD_WORKSPACE_USER"):
        TerminalSettings.load(
            {"WORKSPACE_MODE": "task", "TERMINAL_SPAWN_ARGV": "/bin/echo", "AGENTD_TOKEN": "t"}
        )
    with pytest.raises(SettingsError, match="AGENTD_TOKEN"):
        TerminalSettings.load(
            {
                "WORKSPACE_MODE": "task",
                "TERMINAL_SPAWN_ARGV": "/bin/echo",
                "SANAD_WORKSPACE_USER": "user_1",
            }
        )
    with pytest.raises(SettingsError, match="TRUST_STORE_KEY"):
        TerminalSettings.load(
            {
                "WORKSPACE_MODE": "task",
                "TERMINAL_SPAWN_ARGV": "/bin/echo",
                "SANAD_WORKSPACE_USER": "user_1",
                "AGENTD_TOKEN": "tok",
            }
        )
    with pytest.raises(SettingsError, match="AGENT_USER"):
        TerminalSettings.load(
            {
                "WORKSPACE_MODE": "task",
                "TERMINAL_SPAWN_ARGV": "/bin/echo",
                "SANAD_WORKSPACE_USER": "user_1",
                "AGENTD_TOKEN": "tok",
                "TRUST_STORE_KEY": "k",
            }
        )
    s = TerminalSettings.load(
        {
            "WORKSPACE_MODE": "task",
            "TERMINAL_SPAWN_ARGV": "/bin/echo run",
            "SANAD_WORKSPACE_USER": "user_1",
            "AGENTD_TOKEN": "tok",
            "MACHINE_NONCE": "n1",
            "TRUST_STORE_KEY": "k",
            "AGENT_USER": "dev",
        }
    )
    assert s.mode == "task"
    assert s.port == 7070  # task-mode default frees 8080 for user dev servers
    assert s.shared_secret == ""  # not required in task mode

    # railway mode still demands the shared secret
    with pytest.raises(SettingsError, match="TERMINAL_SHARED_SECRET"):
        TerminalSettings.load({"TERMINAL_SPAWN_ARGV": "/bin/echo"})


# -- WS: fixed user ------------------------------------------------------------


def test_ws_session_works_and_uses_flattened_data_dir(tmp_path: Path):
    app = create_app(task_settings(tmp_path), machine_control_plane({"tt_a": IDENTITY}))
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
        ready = drain_until_ready(ws)
        assert ready["userId"] == "user_1"
    for name in ("workspace", "home", "kimi-share"):
        assert (tmp_path / "data" / name).is_dir()
    # No per-user nesting in task mode.
    assert not (tmp_path / "data" / "users").exists()


def test_ws_rejects_ticket_for_a_different_user(tmp_path: Path):
    app = create_app(task_settings(tmp_path), machine_control_plane({"tt_b": OTHER_IDENTITY}))
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "ticket": "tt_b"}))
        msg = ws.receive()
        assert json.loads(msg["text"])["code"] == "invalid_ticket"
        closed = ws.receive()
        assert closed["code"] == 4401


# -- internal REST: bearer auth ------------------------------------------------


def test_internal_routes_use_bearer_not_headers(tmp_path: Path):
    app = create_app(task_settings(tmp_path), machine_control_plane({}))
    with TestClient(app) as client:
        # No auth → 401; legacy railway headers → 401; wrong bearer → 401.
        assert client.get("/internal/workspace/tree").status_code == 401
        assert (
            client.get(
                "/internal/workspace/tree",
                headers={"x-terminal-secret": "derived-token", "x-workspace-user": "user_1"},
            ).status_code
            == 401
        )
        assert (
            client.get(
                "/internal/workspace/tree", headers={"authorization": "Bearer wrong"}
            ).status_code
            == 401
        )

        ok = client.get(
            "/internal/workspace/tree", headers={"authorization": "Bearer derived-token"}
        )
        assert ok.status_code == 200
        # Boot seeds an empty .sanad blueprint, so the tree is not empty.
        assert any(e["name"] == ".sanad" for e in ok.json()["entries"])

        # keepalive is authenticated the same way
        assert client.post("/internal/workspace/keepalive").status_code == 401
        assert (
            client.post(
                "/internal/workspace/keepalive",
                headers={"authorization": "Bearer derived-token"},
            ).status_code
            == 200
        )
