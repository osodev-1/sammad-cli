import json
import sys
from pathlib import Path

import httpx
import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="PTYs are POSIX-only")


def make_settings(tmp_path: Path, **overrides: object) -> TerminalSettings:
    defaults: dict[str, object] = {
        "shared_secret": "s3cret",
        "users_dir": tmp_path / "users",
        "spawn_argv": ("bash", "-c", "echo READY; exec cat"),
        "allowed_origins": ("https://allowed.test",),
        "auth_frame_timeout_seconds": 0.3,
        "child_api_base_url": "https://cp.test",
    }
    defaults.update(overrides)
    return TerminalSettings(**defaults)  # type: ignore[arg-type]


def make_control_plane(tickets: dict[str, dict[str, object]]) -> ControlPlaneClient:
    """Real client over MockTransport: known tickets redeem once, others 404."""
    seen: set[str] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        ticket = str(json.loads(request.content)["ticket"])
        if ticket in seen:
            return httpx.Response(
                409,
                json={
                    "error": {
                        "code": "conflict",
                        "message": "redeemed",
                        "requestId": "r",
                        "retryable": False,
                    }
                },
            )
        if ticket not in tickets:
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

    return ControlPlaneClient("https://cp.test", "s3cret", transport=httpx.MockTransport(handler))


IDENTITY = {
    "sessionToken": "sess_abc",
    "userId": "user_1",
    "orgId": "personal_user_1",
    "email": "a@b.test",
    "displayName": "A",
}

AUTH = json.dumps({"type": "auth", "ticket": "tt_good", "cols": 100, "rows": 30})


def drain_until_ready(ws) -> dict[str, object]:
    while True:
        msg = ws.receive()
        if msg.get("text"):
            frame = json.loads(msg["text"])
            if frame["type"] == "ready":
                return frame


def test_auth_then_ready_then_binary_echo(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({"tt_good": IDENTITY}))
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_text(AUTH)
            ready = drain_until_ready(ws)
            assert ready == {"type": "ready", "userId": "user_1", "cols": 100, "rows": 30}

            # PTY output (echo READY) arrives as binary
            buf = b""
            while b"READY" not in buf:
                msg = ws.receive()
                if msg.get("bytes"):
                    buf += msg["bytes"]

            ws.send_bytes(b"marco\n")
            buf = b""
            while b"marco" not in buf:
                msg = ws.receive()
                if msg.get("bytes"):
                    buf += msg["bytes"]

        # workspace triple was created
        for name in ("workspace", "home", "kimi-share"):
            assert (tmp_path / "users" / "user_1" / name).is_dir()


def test_bad_ticket_closes_4401(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({}))
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "ticket": "tt_nope"}))
        msg = ws.receive()
        assert json.loads(msg["text"]) == {"type": "error", "code": "invalid_ticket"}
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 4401


def test_missing_auth_frame_times_out_4408(tmp_path: Path):
    app = create_app(
        make_settings(tmp_path, auth_frame_timeout_seconds=0.15),
        make_control_plane({}),
    )
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        msg = ws.receive()
        assert json.loads(msg["text"])["code"] == "auth_timeout"
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 4408


def test_non_auth_first_frame_is_protocol_error(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({}))
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "ping"}))
        msg = ws.receive()
        assert json.loads(msg["text"])["code"] == "protocol_error"
        closed = ws.receive()
        assert closed["code"] == 4400


def test_browser_origin_enforced(tmp_path: Path):
    from starlette.websockets import WebSocketDisconnect

    app = create_app(make_settings(tmp_path), make_control_plane({}))
    with TestClient(app) as client:
        # Rejected before accept() — the connection never opens.
        with (
            pytest.raises(WebSocketDisconnect),
            client.websocket_connect("/ws", headers={"origin": "https://evil.test"}),
        ):
            pass

        # An allowlisted origin is let through to the auth phase.
        with client.websocket_connect("/ws", headers={"origin": "https://allowed.test"}) as ws:
            ws.send_text(json.dumps({"type": "auth", "ticket": "tt_nope"}))
            msg = ws.receive()
            assert json.loads(msg["text"])["code"] == "invalid_ticket"


def test_second_connect_replaces_first(tmp_path: Path):
    identities = {"tt_a": IDENTITY, "tt_b": IDENTITY}
    app = create_app(make_settings(tmp_path), make_control_plane(identities))
    with TestClient(app) as client, client.websocket_connect("/ws") as first:
        first.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
        drain_until_ready(first)

        with client.websocket_connect("/ws") as second:
            second.send_text(json.dumps({"type": "auth", "ticket": "tt_b"}))

            # First socket gets evicted with session_replaced + 4409
            saw_replaced = False
            while True:
                msg = first.receive()
                if msg.get("text") and json.loads(msg["text"]).get("code") == "session_replaced":
                    saw_replaced = True
                if msg["type"] == "websocket.close":
                    assert msg["code"] == 4409
                    break
            assert saw_replaced

            ready = drain_until_ready(second)
            assert ready["userId"] == "user_1"


def test_healthz_counts_sessions(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({"tt_good": IDENTITY}))
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok", "activeSessions": 0}
        with client.websocket_connect("/ws") as ws:
            ws.send_text(AUTH)
            drain_until_ready(ws)
            assert client.get("/healthz").json()["activeSessions"] == 1
        # after disconnect the registry drains (poll briefly — teardown is async)
        for _ in range(50):
            if client.get("/healthz").json()["activeSessions"] == 0:
                break
        assert client.get("/healthz").json()["activeSessions"] == 0
