"""POST /internal/terminal/restart — the blueprint-activation affordance.

Skills load when the CLI process is constructed, so restart kills the AGENT
PTYs (the next attach respawns fresh and resumes the conversation). It must
be kind-scoped (drawer shells survive) and user-scoped (railway mode hosts
several users in one container).
"""

from pathlib import Path

import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.manager import ActiveSession
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

SECRET = "s3cret"
USER = "user_1"
HEADERS = {"x-terminal-secret": SECRET, "x-workspace-user": USER}


class FakePty:
    def __init__(self) -> None:
        self.terminated = False

    async def terminate(self) -> None:
        self.terminated = True


class FakeWs:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed = False

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = True


@pytest.fixture
def client(tmp_path: Path):
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=("/bin/true",),
    )
    cp = ControlPlaneClient("https://cp.test", SECRET)
    app = create_app(settings, cp)
    with TestClient(app) as c:
        yield c


def _session(conn_id: str, user_id: str, kind: str, ws: FakeWs | None) -> ActiveSession:
    return ActiveSession(
        conn_id=conn_id,
        user_id=user_id,
        pty=FakePty(),  # type: ignore[arg-type] -- duck-typed: only terminate() is reached
        websocket=ws,
        kind=kind,
    )


def test_restart_requires_service_credential(client: TestClient):
    res = client.post(
        "/internal/terminal/restart",
        headers={"x-terminal-secret": "wrong", "x-workspace-user": USER},
    )
    assert res.status_code == 401
    res = client.post("/internal/terminal/restart", headers={"x-terminal-secret": SECRET})
    assert res.status_code == 400


def test_restart_with_no_sessions_is_a_noop(client: TestClient):
    res = client.post("/internal/terminal/restart", headers=HEADERS)
    assert res.status_code == 200
    assert res.json() == {"stopped": 0}


def test_restart_kills_only_this_users_agents(client: TestClient):
    manager = client.app.state.manager  # type: ignore[attr-defined]
    attached_ws = FakeWs()
    attached = _session("c1", USER, "agent", attached_ws)
    detached = _session("c2", USER, "agent", None)
    detached.detached_at = 123.0
    shell = _session("c3", USER, "shell", FakeWs())
    other_user = _session("c4", "user_2", "agent", FakeWs())
    for s in (attached, detached, shell, other_user):
        manager.register(s)

    res = client.post("/internal/terminal/restart", headers=HEADERS)
    assert res.status_code == 200
    assert res.json() == {"stopped": 2}

    # Both of this user's agents (attached AND detached) are gone and killed…
    assert attached.pty.terminated and detached.pty.terminated  # type: ignore[attr-defined]
    assert attached_ws.closed
    assert any("session_restarted" in frame for frame in attached_ws.sent)
    # …while the drawer shell and the other user's agent are untouched.
    assert not shell.pty.terminated and not other_user.pty.terminated  # type: ignore[attr-defined]
    assert manager.count_for(USER, kind="agent") == 0
    assert manager.count_for(USER, kind="shell") == 1
    assert manager.count_for("user_2", kind="agent") == 1

    # Idempotent: a second restart finds nothing.
    assert client.post("/internal/terminal/restart", headers=HEADERS).json() == {"stopped": 0}
