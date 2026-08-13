"""WireRunner unit tests driven by the fake coder wire — budgets, the
deny-by-default request hook, and the probe registry. No LLM, no FastAPI."""

import asyncio
import sys
from pathlib import Path

import pytest
from sanad_terminal.coder_runner import (
    CONVERSATION_ID_RE,
    CoderRunner,
    drop_conversation,
    get_conversation,
    list_conversations,
    new_conversation_id,
    put_conversation,
    shutdown_conversations,
)
from sanad_terminal.wire_runner import (
    WireRunner,
    WireRunnerError,
)

FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"


def _runner(**kwargs) -> WireRunner:
    return WireRunner(
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=Path.cwd(),
        env={},
        client_name="test-bridge",
        capabilities={"supports_question": False, "supports_plan_mode": False},
        **kwargs,
    )


async def _drain(runner: WireRunner, turn_id: str) -> list[dict]:
    return [item async for item in runner.follow(turn_id, 0)]


@pytest.mark.asyncio
async def test_wall_clock_budget_cancels_a_hung_turn():
    runner = _runner(max_turn_seconds=0.3)
    await runner.start()
    try:
        state = await runner.start_turn("HANG please")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        codes = [i.get("code") for i in items if i.get("kind") == "error"]
        assert "turn_budget_exceeded" in codes
        assert state.status == "cancelled"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_step_budget_cancels_a_looping_turn():
    runner = _runner(max_steps_per_turn=2)
    await runner.start()
    try:
        state = await runner.start_turn("STEPHANG:5")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        codes = [i.get("code") for i in items if i.get("kind") == "error"]
        # Steps 3, 4, and 5 each independently exceed the threshold of 2 —
        # the budget must trip exactly once, not once per offending step.
        assert codes.count("turn_budget_exceeded") == 1
        assert state.status == "cancelled"
        assert state.steps >= 2
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_no_budget_means_unlimited():
    runner = _runner()  # architect posture: both budgets None
    await runner.start()
    try:
        state = await runner.start_turn("STEPHANG:3")
        # Give any (buggy) budget machinery a beat to misfire, then cancel.
        await asyncio.sleep(0.3)
        assert state.status == "running"
        await runner.cancel()
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        assert all(i.get("code") != "turn_budget_exceeded" for i in items)
        assert state.status == "cancelled"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_inbound_request_is_rejected_by_default():
    """P0 posture: no bridge, so every request is refused with -32601 and the
    turn still completes — a gated tool call becomes a denial, never a hang."""
    runner = _runner()
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert len(outcomes) == 1
        assert outcomes[0]["error"]["code"] == -32601
        assert state.status == "finished"
    finally:
        await runner.stop()


def test_conversation_ids_are_minted_and_validated():
    cid = new_conversation_id()
    assert CONVERSATION_ID_RE.fullmatch(cid)
    assert not CONVERSATION_ID_RE.fullmatch("../../etc/passwd")
    assert not CONVERSATION_ID_RE.fullmatch("c_UPPER_NOPE_00")


@pytest.mark.asyncio
async def test_conversation_registry_roundtrip(tmp_path):
    cid = new_conversation_id()
    runner = CoderRunner(
        conversation_id=cid,
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
    )
    assert get_conversation(tmp_path, cid) is None
    put_conversation(tmp_path, runner)
    assert get_conversation(tmp_path, cid) is runner
    assert [r.conversation_id for r in list_conversations(tmp_path)] == [cid]
    await drop_conversation(tmp_path, cid)
    assert get_conversation(tmp_path, cid) is None
    await shutdown_conversations()


def _coder(tmp_path, **kwargs):
    return CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_coder_bridges_approval_requests_into_journal_and_registry(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        # Wait for the request to be journaled (the turn blocks on our answer).
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        pending = runner.pending_summaries()
        assert len(pending) == 1
        p = pending[0]
        assert p["requestType"] == "approval"
        assert p["requestId"] == "req_1"
        assert p["turnId"] == state.turn_id
        assert p["request"]["action"] == "run command"
        kinds = [i.get("kind") for i in state.items]
        assert "request" in kinds
        # Turn is still running — the agent is waiting on us.
        assert state.status == "running"
        await runner.respond("req_1", {"response": "approve"})
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["response"] == "approve"
        assert outcomes[0]["result"]["request_id"] == "req_1"
        assert state.status == "finished"
        assert runner.pending_summaries() == []
        assert any(i.get("kind") == "request_resolved" for i in state.items)
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_coder_bridges_question_requests(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_QUESTION")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        assert runner.pending_summaries()[0]["requestType"] == "question"
        await runner.respond("q_1", {"answers": {"Which approach?": "A"}})
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["answers"] == {"Which approach?": "A"}
        assert state.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_coder_rejects_unknown_request_types(tmp_path):
    """ToolCallRequest (wire-executed tools) is not bridged — reject."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_TOOLCALL")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["error"]["code"] == -32601
        assert runner.pending_summaries() == []
        assert state.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_pending_requests_are_cancelled_on_stop(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        assert runner.pending_summaries()
    finally:
        await runner.stop()
    assert runner.pending_summaries() == []
    assert any(i.get("kind") == "request_cancelled" for i in state.items)


@pytest.mark.asyncio
async def test_pending_requests_survive_subprocess_crash(tmp_path):
    """The bridge registry (`_pending_requests`) must not collide with
    WireRunner's own `_pending` RPC-futures map — if the subprocess dies
    unprompted while a request is pending, `_read_loop`'s finally and
    `WireRunner.stop()` both iterate `self._pending` assuming Futures; a
    name collision would crash them on a `PendingRequest` instead."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        assert runner.pending_summaries()
        assert runner._proc is not None
        runner._proc.kill()
        await asyncio.sleep(0.2)
    finally:
        await runner.stop()
    assert runner.pending_summaries() == []


@pytest.mark.asyncio
async def test_respond_to_unknown_request_is_request_gone(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        with pytest.raises(WireRunnerError) as exc:
            await runner.respond("req_nope", {"response": "approve"})
        assert exc.value.code == "request_gone"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_respond_twice_is_request_gone(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        await runner.respond("req_1", {"response": "reject", "feedback": "not now"})
        with pytest.raises(WireRunnerError) as exc:
            await runner.respond("req_1", {"response": "approve"})
        assert exc.value.code == "request_gone"
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["response"] == "reject"
        assert outcomes[0]["result"]["feedback"] == "not now"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_respond_with_malformed_payload_is_invalid_response(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        with pytest.raises(WireRunnerError) as exc:
            await runner.respond("req_1", {"response": "yolo_no_such_kind"})
        assert exc.value.code == "invalid_response"
        # Still pending — a bad payload must not consume the request.
        assert runner.pending_summaries()
        await runner.respond("req_1", {"response": "approve"})
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_request_with_no_running_turn_is_rejected(tmp_path):
    """Bridged types still reject when no turn is running (background lane = P3/P4)."""
    runner = CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
    )
    await runner.start()
    try:
        handled = await runner.on_request(
            "req_ghost",
            {"type": "ApprovalRequest", "payload": {"id": "req_ghost", "action": "run command"}},
        )
        assert handled is False
        assert runner.pending_summaries() == []
    finally:
        await runner.stop()
