"""Coder bridge: flag-gated conversation lifecycle, NDJSON turn streaming,
and the approval round-trip (request → respond → resolution) through the
HTTP surface."""

import json
import sys
import threading
import time
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
FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"

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


def _make_client(tmp_path: Path, *, enabled: bool) -> TestClient:
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
        coder_enabled=enabled,
        coder_max_turn_seconds=3600.0,
        coder_max_steps_per_turn=200,
        coder_max_conversations=2,
    )
    app = create_app(settings, _control_plane({"tt_good": IDENTITY}))
    return TestClient(app)


@pytest.fixture
def client(tmp_path: Path):
    with _make_client(tmp_path, enabled=True) as c:
        yield c


def _lines(text: str) -> list[dict]:
    return [json.loads(ln) for ln in text.splitlines() if ln.strip()]


def test_flag_off_hides_every_route(tmp_path: Path):
    with _make_client(tmp_path, enabled=False) as c:
        res = c.post(
            "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
        )
        assert res.status_code == 404
        assert res.json()["error"]["code"] == "coder_disabled"
        assert c.get("/internal/coder/conversations", headers=HEADERS).status_code == 404


def test_create_requires_credentials(client: TestClient):
    assert client.post("/internal/coder/conversations", json={"ticket": "tt_good"}).status_code == 401


def test_create_rejects_bad_ticket(client: TestClient):
    res = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_nope"}
    )
    assert res.status_code == 401


def test_create_send_and_stream_a_turn(client: TestClient):
    created = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert created.status_code == 200, created.text
    cid = created.json()["conversationId"]

    listed = client.get("/internal/coder/conversations", headers=HEADERS).json()
    assert [c["conversationId"] for c in listed["conversations"]] == [cid]

    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "hello"},
    )
    assert res.status_code == 200
    items = _lines(res.text)
    assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"
    types = [i["event"]["type"] for i in items if i["kind"] == "event"]
    assert "TurnBegin" in types and "TextPart" in types


def test_send_to_unknown_conversation_is_409(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/c_000000000000/send",
        headers=HEADERS,
        json={"input": "hi"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_malformed_conversation_id_is_400(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/..%2Fetc/send", headers=HEADERS, json={"input": "x"}
    )
    assert res.status_code in (400, 404)  # 400 from our guard; 404 if routing rejects first


def _respond_when_pending(client, cid: str, body: dict, out: dict):
    """Poll /turn until a pending request appears, then respond."""
    for _ in range(200):
        turn = client.get(
            f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
        ).json()
        pending = turn.get("pendingRequests") or []
        if pending:
            out["pending"] = pending
            out["response"] = client.post(
                f"/internal/coder/conversations/{cid}/respond",
                headers=HEADERS,
                json={"requestId": pending[0]["requestId"], **body},
            )
            return
        time.sleep(0.02)
    out["response"] = None


def test_approval_round_trip_over_http(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    out: dict = {}
    t = threading.Thread(
        target=_respond_when_pending, args=(client, cid, {"response": "approve"}, out)
    )
    t.start()
    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "ASK_APPROVAL"},
    )
    t.join(timeout=10)
    assert res.status_code == 200
    assert out["response"] is not None and out["response"].status_code == 200
    assert out["pending"][0]["requestType"] == "approval"
    items = _lines(res.text)
    kinds = [i.get("kind") for i in items]
    assert "request" in kinds and "request_resolved" in kinds
    outcomes = [
        i["event"]["payload"]["response"]
        for i in items
        if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
    ]
    assert outcomes[0]["result"]["response"] == "approve"
    assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"


def test_respond_unknown_request_is_410(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/respond",
        headers=HEADERS,
        json={"requestId": "req_nope", "response": "approve"},
    )
    assert res.status_code == 410
    assert res.json()["error"]["code"] == "request_gone"


def test_respond_without_runner_is_409(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/c_000000000000/respond",
        headers=HEADERS,
        json={"requestId": "r", "response": "approve"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_turn_exposes_pending_requests_field(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    turn = client.get(
        f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
    ).json()
    assert turn["pendingRequests"] == []


def test_follow_replays_a_finished_turn(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    first = _lines(
        client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "hello", "sendId": "m1"},
        ).text
    )
    turn_id = first[0]["turnId"]
    replay = client.get(
        f"/internal/coder/conversations/{cid}/follow",
        headers=HEADERS,
        params={"turnId": turn_id, "from_seq": 0},
    )
    assert replay.status_code == 200
    assert _lines(replay.text) == first


def test_stop_drops_the_runner(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    assert (
        client.post(
            f"/internal/coder/conversations/{cid}/stop", headers=HEADERS
        ).status_code
        == 200
    )
    res = client.post(
        f"/internal/coder/conversations/{cid}/send", headers=HEADERS, json={"input": "hi"}
    )
    assert res.status_code == 409 and res.json()["error"]["code"] == "not_started"


def test_conversation_cap_is_enforced(client: TestClient):
    for _ in range(2):
        assert (
            client.post(
                "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
            ).status_code
            == 200
        )
    res = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "conversation_limit"


def test_open_existing_id_also_hits_the_cap(client: TestClient):
    """`open` consumes a live-process slot exactly like create (controller ruling, P1a)."""
    cids = [
        client.post(
            "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
        ).json()["conversationId"]
        for _ in range(2)
    ]
    stopped = cids[0]
    assert (
        client.post(
            f"/internal/coder/conversations/{stopped}/stop", headers=HEADERS
        ).status_code
        == 200
    )
    third = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert third.status_code == 200  # slot freed by stop
    reopen = client.post(
        f"/internal/coder/conversations/{stopped}/open",
        headers=HEADERS,
        json={"ticket": "tt_good"},
    )
    assert reopen.status_code == 409
    assert reopen.json()["error"]["code"] == "conversation_limit"
