"""WireRunner unit tests driven by the fake coder wire — budgets, the
deny-by-default request hook, and the probe registry. No LLM, no FastAPI."""

import asyncio
import sys
from pathlib import Path

import pytest
from sanad_terminal.wire_runner import (
    WireRunner,
    register_registry,
    runners_hold_machine,
)
from sanad_terminal.coder_runner import (
    CONVERSATION_ID_RE,
    CoderRunner,
    get_conversation,
    list_conversations,
    new_conversation_id,
    put_conversation,
    drop_conversation,
    shutdown_conversations,
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


@pytest.mark.asyncio
async def test_coder_runner_speaks_wire_and_denies_requests(tmp_path):
    """The P0 posture end to end on the coder class itself: turn streams,
    inbound approval request is rejected (-32601), budgets are honored."""
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
        state = await runner.start_turn("ASK_APPROVAL")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes and outcomes[0]["error"]["code"] == -32601
        assert state.status == "finished"
    finally:
        await runner.stop()
