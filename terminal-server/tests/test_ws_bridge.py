import json
import sys
from collections.abc import Mapping
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


def make_control_plane(tickets: Mapping[str, Mapping[str, object]]) -> ControlPlaneClient:
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
            assert ready == {
                "type": "ready",
                "userId": "user_1",
                "cols": 100,
                "rows": 30,
                "resumed": False,
            }

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


def test_connect_over_cap_replaces_oldest(tmp_path: Path):
    identities = {"tt_a": IDENTITY, "tt_b": IDENTITY}
    app = create_app(
        make_settings(tmp_path, max_sessions_per_user=1),
        make_control_plane(identities),
    )
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


def test_concurrent_sessions_within_cap_coexist(tmp_path: Path):
    identities = {"tt_a": IDENTITY, "tt_b": IDENTITY, "tt_c": IDENTITY}
    app = create_app(
        make_settings(tmp_path, max_sessions_per_user=2),
        make_control_plane(identities),
    )
    with (
        TestClient(app) as client,
        client.websocket_connect("/ws") as first,
        client.websocket_connect("/ws") as second,
    ):
        first.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
        drain_until_ready(first)
        second.send_text(json.dumps({"type": "auth", "ticket": "tt_b"}))
        drain_until_ready(second)

        # Both live at once.
        assert client.get("/healthz").json()["activeSessions"] == 2

        # Both echo independently.
        first.send_bytes(b"one\n")
        second.send_bytes(b"two\n")
        buf1 = b""
        while b"one" not in buf1:
            msg = first.receive()
            if msg.get("bytes"):
                buf1 += msg["bytes"]
        buf2 = b""
        while b"two" not in buf2:
            msg = second.receive()
            if msg.get("bytes"):
                buf2 += msg["bytes"]

        # A third connect evicts the OLDEST (first), not the newest.
        with client.websocket_connect("/ws") as third:
            third.send_text(json.dumps({"type": "auth", "ticket": "tt_c"}))
            while True:
                msg = first.receive()
                if msg["type"] == "websocket.close":
                    assert msg["code"] == 4409
                    break
            drain_until_ready(third)


def test_healthz_counts_sessions(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({"tt_good": IDENTITY}))
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {
            "status": "ok",
            "activeSessions": 0,
            "detachedSessions": 0,
        }
        with client.websocket_connect("/ws") as ws:
            ws.send_text(AUTH)
            drain_until_ready(ws)
            assert client.get("/healthz").json()["activeSessions"] == 1
        # Disconnect DETACHES: the agent survives, awaiting reattach.
        wait_healthz(client, "detachedSessions", 1)
        assert client.get("/healthz").json()["activeSessions"] == 1


def wait_healthz(client: TestClient, key: str, value: int, tries: int = 150) -> None:
    import time

    for _ in range(tries):
        if client.get("/healthz").json()[key] == value:
            return
        time.sleep(0.02)
    raise AssertionError(f"healthz {key} never reached {value}")


def test_disconnect_detaches_and_reconnect_reattaches(tmp_path: Path):
    identities = {"tt_a": IDENTITY, "tt_b": IDENTITY}
    app = create_app(make_settings(tmp_path), make_control_plane(identities))
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as first:
            first.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
            drain_until_ready(first)
            first.send_bytes(b"landmark\n")
            buf = b""
            while b"landmark" not in buf:
                msg = first.receive()
                if msg.get("bytes"):
                    buf += msg["bytes"]
        # Socket closed → the agent survives, detached.
        wait_healthz(client, "detachedSessions", 1)
        assert client.get("/healthz").json()["activeSessions"] == 1

        with client.websocket_connect("/ws") as second:
            second.send_text(json.dumps({"type": "auth", "ticket": "tt_b", "cols": 90, "rows": 28}))
            ready = drain_until_ready(second)
            assert ready["resumed"] is True

            # The ring replay restores what happened before the drop…
            buf = b""
            while b"landmark" not in buf:
                msg = second.receive()
                if msg.get("bytes"):
                    buf += msg["bytes"]

            # …and it is the SAME live process: cat still echoes.
            second.send_bytes(b"still-alive\n")
            buf = b""
            while b"still-alive" not in buf:
                msg = second.receive()
                if msg.get("bytes"):
                    buf += msg["bytes"]

        assert client.get("/healthz").json()["activeSessions"] == 1


def test_detached_session_reaped_after_grace(tmp_path: Path):
    app = create_app(
        make_settings(tmp_path, detach_grace_seconds=0.0, watchdog_tick_seconds=0.05),
        make_control_plane({"tt_a": IDENTITY}),
    )
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
            drain_until_ready(ws)
        wait_healthz(client, "activeSessions", 0, tries=200)


def _fabricate_previous_session(tmp_path: Path, user: str = "user_1") -> None:
    import hashlib

    workspace = (tmp_path / "users" / user / "workspace").resolve()
    digest = hashlib.md5(str(workspace).encode("utf-8")).hexdigest()
    session_dir = tmp_path / "users" / user / "kimi-share" / "sessions" / digest / "sess-uuid"
    session_dir.mkdir(parents=True)
    (session_dir / "context.jsonl").write_text('{"role":"user"}\n')


def test_first_terminal_resumes_previous_conversation(tmp_path: Path):
    """With a prior session on disk, the FIRST spawn gets --resume <id>; a
    second concurrent terminal starts fresh (no resume args)."""
    identities = {"tt_a": IDENTITY, "tt_b": IDENTITY}
    # argv reveals its extra args, then keeps a cat alive.
    argv = ("bash", "-c", 'echo "ARGS:$*."; exec cat', "cli")
    (tmp_path / "users" / "user_1" / "workspace").mkdir(parents=True)
    _fabricate_previous_session(tmp_path)

    app = create_app(
        make_settings(tmp_path, spawn_argv=argv, max_sessions_per_user=2),
        make_control_plane(identities),
    )
    with (
        TestClient(app) as client,
        client.websocket_connect("/ws") as first,
    ):
        first.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
        ready = drain_until_ready(first)
        assert ready["resumed"] is False
        buf = b""
        while b"ARGS:" not in buf or b"." not in buf:
            msg = first.receive()
            if msg.get("bytes"):
                buf += msg["bytes"]
        assert b"ARGS:--resume sess-uuid." in buf  # resumes the scanned session

        with client.websocket_connect("/ws") as second:
            second.send_text(json.dumps({"type": "auth", "ticket": "tt_b"}))
            drain_until_ready(second)
            buf = b""
            while b"ARGS:" not in buf or b"." not in buf:
                msg = second.receive()
                if msg.get("bytes"):
                    buf += msg["bytes"]
            assert b"ARGS:." in buf  # concurrent terminal starts fresh


def test_gate_on_threads_session_locks_env_and_skips_a_live_owned_resume(tmp_path: Path):
    """M7 (review): gate-on (`session_locks_enabled=True`) must (a) put
    `SANAD_SESSION_LOCKS` in the PTY child's OWN env — the terminal TUI's
    own spawn path, the other half of "one brain, two views"; without this
    a terminal session could never acquire/heartbeat a lease even with the
    panel side on — and (b) apply `find_resumable_session`'s lease filter,
    skipping a session another view currently holds live rather than
    resuming into it out from under that view."""
    import hashlib
    import time

    # Echoes both argv (resume flag or not) and the env var in one line.
    argv = (
        "bash",
        "-c",
        'echo "ARGS:$*|LOCKS:${SANAD_SESSION_LOCKS:-unset}."; exec cat',
        "cli",
    )
    (tmp_path / "users" / "user_1" / "workspace").mkdir(parents=True)
    _fabricate_previous_session(tmp_path)

    # Live-owned right now — another view holds this exact session.
    workspace = (tmp_path / "users" / "user_1" / "workspace").resolve()
    digest = hashlib.md5(str(workspace).encode("utf-8")).hexdigest()
    session_dir = tmp_path / "users" / "user_1" / "kimi-share" / "sessions" / digest / "sess-uuid"
    (session_dir / "owner.json").write_text(
        json.dumps(
            {
                "holder": "wire:1",
                "pid": 1,
                "ui_mode": "wire",
                "generation": 1,
                "heartbeat_at": time.time(),
                "steal_requested_by": None,
                "busy": False,
            }
        )
    )

    app = create_app(
        make_settings(tmp_path, spawn_argv=argv, session_locks_enabled=True),
        make_control_plane({"tt_a": IDENTITY}),
    )
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
        drain_until_ready(ws)
        buf = b""
        while b"." not in buf:
            msg = ws.receive()
            if msg.get("bytes"):
                buf += msg["bytes"]
        # The env var reached the child, and no --resume arg was passed —
        # the live-owned session was skipped even though it's the only
        # candidate `_fabricate_previous_session` set up.
        assert b"ARGS:|LOCKS:1." in buf


PRODUCER_ARGV = ("bash", "-c", "while true; do echo tick; sleep 0.1; done")


def test_working_agent_survives_idle_timeout(tmp_path: Path):
    """Agent OUTPUT counts as activity: a long task with no typing is never
    reaped as idle, while a truly silent session still is."""
    import time

    identities = {"tt_a": IDENTITY, "tt_b": IDENTITY}
    app = create_app(
        make_settings(
            tmp_path,
            spawn_argv=PRODUCER_ARGV,
            idle_timeout_seconds=0.5,
            idle_warning_seconds=0.1,
            watchdog_tick_seconds=0.05,
            max_sessions_per_user=2,
        ),
        make_control_plane(identities),
    )
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
        drain_until_ready(ws)
        deadline = time.monotonic() + 1.5  # 3x the idle timeout
        while time.monotonic() < deadline:
            msg = ws.receive()
            assert msg["type"] != "websocket.close", "working agent was reaped as idle"
        ws.close()

    # Control: a silent agent (cat, no output, no input) IS idle-reaped.
    app2 = create_app(
        make_settings(
            tmp_path,
            idle_timeout_seconds=0.4,
            idle_warning_seconds=0.1,
            watchdog_tick_seconds=0.05,
        ),
        make_control_plane({"tt_b": IDENTITY}),
    )
    with TestClient(app2) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "ticket": "tt_b"}))
        drain_until_ready(ws)
        while True:
            msg = ws.receive()
            if msg["type"] == "websocket.close":
                assert msg["code"] == 4000
                break


def test_detached_working_agent_survives_grace(tmp_path: Path):
    """A detached agent still producing output is NOT reaped at the grace
    deadline — grace counts from its last sign of life."""
    import time

    app = create_app(
        make_settings(
            tmp_path,
            spawn_argv=PRODUCER_ARGV,
            detach_grace_seconds=0.2,
            watchdog_tick_seconds=0.05,
        ),
        make_control_plane({"tt_a": IDENTITY}),
    )
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_text(json.dumps({"type": "auth", "ticket": "tt_a"}))
            drain_until_ready(ws)
        wait_healthz(client, "detachedSessions", 1)
        time.sleep(0.7)  # 3.5x the grace window
        assert client.get("/healthz").json()["activeSessions"] == 1
