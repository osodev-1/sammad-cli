"""The `/ws` events channel: PTY-less blueprint push on external edits (NF-001)."""

import json
import time
from pathlib import Path

import httpx
import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

IDENTITY = {
    "sessionToken": "sess_abc",
    "userId": "user_1",
    "orgId": "personal_user_1",
    "email": "a@b.test",
    "displayName": "A",
}


def make_settings(tmp_path: Path) -> TerminalSettings:
    return TerminalSettings(
        shared_secret="s3cret",
        users_dir=tmp_path / "users",
        spawn_argv=("/bin/true",),
        child_api_base_url="https://cp.test",
    )


def make_control_plane(tickets: dict[str, dict]) -> ControlPlaneClient:
    def handler(request: httpx.Request) -> httpx.Response:
        ticket = str(json.loads(request.content)["ticket"])
        if ticket not in tickets:
            return httpx.Response(
                404,
                json={"error": {"code": "not_found", "message": "nope", "requestId": "r"}},
            )
        return httpx.Response(200, json={"data": tickets[ticket], "meta": {"requestId": "r"}})

    return ControlPlaneClient("https://cp.test", "s3cret", transport=httpx.MockTransport(handler))


def _auth_events(ticket: str) -> str:
    return json.dumps({"type": "auth", "ticket": ticket, "mode": "events"})


def test_events_channel_pushes_on_external_edit(tmp_path: Path, monkeypatch):
    # Polling makes the watcher deterministic across platforms/CI filesystems.
    monkeypatch.setenv("WATCHFILES_FORCE_POLLING", "true")

    app = create_app(make_settings(tmp_path), make_control_plane({"tt_ev": IDENTITY}))
    sanad = tmp_path / "users" / "user_1" / "workspace" / ".sanad"
    sanad.mkdir(parents=True)  # exist so the watcher arms immediately

    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(_auth_events("tt_ev"))
        first = json.loads(ws.receive()["text"])
        assert first == {"type": "event", "channel": "blueprint", "version": 0}

        # Let the poll watcher take its baseline snapshot before we edit.
        time.sleep(0.6)

        # An external edit under .sanad (as a PTY agent or `git` would make).
        (sanad / "sanad.yaml").write_text(
            "apiVersion: sanad.dev/v1alpha1\nkind: Project\n"
            "metadata:\n  id: project:demo\n  name: Demo\nspec: {}\n"
        )

        nxt = json.loads(ws.receive()["text"])
        assert nxt["type"] == "event"
        assert nxt["channel"] == "blueprint"
        assert nxt["version"] >= 1


def test_events_channel_ignores_cache_writes(tmp_path: Path, monkeypatch):
    """Transaction records under .sanad/.cache must not echo back as changes."""
    monkeypatch.setenv("WATCHFILES_FORCE_POLLING", "true")

    app = create_app(make_settings(tmp_path), make_control_plane({"tt_ev": IDENTITY}))
    sanad = tmp_path / "users" / "user_1" / "workspace" / ".sanad"
    (sanad / ".cache" / "transactions").mkdir(parents=True)

    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(_auth_events("tt_ev"))
        assert json.loads(ws.receive()["text"])["version"] == 0

        time.sleep(0.6)  # baseline snapshot

        # A cache write (what apply persists) is filtered out …
        (sanad / ".cache" / "transactions" / "tx_1.json").write_text("{}")
        # … but a real manifest write still pushes. Whichever event arrives next
        # must be the manifest's (version 1), never the cache write's.
        (sanad / "agent.yaml").write_text("apiVersion: sanad.dev/v1alpha1\nkind: Agent\n")

        nxt = json.loads(ws.receive()["text"])
        assert nxt["version"] == 1


def test_events_channel_answers_ping(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({"tt_ev": IDENTITY}))
    (tmp_path / "users" / "user_1" / "workspace" / ".sanad").mkdir(parents=True)

    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(_auth_events("tt_ev"))
        assert json.loads(ws.receive()["text"])["type"] == "event"  # initial version
        ws.send_text(json.dumps({"type": "ping"}))
        assert json.loads(ws.receive()["text"]) == {"type": "pong"}


def test_events_channel_requires_a_valid_ticket(tmp_path: Path):
    app = create_app(make_settings(tmp_path), make_control_plane({}))
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        ws.send_text(_auth_events("tt_nope"))
        assert json.loads(ws.receive()["text"])["type"] == "error"


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
