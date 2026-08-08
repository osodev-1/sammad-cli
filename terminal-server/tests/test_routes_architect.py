"""Architect bridge: start redeems a ticket + spawns the wire subprocess; ask
streams one turn (events + drafted plan) as NDJSON. Uses a fake wire agent —
no LLM — so it exercises the JSON-RPC framing, not a model."""

import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

SECRET = "s3cret"
USER = "user_1"
HEADERS = {"x-terminal-secret": SECRET, "x-workspace-user": USER}
FAKE_WIRE = Path(__file__).parent / "_fake_architect_wire.py"

IDENTITY = {
    "sessionToken": "sess_abc",
    "userId": USER,
    "orgId": "personal_user_1",
    "email": "a@b.test",
    "displayName": "A",
}


def _control_plane(tickets: dict[str, dict]) -> ControlPlaneClient:
    def handler(request: httpx.Request) -> httpx.Response:
        ticket = str(json.loads(request.content)["ticket"])
        if ticket not in tickets:
            return httpx.Response(
                404, json={"error": {"code": "not_found", "message": "nope", "requestId": "r"}}
            )
        return httpx.Response(200, json={"data": tickets[ticket], "meta": {"requestId": "r"}})

    return ControlPlaneClient("https://cp.test", SECRET, transport=httpx.MockTransport(handler))


@pytest.fixture
def client(tmp_path: Path):
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
    )
    app = create_app(settings, _control_plane({"tt_good": IDENTITY}))
    with TestClient(app) as c:
        yield c


def _lines(text: str) -> list[dict]:
    return [json.loads(ln) for ln in text.splitlines() if ln.strip()]


def test_start_requires_credentials(client: TestClient):
    assert client.post("/internal/architect/start", json={"ticket": "tt_good"}).status_code == 401


def test_start_rejects_bad_ticket(client: TestClient):
    res = client.post("/internal/architect/start", headers=HEADERS, json={"ticket": "tt_nope"})
    assert res.status_code == 401


def test_ask_before_start_is_409(client: TestClient):
    res = client.post("/internal/architect/ask", headers=HEADERS, json={"input": "hi"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_start_is_idempotent(client: TestClient):
    first = client.post("/internal/architect/start", headers=HEADERS, json={"ticket": "tt_good"})
    assert first.status_code == 200, first.text
    assert first.json() == {"ok": True, "started": True}
    # A second start finds the runner already alive (no new ticket redeemed).
    second = client.post("/internal/architect/start", headers=HEADERS, json={"ticket": "tt_x"})
    assert second.status_code == 200
    assert second.json() == {"ok": True, "started": False}


def test_ask_streams_a_turn_with_a_drafted_plan(client: TestClient):
    assert (
        client.post(
            "/internal/architect/start", headers=HEADERS, json={"ticket": "tt_good"}
        ).status_code
        == 200
    )

    res = client.post(
        "/internal/architect/ask", headers=HEADERS, json={"input": "add a review skill"}
    )
    assert res.status_code == 200
    items = _lines(res.text)

    kinds = [i["kind"] for i in items]
    assert kinds[-1] == "end"
    assert items[-1]["status"] == "finished"

    # The turn carried the architect's text and a drafted plan (extras.blueprintPlan).
    types = [i["event"]["type"] for i in items if i["kind"] == "event"]
    assert "TurnBegin" in types and "TextPart" in types and "ToolResult" in types
    tool_results = [
        i["event"]["payload"]
        for i in items
        if i["kind"] == "event" and i["event"].get("type") == "ToolResult"
    ]
    plan = tool_results[0]["return_value"]["extras"]["blueprintPlan"]
    assert plan["graphDelta"]["nodesAdded"] == ["skill:review"]


def test_cancel_is_safe_without_a_turn(client: TestClient):
    client.post("/internal/architect/start", headers=HEADERS, json={"ticket": "tt_good"})
    res = client.post("/internal/architect/cancel", headers=HEADERS)
    assert res.status_code == 200 and res.json() == {"ok": True}


def test_ask_requires_credentials(client: TestClient):
    assert client.post("/internal/architect/ask", json={"input": "hi"}).status_code == 401


async def test_runner_serves_multiple_turns_then_stops(tmp_path: Path):
    """The runner reuses one subprocess across turns and shuts it down cleanly."""
    from sanad_terminal.architect_runner import ArchitectRunner

    runner = ArchitectRunner(
        argv=[sys.executable, str(FAKE_WIRE)],
        cwd=tmp_path,
        env={"PATH": os.environ.get("PATH", "")},
    )
    await runner.start()
    try:
        for _ in range(2):
            items = [item async for item in runner.ask("hello")]
            assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"
            assert not runner.busy  # the turn released the lock
    finally:
        await runner.stop()
    assert not runner.alive
