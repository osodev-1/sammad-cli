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
from sanad_terminal import coder_runner
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


def _make_client(
    tmp_path: Path, *, enabled: bool, coder_max_queue_depth: int = 50
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
