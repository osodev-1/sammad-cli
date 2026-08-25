"""Coder bridge: flag-gated conversation lifecycle, NDJSON turn streaming,
and the approval round-trip (request → respond → resolution) through the
HTTP surface."""

import json
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
from sanad_terminal import coder_runner, routes_blueprint
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from sanad_terminal.workspace_locks import lock_for
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


def _make_client(
    tmp_path: Path,
    *,
    enabled: bool,
    coder_max_queue_depth: int = 50,
    coder_diff_max_bytes: int = 200_000,
) -> TestClient:
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
        coder_enabled=enabled,
        coder_max_turn_seconds=3600.0,
        coder_max_steps_per_turn=200,
        coder_max_conversations=2,
        coder_max_queue_depth=coder_max_queue_depth,
        coder_diff_max_bytes=coder_diff_max_bytes,
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
        res = c.post("/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"})
        assert res.status_code == 404
        assert res.json()["error"]["code"] == "coder_disabled"
        assert c.get("/internal/coder/conversations", headers=HEADERS).status_code == 404


def test_create_requires_credentials(client: TestClient):
    assert (
        client.post("/internal/coder/conversations", json={"ticket": "tt_good"}).status_code == 401
    )


def test_create_rejects_bad_ticket(client: TestClient):
    res = client.post("/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_nope"})
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
        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
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
    turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
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
        client.post(f"/internal/coder/conversations/{cid}/stop", headers=HEADERS).status_code == 200
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
    res = client.post("/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "conversation_limit"


def test_create_seeds_default_mode(client: TestClient):
    """CREATE (not open) seeds `default` posture right after start() — visible
    on /turn without sending anything."""
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
    assert turn["mode"] == "default"


def test_turn_carries_mode_field_when_no_runner(client: TestClient):
    turn = client.get(
        "/internal/coder/conversations/c_000000000000/turn", headers=HEADERS
    ).json()
    assert turn["mode"] is None


def test_mode_route_happy_path(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/mode",
        headers=HEADERS,
        json={"mode": "accept-edits"},
    )
    assert res.status_code == 200
    assert res.json() == {"ok": True, "mode": "accept-edits"}
    turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
    assert turn["mode"] == "accept-edits"


def test_mode_route_rejects_yolo(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/mode", headers=HEADERS, json={"mode": "yolo"}
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_mode"


def test_mode_route_unknown_cid_is_not_started(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/c_000000000000/mode",
        headers=HEADERS,
        json={"mode": "default"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_mode_route_malformed_cid_is_400(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/..%2Fetc/mode", headers=HEADERS, json={"mode": "default"}
    )
    assert res.status_code in (400, 404)


def test_steer_while_turn_runs_returns_ok_and_follow_shows_steer_input(client: TestClient):
    """The steer route while a STEERABLE turn is streaming: 200 {"ok": true}
    immediately, and a subsequent /follow of that same turn carries the
    SteerInput event followed by a normal finish — no new turn started."""
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    # "STEERABLE" keeps the turn open (like HANG) until a steer arrives —
    # /send blocks until the turn ends, so drive it from a thread (same
    # trick test_interrupted_replay_does_not_drop_the_runner uses for HANG).
    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "STEERABLE"}},
        daemon=True,
    )
    send_thread.start()
    try:
        turn_id = None
        for _ in range(200):
            turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
            if turn.get("turn") and turn["turn"]["status"] == "running":
                turn_id = turn["turn"]["turnId"]
                break
            time.sleep(0.02)
        assert turn_id is not None, "turn never went running"

        res = client.post(
            f"/internal/coder/conversations/{cid}/steer",
            headers=HEADERS,
            json={"input": "go left"},
        )
        assert res.status_code == 200
        assert res.json() == {"ok": True}
    finally:
        send_thread.join(timeout=10)
    assert not send_thread.is_alive()

    replay = client.get(
        f"/internal/coder/conversations/{cid}/follow",
        headers=HEADERS,
        params={"turnId": turn_id, "from_seq": 0},
    )
    assert replay.status_code == 200
    items = _lines(replay.text)
    steer_inputs = [
        i["event"]["payload"]["user_input"]
        for i in items
        if i.get("kind") == "event" and i["event"].get("type") == "SteerInput"
    ]
    assert steer_inputs == ["go left"]
    assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"


def test_steer_with_no_live_turn_is_409(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/steer",
        headers=HEADERS,
        json={"input": "go left"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "no_turn"


def test_steer_unknown_conversation_is_409(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/c_000000000000/steer",
        headers=HEADERS,
        json={"input": "go left"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "no_turn"


def test_steer_malformed_cid_is_400(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/..%2Fetc/steer", headers=HEADERS, json={"input": "x"}
    )
    assert res.status_code in (400, 404)


# -- P4b: server-side per-conversation queue ---------------------------------


def _wait_for_running_turn(client: TestClient, cid: str) -> str:
    for _ in range(200):
        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        if turn.get("turn") and turn["turn"]["status"] == "running":
            return turn["turn"]["turnId"]
        time.sleep(0.02)
    pytest.fail("turn never went running")


def test_send_while_busy_auto_queues_and_drains_on_turn_end(client: TestClient):
    """A busy /send no longer 409s — it auto-queues (202) and /turn shows the
    queued item; once the running turn ends, the queue drains automatically
    (no client action needed) and the queued input becomes a real new turn."""
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "HANG", "sendId": "s1"}},
        daemon=True,
    )
    send_thread.start()
    try:
        turn_id = _wait_for_running_turn(client, cid)

        queued = client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "queued follow-up", "sendId": "s2"},
        )
        assert queued.status_code == 202
        assert queued.json() == {"ok": True, "queued": True, "position": 1}

        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        assert turn["queue"] == [{"sendId": "s2", "input": "queued follow-up"}]

        cancel_res = client.post(f"/internal/coder/conversations/{cid}/cancel", headers=HEADERS)
        assert cancel_res.status_code == 200
    finally:
        send_thread.join(timeout=10)
    assert not send_thread.is_alive()

    new_turn = None
    for _ in range(200):
        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        if turn.get("turn") and turn["turn"]["turnId"] != turn_id:
            new_turn = turn
            break
        time.sleep(0.02)
    assert new_turn is not None, "queue never drained into a new turn"
    assert new_turn["turn"]["userInput"] == "queued follow-up"
    assert new_turn["queue"] == []


def test_send_with_queue_true_on_idle_runner_drains_promptly(client: TestClient):
    """`queue:true` on an otherwise-idle runner must still run promptly —
    nothing will ever end a turn to trigger the usual drain-on-turn-end
    hook, so `/send` itself kicks the drain off directly."""
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "hello", "sendId": "q1", "queue": True},
    )
    assert res.status_code == 202
    assert res.json() == {"ok": True, "queued": True, "position": 1}

    turn = None
    for _ in range(200):
        candidate = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        if candidate.get("turn") is not None:
            turn = candidate
            break
        time.sleep(0.02)
    assert turn is not None, "queued send on an idle runner never drained"
    assert turn["turn"]["userInput"] == "hello"
    assert turn["queue"] == []


def test_send_enqueue_is_idempotent_on_send_id_over_http(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "HANG", "sendId": "s1"}},
        daemon=True,
    )
    send_thread.start()
    try:
        _wait_for_running_turn(client, cid)

        first = client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "dup", "sendId": "q1", "queue": True},
        )
        second = client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "dup again", "sendId": "q1", "queue": True},
        )
        assert first.status_code == 202 and first.json()["position"] == 1
        assert second.status_code == 202 and second.json()["position"] == 1

        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        assert turn["queue"] == [{"sendId": "q1", "input": "dup"}]

        client.post(f"/internal/coder/conversations/{cid}/cancel", headers=HEADERS)
    finally:
        send_thread.join(timeout=10)
    assert not send_thread.is_alive()


def test_dequeue_removes_a_queued_item(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "HANG", "sendId": "s1"}},
        daemon=True,
    )
    send_thread.start()
    try:
        _wait_for_running_turn(client, cid)

        queued = client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "x", "sendId": "q1", "queue": True},
        )
        assert queued.status_code == 202

        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        assert turn["queue"] == [{"sendId": "q1", "input": "x"}]

        deleted = client.delete(f"/internal/coder/conversations/{cid}/queue/q1", headers=HEADERS)
        assert deleted.status_code == 200
        assert deleted.json() == {"ok": True, "removed": True}

        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        assert turn["queue"] == []

        again = client.delete(f"/internal/coder/conversations/{cid}/queue/q1", headers=HEADERS)
        assert again.status_code == 200
        assert again.json() == {"ok": True, "removed": False}

        client.post(f"/internal/coder/conversations/{cid}/cancel", headers=HEADERS)
    finally:
        send_thread.join(timeout=10)
    assert not send_thread.is_alive()


def test_dequeue_missing_runner_is_409(client: TestClient):
    res = client.delete("/internal/coder/conversations/c_000000000000/queue/q1", headers=HEADERS)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_dequeue_malformed_cid_is_400(client: TestClient):
    res = client.delete("/internal/coder/conversations/..%2Fetc/queue/q1", headers=HEADERS)
    assert res.status_code in (400, 404)


def test_turn_exposes_queue_field(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
    assert turn["queue"] == []


def test_turn_carries_queue_field_when_no_runner(client: TestClient):
    turn = client.get(
        "/internal/coder/conversations/c_000000000000/turn", headers=HEADERS
    ).json()
    assert turn["queue"] == []


def test_send_queue_true_past_the_cap_is_409_and_does_not_grow_the_queue(tmp_path: Path):
    """Important C, HTTP layer: `/send {queue:true}` past
    `coder_max_queue_depth` must 409 with `queue_full` — not silently accept
    an unbounded number of RAM-only queue entries — and the server queue
    must stay at the cap, not grow past it."""
    with _make_client(tmp_path, enabled=True, coder_max_queue_depth=2) as client:
        cid = client.post(
            "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
        ).json()["conversationId"]

        send_thread = threading.Thread(
            target=client.post,
            args=(f"/internal/coder/conversations/{cid}/send",),
            kwargs={"headers": HEADERS, "json": {"input": "HANG", "sendId": "s1"}},
            daemon=True,
        )
        send_thread.start()
        try:
            _wait_for_running_turn(client, cid)

            first = client.post(
                f"/internal/coder/conversations/{cid}/send",
                headers=HEADERS,
                json={"input": "one", "sendId": "q1", "queue": True},
            )
            second = client.post(
                f"/internal/coder/conversations/{cid}/send",
                headers=HEADERS,
                json={"input": "two", "sendId": "q2", "queue": True},
            )
            assert first.status_code == 202 and second.status_code == 202

            third = client.post(
                f"/internal/coder/conversations/{cid}/send",
                headers=HEADERS,
                json={"input": "three", "sendId": "q3", "queue": True},
            )
            assert third.status_code == 409
            assert third.json()["error"]["code"] == "queue_full"

            turn = client.get(
                f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
            ).json()
            assert turn["queue"] == [
                {"sendId": "q1", "input": "one"},
                {"sendId": "q2", "input": "two"},
            ]

            client.post(f"/internal/coder/conversations/{cid}/cancel", headers=HEADERS)
        finally:
            send_thread.join(timeout=10)
        assert not send_thread.is_alive()


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
        client.post(f"/internal/coder/conversations/{stopped}/stop", headers=HEADERS).status_code
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


# -- P3 Task 3: durable journal end-to-end through /open ---------------------
#
# `_spawn` now threads `journal_dir=root.parent/"agentd"/"coder"/cid` into
# every `CoderRunner` it constructs (`/create` and `/open` alike). `/create`
# always mints a fresh cid, so its journal starts empty (no reconstruction to
# do); `/open` on an EXISTING cid whose runner already died is the
# reconstruction path this section proves end-to-end over real HTTP + a real
# on-disk journal (the `tmp_path`-backed `users_dir` from the `client`
# fixture already IS a real writable directory — no extra wiring needed).


def _root_for(tmp_path: Path) -> Path:
    """The same workspace root `workspace_root()` derives server-side for
    `USER`, computed the same way (`users_dir/<user>/workspace`) so
    `coder_runner._key(root, cid)` matches the registry key `_spawn` uses."""
    return tmp_path / "users" / USER / "workspace"


def test_open_reconstructs_a_finished_turn_after_a_drop(client: TestClient, tmp_path: Path):
    """The ordinary case: a turn that finished normally must survive a
    drop + reopen (a graceful `stop()` never touches an already-terminal
    turn — see the crash test below for the turn genuinely mid-flight)."""
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

    assert (
        client.post(f"/internal/coder/conversations/{cid}/stop", headers=HEADERS).status_code
        == 200
    )
    reopened = client.post(
        f"/internal/coder/conversations/{cid}/open", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json() == {"ok": True, "started": True}

    replay = client.get(
        f"/internal/coder/conversations/{cid}/follow",
        headers=HEADERS,
        params={"turnId": turn_id, "from_seq": 0},
    )
    assert replay.status_code == 200
    assert _lines(replay.text) == first


def test_open_reconstructs_after_a_crash_with_a_pending_approval(
    client: TestClient, tmp_path: Path
):
    """The restart-recovery deliverable: a turn crashes mid-flight with an
    unresolved approval request, and `/open` brings it back as a durably
    "interrupted" turn whose pending request was cancelled, not lost.

    Driving a genuinely pending, never-resolved request across a simulated
    process restart needs two deliberate departures from the obvious HTTP
    idioms already in this file, both load-bearing:

    1. Getting the turn "stuck" pending at all requires the same
       background-thread trick `test_approval_round_trip_over_http` uses
       (`/send` blocks until the turn ends) — except here nothing ever
       resolves it, so the thread's call would block forever. That's fine
       *during* the test (the turn keeps running server-side with zero
       followers — see `_consume`'s docstring), but it means the request
       must be explicitly un-stuck before the test function returns: the
       `with TestClient(...)` context's teardown drains the app's ASGI
       lifespan through the SAME event-loop portal that thread's `/send`
       call is still in flight on, and it hangs forever waiting for that
       call to finish. The fix is `client.portal.call(crashed.stop)` at
       the end — `crashed`'s asyncio primitives (Queue/Condition/the
       subprocess transport) are bound to the portal's loop, so a
       plain `asyncio.run(crashed.stop())` from this thread would raise
       ("Future attached to a different loop") instead of working.

    2. The crash itself CANNOT be `drop_conversation(root, cid)` (which the
       plan text names as the obvious choice) — that calls `runner.stop()`,
       which *gracefully* resolves any pending request (journaled as
       `request_cancelled reason=turn_ended`) and marks the turn "failed"
       BEFORE the runner ever leaves the registry. That is a materially
       different, and already-tested, code path from restart reconciliation
       (`interrupted` / `interrupted_by_restart`, `CoderRunner.
       _reconcile_interrupted_turn`), which only fires when a FRESH runner
       is constructed over a journal whose last-written status is still
       "running" — i.e. when the whole process died with no chance to run
       any cleanup at all, not when it shut down in an orderly way. So the
       crash here is simulated by reaching into the registry directly
       (`coder_runner._conversations`) and popping the live runner out
       WITHOUT calling `.stop()` — freezing the on-disk journal exactly
       where the last real write left it, the same way a SIGKILL/host
       reboot would. (Verified empirically before writing this test:
       `drop_conversation` leaves status "failed" + reason "turn_ended" on
       disk, never "interrupted"/"interrupted_by_restart".)
    """
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "ASK_APPROVAL"}},
        daemon=True,
    )
    send_thread.start()
    crashed = None
    try:
        turn_id = None
        for _ in range(200):
            turn = client.get(
                f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
            ).json()
            pending = turn.get("pendingRequests") or []
            if pending:
                turn_id = turn["turn"]["turnId"]
                break
            time.sleep(0.02)
        assert turn_id is not None, "approval request never went pending"

        # The crash: rip the live runner out of the registry with no graceful
        # cleanup — see docstring point 2 above for why this (and not
        # `drop_conversation`) is the correct simulation.
        key = coder_runner._key(root, cid)
        crashed = coder_runner._conversations.pop(key, None)
        assert crashed is not None, "runner was not registered under the expected key"

        # The on-disk journal is frozen mid-turn: status "running", the
        # request item written but never resolved.
        index_path = root.parent / "agentd" / "coder" / cid / "turns.json"
        frozen_index = json.loads(index_path.read_text())
        assert frozen_index[0]["turnId"] == turn_id
        assert frozen_index[0]["status"] == "running"

        # The "restart": /open spawns a brand new runner over the same
        # journal_dir, which reconstructs + reconciles on construction
        # (Task 2).
        reopened = client.post(
            f"/internal/coder/conversations/{cid}/open",
            headers=HEADERS,
            json={"ticket": "tt_good"},
        )
        assert reopened.status_code == 200, reopened.text
        assert reopened.json() == {"ok": True, "started": True}

        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        assert turn["turn"]["turnId"] == turn_id
        assert turn["turn"]["status"] == "interrupted"
        assert turn["pendingRequests"] == []
        assert turn["mode"] is not None

        # Bounded read: a regression that made `follow()` hang on a turn
        # that's already terminal in memory must fail this test, not hang
        # the suite.
        follow_result: dict = {}

        def _do_follow() -> None:
            follow_result["res"] = client.get(
                f"/internal/coder/conversations/{cid}/follow",
                headers=HEADERS,
                params={"turnId": turn_id, "from_seq": 0},
            )

        follow_thread = threading.Thread(target=_do_follow, daemon=True)
        follow_thread.start()
        follow_thread.join(timeout=10)
        assert not follow_thread.is_alive(), "follow() hung instead of closing"

        replay = follow_result["res"]
        assert replay.status_code == 200
        items = _lines(replay.text)
        kinds = [i["kind"] for i in items]
        assert "request_cancelled" in kinds
        cancelled = next(i for i in items if i["kind"] == "request_cancelled")
        assert cancelled["reason"] == "interrupted_by_restart"
        assert items[-1]["kind"] == "end" and items[-1]["status"] == "interrupted"
    finally:
        # Cleanup: unwedge the abandoned /send thread (see docstring point
        # 1) so the `client` fixture's teardown never hangs — even if an
        # assertion above failed, this MUST still run, or a single failing
        # run of this test would hang the entire suite.
        if crashed is not None:
            assert client.portal is not None  # set for the life of `with TestClient(...)`
            client.portal.call(crashed.stop)
        send_thread.join(timeout=5)
    assert not send_thread.is_alive()


def test_interrupted_replay_does_not_drop_the_runner(client: TestClient, tmp_path: Path):
    """Review-finding regression guard (P3 Task 4 Fix A): `_recycling_stream`
    used to treat ANY `end.status` other than "finished"/"cancelled" as a
    failed turn and drop the runner — including "interrupted", even though
    a reconstructed runner is a freshly-`start()`ed one with freshly
    redeemed auth (see `_recycling_stream`'s docstring — the point of
    dropping on failure is a zombie whose LLM calls 401; a just-reconciled
    runner is the opposite of that).

    Dropping it meant the very `/follow` call that surfaces an interrupted
    turn to the client also killed the runner out from under it: the next
    `/send` 409'd "not_started", forcing a re-`/open` — and on the
    frontend, the self-heal path for that 409 called `begin()` again
    mid-turn, which re-replayed the SAME interrupted turn a second time (a
    duplicate message in the transcript, or worse — the flicker on a
    send-after-recovery race). This proves the fix directly at the HTTP
    layer: after reconstruction + `/follow`ing the interrupted turn to
    completion, a plain `/send` succeeds immediately — no 409, no re-`/open`
    needed."""
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    # "HANG" keeps the turn open indefinitely (until a cancel) — simplest
    # way to get a turn genuinely stuck "running", no approval bridging
    # needed (see _fake_coder_wire.py's docstring).
    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "HANG"}},
        daemon=True,
    )
    send_thread.start()
    crashed = None
    try:
        turn_id = None
        for _ in range(200):
            turn = client.get(
                f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
            ).json()
            if turn.get("turn") and turn["turn"]["status"] == "running":
                turn_id = turn["turn"]["turnId"]
                break
            time.sleep(0.02)
        assert turn_id is not None, "turn never went running"

        # The crash — same simulation as
        # test_open_reconstructs_after_a_crash_with_a_pending_approval (see
        # its docstring point 2 for why `drop_conversation` would NOT be a
        # faithful stand-in for a SIGKILL/host-reboot here).
        key = coder_runner._key(root, cid)
        crashed = coder_runner._conversations.pop(key, None)
        assert crashed is not None, "runner was not registered under the expected key"

        reopened = client.post(
            f"/internal/coder/conversations/{cid}/open",
            headers=HEADERS,
            json={"ticket": "tt_good"},
        )
        assert reopened.status_code == 200, reopened.text

        turn = client.get(f"/internal/coder/conversations/{cid}/turn", headers=HEADERS).json()
        assert turn["turn"]["turnId"] == turn_id
        assert turn["turn"]["status"] == "interrupted"

        replay = client.get(
            f"/internal/coder/conversations/{cid}/follow",
            headers=HEADERS,
            params={"turnId": turn_id, "from_seq": 0},
        )
        assert replay.status_code == 200
        replay_items = _lines(replay.text)
        assert replay_items[-1]["kind"] == "end"
        assert replay_items[-1]["status"] == "interrupted"

        # THE FIX under test: the runner must still be live and registered
        # under `cid` — a plain /send right after the interrupted replay
        # succeeds directly, with no 409 and no re-/open in between.
        again = client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "hello", "sendId": "m2"},
        )
        assert again.status_code == 200, again.text
        again_items = _lines(again.text)
        assert again_items[-1]["kind"] == "end"
        assert again_items[-1]["status"] == "finished"
    finally:
        if crashed is not None:
            assert client.portal is not None
            client.portal.call(crashed.stop)
        send_thread.join(timeout=5)
    assert not send_thread.is_alive()


# -- P5 Task 3: /diff + /revert over real git checkpoints --------------------
#
# Mirrors test_coder_checkpoints.py's construction style (real git, via
# subprocess, never mocked) but drives it entirely over HTTP: `/diff` and
# `/revert` read/act on the durable checkpoint SHAs Task 2 wrote into
# `turns.json`, so the proof has to be end-to-end through the routes, not
# just the runner.

_needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")


def _git(root: Path, *args: str) -> str:
    res = subprocess.run(
        ["git", "-C", str(root), *args], check=True, capture_output=True, text=True
    )
    return res.stdout


def _seed_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.name", "Test User")
    _git(root, "config", "user.email", "test@example.com")
    (root / "seed.txt").write_text("seed\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "seed")


def _checkpoint_refs(root: Path, cid: str) -> set[str]:
    res = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "for-each-ref",
            "--format=%(refname)",
            f"refs/sanad/checkpoints/{cid}/",
        ],
        capture_output=True,
        text=True,
    )
    return {line.strip() for line in res.stdout.splitlines() if line.strip()}


def _load_turns_index(root: Path, cid: str) -> list[dict]:
    return json.loads((root.parent / "agentd" / "coder" / cid / "turns.json").read_text())


def _entry_for(index: list[dict], turn_id: str) -> dict:
    return next(e for e in index if e["turnId"] == turn_id)


@_needs_git
def test_diff_finished_turn_returns_pre_to_post(client: TestClient, tmp_path: Path):
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:new.txt:hello\n", "sendId": "m1"},
    )
    assert res.status_code == 200, res.text
    turn_id = _lines(res.text)[0]["turnId"]

    diff_res = client.get(
        f"/internal/coder/conversations/{cid}/diff",
        headers=HEADERS,
        params={"turnId": turn_id},
    )
    assert diff_res.status_code == 200, diff_res.text
    body = diff_res.json()
    assert body["nameStatus"] == [{"status": "A", "path": "new.txt"}]
    assert "hello" in body["patch"]
    assert body["truncated"] is False
    assert body["filesChanged"] == 1
    assert body["additions"] == 1
    assert body["deletions"] == 0


@_needs_git
def test_diff_running_turn_returns_pre_to_worktree(client: TestClient, tmp_path: Path):
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "HANG"}},
        daemon=True,
    )
    send_thread.start()
    try:
        turn_id = _wait_for_running_turn(client, cid)

        # Simulate mid-turn work: a file appears in the tree while the turn
        # is still open — checkpointPost stays null until it ends, so /diff
        # must fall back to pre..worktree, not pre..(nothing).
        (root / "wip.txt").write_text("work in progress\n")

        diff_res = client.get(
            f"/internal/coder/conversations/{cid}/diff",
            headers=HEADERS,
            params={"turnId": turn_id},
        )
        assert diff_res.status_code == 200, diff_res.text
        body = diff_res.json()
        assert body["nameStatus"] == [{"status": "A", "path": "wip.txt"}]

        cancel_res = client.post(f"/internal/coder/conversations/{cid}/cancel", headers=HEADERS)
        assert cancel_res.status_code == 200
    finally:
        send_thread.join(timeout=10)
    assert not send_thread.is_alive()


@_needs_git
def test_diff_finished_clean_turn_returns_zero_not_pre_worktree(client: TestClient, tmp_path: Path):
    """Final-review fix: a FINISHED turn with a null `checkpointPost` (its
    own post was skipped as clean — a genuine no-op turn, mirrors
    test_coder_checkpoints.test_non_mutating_turn_records_pre_but_null_post)
    must diff as zero, not fall back to `pre..worktree` like a still-running
    turn does. Proven end to end: turn 1 is clean (finishes with a null
    post), turn 2 afterwards DOES mutate the tree — without the fix, turn
    1's `pre..worktree` would pick up turn 2's file too, contradicting turn
    1's own "0 files changed" footer."""
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    clean_res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "hello", "sendId": "m1"},  # default mode: no file writes
    )
    assert clean_res.status_code == 200, clean_res.text
    clean_turn_id = _lines(clean_res.text)[0]["turnId"]

    index = _load_turns_index(root, cid)
    clean_entry = _entry_for(index, clean_turn_id)
    assert clean_entry["status"] == "finished"
    assert clean_entry["checkpointPre"] is not None
    assert clean_entry["checkpointPost"] is None

    # A LATER turn really does mutate the tree — this is what pre..worktree
    # would leak into turn 1's diff without the fix.
    mutate_res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:later.txt:from turn two\n", "sendId": "m2"},
    )
    assert mutate_res.status_code == 200, mutate_res.text

    diff_res = client.get(
        f"/internal/coder/conversations/{cid}/diff",
        headers=HEADERS,
        params={"turnId": clean_turn_id},
    )
    assert diff_res.status_code == 200, diff_res.text
    body = diff_res.json()
    assert body == {
        "nameStatus": [],
        "patch": "",
        "truncated": False,
        "filesChanged": 0,
        "additions": 0,
        "deletions": 0,
    }


def test_diff_returns_404_when_turn_never_checkpointed(client: TestClient):
    # No _seed_repo: the workspace dir exists but is not a git repo, so the
    # best-effort pre-checkpoint silently stays null (mirrors
    # test_coder_checkpoints.test_checkpoint_creation_failure_does_not_fail_the_turn).
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "hello", "sendId": "m1"},
    )
    assert res.status_code == 200, res.text
    turn_id = _lines(res.text)[0]["turnId"]

    diff_res = client.get(
        f"/internal/coder/conversations/{cid}/diff",
        headers=HEADERS,
        params={"turnId": turn_id},
    )
    assert diff_res.status_code == 404
    assert diff_res.json()["error"]["code"] == "no_checkpoint"


def test_diff_unknown_turn_is_404(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    diff_res = client.get(
        f"/internal/coder/conversations/{cid}/diff",
        headers=HEADERS,
        params={"turnId": "t_000000000000"},
    )
    assert diff_res.status_code == 404
    assert diff_res.json()["error"]["code"] == "no_checkpoint"


def test_diff_malformed_cid_is_400(client: TestClient):
    res = client.get(
        "/internal/coder/conversations/..%2Fetc/diff",
        headers=HEADERS,
        params={"turnId": "t_000000000000"},
    )
    assert res.status_code in (400, 404)


@_needs_git
def test_diff_respects_coder_diff_max_bytes(tmp_path: Path):
    with _make_client(tmp_path, enabled=True, coder_diff_max_bytes=40) as diff_client:
        root = _root_for(tmp_path)
        cid = diff_client.post(
            "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
        ).json()["conversationId"]
        _seed_repo(root)

        big_content = "x" * 500 + "\n"
        res = diff_client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": f"WRITEFILE:big.txt:{big_content}", "sendId": "m1"},
        )
        assert res.status_code == 200, res.text
        turn_id = _lines(res.text)[0]["turnId"]

        diff_res = diff_client.get(
            f"/internal/coder/conversations/{cid}/diff",
            headers=HEADERS,
            params={"turnId": turn_id},
        )
        assert diff_res.status_code == 200, diff_res.text
        body = diff_res.json()
        assert body["truncated"] is True
        assert len(body["patch"].encode("utf-8")) <= 40
        # Counts come from the UN-truncated numstat — a correct summary even
        # though the patch text itself is cut (settings.coder_diff_max_bytes
        # bounds the patch only, never the counts).
        assert body["filesChanged"] == 1
        assert body["additions"] == 1


@_needs_git
def test_revert_refuses_409_when_another_conversation_in_the_workspace_is_busy(
    client: TestClient, tmp_path: Path
):
    """Whole-workspace, cross-conversation: there is no write-lease until P6,
    so a revert on an IDLE conversation must still refuse while a DIFFERENT
    conversation in the same workspace has a turn running."""
    root = _root_for(tmp_path)
    cid1 = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    finished = client.post(
        f"/internal/coder/conversations/{cid1}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:a.txt:one\n", "sendId": "m1"},
    )
    assert finished.status_code == 200, finished.text
    turn1_id = _lines(finished.text)[0]["turnId"]

    cid2 = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]

    send_thread = threading.Thread(
        target=client.post,
        args=(f"/internal/coder/conversations/{cid2}/send",),
        kwargs={"headers": HEADERS, "json": {"input": "HANG"}},
        daemon=True,
    )
    send_thread.start()
    try:
        _wait_for_running_turn(client, cid2)

        revert_res = client.post(
            f"/internal/coder/conversations/{cid1}/revert",
            headers=HEADERS,
            json={"turnId": turn1_id},
        )
        assert revert_res.status_code == 409
        assert revert_res.json()["error"]["code"] == "workspace_busy"

        cancel_res = client.post(f"/internal/coder/conversations/{cid2}/cancel", headers=HEADERS)
        assert cancel_res.status_code == 200
    finally:
        send_thread.join(timeout=10)
    assert not send_thread.is_alive()


@_needs_git
def test_revert_restores_worktree_and_records_safety_and_marker(
    client: TestClient, tmp_path: Path
):
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    turn1 = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:a.txt:one\n", "sendId": "m1"},
    )
    assert turn1.status_code == 200, turn1.text
    turn1_id = _lines(turn1.text)[0]["turnId"]

    turn2 = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:b.txt:two\n", "sendId": "m2"},
    )
    assert turn2.status_code == 200, turn2.text

    assert (root / "a.txt").exists()
    assert (root / "b.txt").exists()

    pre1_sha = _entry_for(_load_turns_index(root, cid), turn1_id)["checkpointPre"]
    assert isinstance(pre1_sha, str) and pre1_sha

    revert_res = client.post(
        f"/internal/coder/conversations/{cid}/revert",
        headers=HEADERS,
        json={"turnId": turn1_id},
    )
    assert revert_res.status_code == 200, revert_res.text
    body = revert_res.json()
    assert body["ok"] is True
    assert isinstance(body["safetyCheckpoint"], str) and body["safetyCheckpoint"]
    assert body["reverted"] == {"turnId": turn1_id}
    safety_sha = body["safetyCheckpoint"]

    # The worktree now looks exactly like it did right before turn 1 — both
    # later files are gone, the seed file remains untouched.
    assert not (root / "a.txt").exists()
    assert not (root / "b.txt").exists()
    assert (root / "seed.txt").exists()

    # The safety checkpoint really captured the PRE-REVERT tree (both files
    # still present) — an "undo the undo" net, not a no-op.
    assert _git(root, "show", f"{safety_sha}:a.txt").strip() == "one"
    assert _git(root, "show", f"{safety_sha}:b.txt").strip() == "two"

    refs = _checkpoint_refs(root, cid)
    assert any(f"/{turn1_id}-safety-" in r for r in refs)

    markers_path = root.parent / "agentd" / "coder" / cid / "reverts.ndjson"
    lines = [json.loads(ln) for ln in markers_path.read_text().splitlines() if ln.strip()]
    assert lines == [
        {"kind": "revert", "turnId": turn1_id, "toPre": pre1_sha, "safety": safety_sha}
    ]


def test_revert_returns_404_when_turn_never_checkpointed(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/revert",
        headers=HEADERS,
        json={"turnId": "t_000000000000"},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "no_checkpoint"


def test_revert_malformed_cid_is_400(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/..%2Fetc/revert",
        headers=HEADERS,
        json={"turnId": "t_000000000000"},
    )
    assert res.status_code in (400, 404)


def test_revert_and_blueprint_share_the_same_workspace_lock():
    """Extraction proof (P5 Task 3): both route modules import the exact
    same `lock_for` — a revert and a blueprint apply/rollback/trust review
    on the same root now serialize against each other, not just their own
    kind (see the blocking test below for the behavioral proof)."""
    from sanad_terminal import routes_coder

    assert routes_blueprint.lock_for is lock_for
    assert routes_coder.lock_for is lock_for


@_needs_git
def test_revert_blocks_while_a_blueprint_write_holds_the_shared_lock(
    client: TestClient, tmp_path: Path
):
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    turn = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:a.txt:one\n", "sendId": "m1"},
    )
    assert turn.status_code == 200, turn.text
    turn_id = _lines(turn.text)[0]["turnId"]

    assert client.portal is not None

    async def _acquire() -> None:
        await lock_for(root).acquire()

    async def _release() -> None:
        lock_for(root).release()

    client.portal.call(_acquire)
    revert_thread = None
    try:
        result: dict = {}

        def _do_revert() -> None:
            result["res"] = client.post(
                f"/internal/coder/conversations/{cid}/revert",
                headers=HEADERS,
                json={"turnId": turn_id},
            )

        revert_thread = threading.Thread(target=_do_revert, daemon=True)
        revert_thread.start()
        revert_thread.join(timeout=1.0)
        assert revert_thread.is_alive(), "revert did not wait for the shared lock"
    finally:
        client.portal.call(_release)
    revert_thread.join(timeout=10)
    assert not revert_thread.is_alive()
    assert result["res"].status_code == 200, result["res"].text


@_needs_git
def test_revert_does_not_touch_the_blueprint_trust_store(client: TestClient, tmp_path: Path):
    """The trust store lives OUTSIDE the repo root
    (`<workspace>/../blueprint-trust.json`) — a revert only ever touches the
    git worktree at `root`, so it must leave this file byte-for-byte alone."""
    root = _root_for(tmp_path)
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    _seed_repo(root)

    turn = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "WRITEFILE:a.txt:one\n", "sendId": "m1"},
    )
    assert turn.status_code == 200, turn.text
    turn_id = _lines(turn.text)[0]["turnId"]

    trust_path = root.parent / "blueprint-trust.json"
    trust_path.write_text('{"sentinel": true}\n', encoding="utf-8")

    revert_res = client.post(
        f"/internal/coder/conversations/{cid}/revert",
        headers=HEADERS,
        json={"turnId": turn_id},
    )
    assert revert_res.status_code == 200, revert_res.text
    assert trust_path.read_text(encoding="utf-8") == '{"sentinel": true}\n'
