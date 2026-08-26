"""WireRunner unit tests driven by the fake coder wire — budgets, the
deny-by-default request hook, and the probe registry. No LLM, no FastAPI."""

import asyncio
import json
import sys
import time
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
FAKE_INIT_WIRE = Path(__file__).parent / "_fake_init_wire.py"


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
async def test_call_round_trips():
    """`call()` generalizes the pending-future machinery `initialize` already
    uses: fresh id, register pending, send, await, return the result."""
    runner = _runner()
    await runner.start()
    try:
        result = await runner.call("set_permission_mode", {"mode": "accept-edits"})
        assert result == {"status": "ok", "permission_mode": "accept-edits"}
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_call_timeout_raises():
    """The fake ignores unknown top-level methods (no response at all) — the
    call must time out rather than hang forever."""
    runner = _runner()
    await runner.start()
    try:
        with pytest.raises(WireRunnerError) as exc:
            await runner.call("no_such_method", {}, timeout=0.5)
        assert exc.value.code == "call_failed"
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
async def test_coder_journals_plan_display_before_the_exit_plan_mode_question(tmp_path):
    """P4 Task 3: `PlanDisplay` is an ordinary event — no special-casing
    needed server-side — so it must land in the journal ahead of the
    ExitPlanMode `QuestionRequest` it precedes on the wire, and answering
    that question still finishes the turn normally."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("PLAN")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        pending = runner.pending_summaries()
        assert len(pending) == 1
        assert pending[0]["requestType"] == "question"
        assert pending[0]["requestId"] == "plan_1"

        # The PlanDisplay event is already journaled, ahead of the request.
        plan_events = [
            i["event"]["payload"]
            for i in state.items
            if i.get("kind") == "event" and i["event"].get("type") == "PlanDisplay"
        ]
        assert len(plan_events) == 1
        assert plan_events[0]["content"].startswith("# The Plan")
        assert plan_events[0]["file_path"] == "/tmp/plan.md"
        kinds = [i.get("kind") for i in state.items]
        plan_idx = next(
            i
            for i, item in enumerate(state.items)
            if item.get("kind") == "event" and item["event"].get("type") == "PlanDisplay"
        )
        request_idx = kinds.index("request")
        assert plan_idx < request_idx

        await runner.respond("plan_1", {"answers": {"Approve this plan?": "Approve"}})
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["answers"] == {"Approve this plan?": "Approve"}
        assert state.status == "finished"
        assert runner.pending_summaries() == []
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
async def test_set_permission_mode_updates_tracking(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        assert runner.permission_mode == "default"
        await runner.set_permission_mode("accept-edits")
        assert runner.permission_mode == "accept-edits"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_set_permission_mode_rejects_unknown_mode(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        with pytest.raises(WireRunnerError) as exc:
            await runner.set_permission_mode("yolo")
        assert exc.value.code == "invalid_mode"
        # A rejected mode must not be adopted into local tracking.
        assert runner.permission_mode == "default"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_steer_while_turn_runs_emits_steer_input(tmp_path):
    """`CoderRunner.steer()` round-trips over the wire's generic `call()`
    machinery while a turn is running: the fake's STEERABLE mode hangs until
    the steer arrives, then journals a SteerInput event on the SAME turn and
    finishes it — no new turn is started."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("STEERABLE")
        await runner.steer("go left")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        steer_inputs = [
            i["event"]["payload"]["user_input"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "SteerInput"
        ]
        assert steer_inputs == ["go left"]
        assert state.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_steer_with_no_turn_raises_no_turn(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        with pytest.raises(WireRunnerError) as exc:
            await runner.steer("go left")
        assert exc.value.code == "no_turn"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_steer_after_turn_finished_raises_no_turn(tmp_path):
    """A stale steer against a turn that already finished must fail closed
    locally — never round-trip to the CLI only to be rejected there."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("hello")
        await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        assert state.status == "finished"
        with pytest.raises(WireRunnerError) as exc:
            await runner.steer("go left")
        assert exc.value.code == "no_turn"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_steer_before_prompt_sent_is_rejected_not_silently_dropped(tmp_path):
    """P6a: the window between `self._current` being set (turn looks
    `busy`) and the prompt actually reaching the CLI (P5's pre-turn
    checkpoint `await` widened it) must not let a `/steer` reach the wire
    ahead of the prompt it's supposed to follow up on — it must fail closed
    with `no_turn`, the SAME signal as "no turn at all", rather than being
    silently swallowed by the CLI on the other end.

    `_before_prompt_sent` is monkeypatched with a controllable gate so the
    test can land deterministically inside that exact window — no reliance
    on real git checkpoint timing."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def _slow_before_prompt_sent(state):
            entered.set()
            await release.wait()

        runner._before_prompt_sent = _slow_before_prompt_sent

        turn_task = asyncio.create_task(runner.start_turn("hello"))
        await asyncio.wait_for(entered.wait(), timeout=5.0)

        # Inside the window: the turn already looks busy, but no prompt has
        # been sent yet.
        assert runner.busy is True
        assert runner._prompt_id is None

        with pytest.raises(WireRunnerError) as exc:
            await runner.steer("go left")
        assert exc.value.code == "no_turn"

        release.set()
        state = await asyncio.wait_for(turn_task, timeout=5.0)
        await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        assert state.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_cancel_before_prompt_sent_waits_then_genuinely_cancels(tmp_path):
    """P6a review Important 7: `WireRunner.cancel()`'s own
    `self._prompt_id is None` guard already keeps a `/cancel` landing in
    this window from reaching the wire as a bogus message (it never sends
    anything for a prompt that hasn't gone out) — but base `cancel()` then
    just no-ops, and the turn runs to completion as if the cancel never
    happened. Under the write-lease that's worse than it used to be: the
    un-cancelled turn goes on to hold the workspace lease for its entire
    duration, blocking every other conversation, not just its own.

    `CoderRunner.cancel()` now WAITS (bounded) for the prompt to actually be
    sent, then genuinely cancels — proven here with a HANG turn so a real
    cancellation is observable (final status "cancelled", not "finished"),
    and by asserting the `cancel()` call is still in flight (not a fast
    no-op) while the gate is held closed."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def _slow_before_prompt_sent(state):
            entered.set()
            await release.wait()

        runner._before_prompt_sent = _slow_before_prompt_sent

        turn_task = asyncio.create_task(runner.start_turn("HANG"))
        await asyncio.wait_for(entered.wait(), timeout=5.0)
        assert runner.busy is True
        assert runner._prompt_id is None

        cancel_task = asyncio.create_task(runner.cancel())
        await asyncio.sleep(0.05)  # let cancel() enter its wait loop
        assert not cancel_task.done(), "cancel() must wait, not silently no-op, in this window"

        release.set()
        state = await asyncio.wait_for(turn_task, timeout=5.0)
        await asyncio.wait_for(cancel_task, timeout=5.0)

        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        assert items[-1]["kind"] == "end" and items[-1]["status"] == "cancelled"
        assert state.status == "cancelled"
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


# -- P4b: server-side per-conversation queue ---------------------------------


@pytest.mark.asyncio
async def test_enqueue_while_busy_returns_position_and_appears_in_summary(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("HANG", send_id="running")
        position = runner.enqueue("s1", "do this next")
        assert position == 1
        assert runner.queue_summary() == [{"sendId": "s1", "input": "do this next"}]
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_enqueue_journals_a_queued_item_into_the_current_turn(tmp_path):
    """So a follower can see queue depth grow without a separate poll."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("HANG", send_id="running")
        runner.enqueue("s1", "next up")
        queued_items = [
            (i.get("sendId"), i.get("input")) for i in state.items if i.get("kind") == "queued"
        ]
        assert queued_items == [("s1", "next up")]
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_enqueue_is_idempotent_on_duplicate_send_id(tmp_path):
    """A resend of the same sendId while it's still queued must not double-add
    — mirrors `start_turn`'s own idempotency intent."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("HANG", send_id="running")
        first = runner.enqueue("dup", "do the thing")
        again = runner.enqueue("dup", "different text, same id")
        assert first == 1
        assert again == 1
        assert runner.queue_summary() == [{"sendId": "dup", "input": "do the thing"}]
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_enqueue_matching_the_running_turns_send_id_is_a_noop(tmp_path):
    """A resend of the in-flight turn's own sendId is already being handled —
    it must not also land in the queue."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("HANG", send_id="running")
        result = runner.enqueue("running", "resend of the same in-flight message")
        assert result == 0
        assert runner.queue_summary() == []
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_enqueue_matching_the_last_finished_turns_send_id_is_a_noop(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("hello", send_id="done1")
        await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        assert state.status == "finished"
        result = runner.enqueue("done1", "resend of the already-finished turn")
        assert result == 0
        assert runner.queue_summary() == []
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_dequeue_removes_a_not_yet_started_item(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("HANG", send_id="running")
        runner.enqueue("s1", "one")
        runner.enqueue("s2", "two")
        assert runner.dequeue("s1") is True
        assert runner.queue_summary() == [{"sendId": "s2", "input": "two"}]
        assert runner.dequeue("s1") is False  # already gone
        assert runner.dequeue("nope") is False
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_maybe_drain_queue_noop_when_empty_or_busy(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner._maybe_drain_queue()  # empty queue: no-op, no crash
        assert runner._turn_order == []

        state = await runner.start_turn("HANG", send_id="running")
        runner.enqueue("later", "do this next")
        await runner._maybe_drain_queue()  # busy: must not touch the queue
        assert runner.queue_summary() == [{"sendId": "later", "input": "do this next"}]
        summary = runner.turn_summary()
        assert summary is not None
        assert summary["turnId"] == state.turn_id
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_maybe_drain_queue_noop_when_not_alive(tmp_path):
    runner = _coder(tmp_path)
    # Never started — `alive` is False.
    runner._queue.append({"sendId": "s1", "input": "hi"})
    await runner._maybe_drain_queue()
    assert runner.queue_summary() == [{"sendId": "s1", "input": "hi"}]


@pytest.mark.asyncio
async def test_queue_drains_automatically_when_the_running_turn_ends(tmp_path):
    """The core P4b deliverable: a follow-up queued while a turn is running
    starts for real once that turn ends — no manual drain call, `_consume`'s
    own `finally` (CoderRunner's override) does it via `_maybe_drain_queue`."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        first = await runner.start_turn("HANG", send_id="s1")
        position = runner.enqueue("s2", "queued input")
        assert position == 1

        await runner.cancel()
        items = await asyncio.wait_for(_drain(runner, first.turn_id), timeout=5.0)
        assert items[-1]["kind"] == "end" and items[-1]["status"] == "cancelled"

        # `_maybe_drain_queue` fires from `_consume`'s `finally`, a
        # continuation of a background task independent of `follow()` — poll
        # briefly instead of assuming it's already landed the instant
        # `follow()` returns.
        summary = None
        for _ in range(100):
            summary = runner.turn_summary()
            if summary is not None and summary["turnId"] != first.turn_id:
                break
            await asyncio.sleep(0.02)
        assert summary is not None
        assert summary["turnId"] != first.turn_id
        assert summary["userInput"] == "queued input"
        assert runner.queue_summary() == []
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_concurrent_drain_calls_never_double_pop(tmp_path):
    """Empirical proof of the no-await-gap safety claim in `_maybe_drain_queue`'s
    docstring: two calls fired concurrently (`asyncio.gather`) against an idle
    runner with two queued items must start exactly ONE new turn. asyncio is
    single-threaded and there is no `await` between the not-busy check and the
    `start_turn` call that flips `busy` — so whichever call's synchronous
    prefix reaches `start_turn` first flips `busy` True before the other one
    ever gets scheduled to run its own check, and that second call's busy
    check then sees it and no-ops instead of double-popping."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        runner.enqueue("s1", "hello")
        runner.enqueue("s2", "also queued")
        assert len(runner.queue_summary()) == 2

        await asyncio.gather(runner._maybe_drain_queue(), runner._maybe_drain_queue())

        assert len(runner.queue_summary()) == 1
        assert runner.queue_summary()[0]["sendId"] == "s2"
        assert len(runner._turn_order) == 1
        started = runner._turns[runner._turn_order[0]]
        assert started.user_input == "hello"
        assert started.send_id == "s1"
    finally:
        await runner.stop()


# -- P6b: WireRunner.start()'s initialize-error propagation -----------------
#
# `_fake_init_wire.py` controls exactly what `initialize` answers with (env
# `FAKE_INIT_MODE`), so these exercise the REAL parsing logic in `start()`
# against a real subprocess round trip rather than mocking it.


def _init_runner(
    *, mode: str = "ok", error: dict | None = None, null_id: bool = False, **kwargs
) -> WireRunner:
    env = {"FAKE_INIT_MODE": mode}
    if error is not None:
        env["FAKE_INIT_ERROR_JSON"] = json.dumps(error)
    if null_id:
        env["FAKE_INIT_NULL_ID"] = "1"
    return WireRunner(
        argv=(sys.executable, str(FAKE_INIT_WIRE)),
        cwd=Path.cwd(),
        env=env,
        client_name="test-init",
        capabilities={"supports_question": False, "supports_plan_mode": False},
        **kwargs,
    )


@pytest.mark.asyncio
async def test_session_owned_init_error_propagates_app_code_and_data():
    """The exact wire shape Task 2 emits (`build_session_owned_error`):
    JSON-RPC `error.code` is the int `-32005`, and the app-level string
    discriminator plus ui_mode/busy live in `error.data`. `start()` must
    surface THAT string as `.code` (not the flat `init_failed` every other
    initialize failure gets) and carry `.data` through unchanged."""
    runner = _init_runner(
        mode="error",
        error={
            "code": -32005,
            "message": "Session is owned by another view (wire, idle)",
            "data": {"code": "session_owned", "ui_mode": "wire", "busy": False},
        },
    )
    with pytest.raises(WireRunnerError) as exc:
        await runner.start()
    assert exc.value.code == "session_owned"
    assert exc.value.message == "Session is owned by another view (wire, idle)"
    assert exc.value.data == {"code": "session_owned", "ui_mode": "wire", "busy": False}


@pytest.mark.asyncio
async def test_null_id_session_owned_error_still_correlates_to_the_lone_outstanding_request():
    """Review Important 1: `kimi_cli.sanad.session_lease.refuse_wire_initialize`
    answers with a NULL id whenever `parse_initialize_request_id` can't
    recover a STRING id from our request (EOF, bad JSON, or a non-string
    id) — the binding P6b contract is to correlate this to our one
    outstanding request rather than silently dropping it. Before the fix,
    `_dispatch` returned immediately on `raw_id is None`, so the pending
    `initialize` future was left unresolved; the child then closes its
    streams and exits right after answering this way (mirroring the real
    CLI), which trips `_read_loop`'s EOF path and resolves the SAME future
    with a flat `WireRunnerError("exited", "agent exited")` instead —
    discarding the real `session_owned` payload and degrading every
    takeover to an uninformative 503."""
    runner = _init_runner(
        mode="error",
        null_id=True,
        error={
            "code": -32005,
            "message": "Session is owned by another view (wire, idle)",
            "data": {"code": "session_owned", "ui_mode": "wire", "busy": False},
        },
    )
    with pytest.raises(WireRunnerError) as exc:
        await runner.start()
    assert exc.value.code == "session_owned"
    assert exc.value.data == {"code": "session_owned", "ui_mode": "wire", "busy": False}


@pytest.mark.asyncio
async def test_null_id_error_after_the_handshake_is_not_misattributed_to_an_unrelated_call():
    """Minor (review): the test above proves the null-id fallback correlates
    correctly DURING the handshake. This proves it stays scoped to ONLY the
    handshake — the fallback used to key off "whichever request happens to
    be the only one outstanding right now", not the handshake's own id.

    A pre-existing, UN-GATED null-id error (kimi emits these for
    PARSE_ERROR / an invalid request / an invalid response — nothing
    P6b-specific) arriving AFTER `start()` already succeeded, while some
    UNRELATED `call()` is the sole pending request, must never be
    misattributed as that call's own answer — it must be dropped, and the
    call must instead time out on its own, exactly as it would with no
    null-id fallback at all.

    Real subprocess round trip (`_fake_init_wire.py`'s new
    `ok_then_null_error` mode): answers `initialize` normally, THEN answers
    the very next message (our `call()`) with an unrelated null-id error."""
    runner = _init_runner(mode="ok_then_null_error")
    await runner.start()
    try:
        started = time.monotonic()
        with pytest.raises(WireRunnerError) as exc:
            await runner.call("some_method", {}, timeout=0.3)
        elapsed = time.monotonic() - started
        # The call's OWN timeout fired — NOT an instant (mis)resolution
        # from the unrelated null-id error the fake sent back immediately.
        assert exc.value.code == "call_failed"
        assert "timed out" in exc.value.message
        assert elapsed >= 0.25
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_generic_init_error_without_app_code_falls_back_to_init_failed():
    """An initialize error with NO `data.code` (every JSON-RPC error other
    than `session_owned` today) must still fall back to `init_failed` —
    this is the "everything else stays today's flat error" half of the
    contract, proven against a shape that ISN'T the timeout path.

    Important 3 (review): the MESSAGE, not just the code, must also stay
    identical to the pre-P6b behavior when no app-level `data.code` was
    recovered — this route (coder/architect/worker alike) rendered
    `str(<whole error dict>)` as the 503 body before P6b ever touched this
    method, gate on or off. A regression that instead surfaces the error
    object's own `.message` field unconditionally silently changes that
    body even with SANAD_SESSION_LOCKS unset, so this is a gate-off
    identity test, not merely a code-path test."""
    error = {"code": -32001, "message": "llm not set"}
    runner = _init_runner(mode="error", error=error)
    with pytest.raises(WireRunnerError) as exc:
        await runner.start()
    assert exc.value.code == "init_failed"
    assert exc.value.message == str(error)
    assert exc.value.data is None


@pytest.mark.asyncio
async def test_init_timeout_still_uses_init_failed(monkeypatch):
    """A timeout (no `error` object at all — the child never answers) must
    stay `init_failed`, unaffected by the new error-parsing branch, which
    this exercises via a genuinely non-responding subprocess rather than a
    mocked timeout."""
    monkeypatch.setattr("sanad_terminal.wire_runner._INIT_TIMEOUT_SECONDS", 0.2)
    runner = _init_runner(mode="hang")
    with pytest.raises(WireRunnerError) as exc:
        await runner.start()
    assert exc.value.code == "init_failed"
    assert exc.value.data is None


@pytest.mark.asyncio
async def test_start_init_timeout_parameter_clamps_below_the_module_default():
    """Important 2 (review): `routes_coder._handle_session_owned` clamps its
    final takeover respawn to whatever remains of its own bounded window via
    `start(init_timeout=...)`, rather than risking the full 30s module
    default blowing that window by up to 2x. Proven directly here — no
    module-constant monkeypatch — against a genuinely non-responding
    subprocess, so a regression that ignores the parameter (falls back to
    `_INIT_TIMEOUT_SECONDS`) would time THIS test out instead of silently
    passing."""
    runner = _init_runner(mode="hang")
    start = time.monotonic()
    with pytest.raises(WireRunnerError) as exc:
        await asyncio.wait_for(runner.start(init_timeout=0.15), timeout=5.0)
    elapsed = time.monotonic() - start
    assert exc.value.code == "init_failed"
    assert elapsed < 1.0  # nowhere near the 30s module default


@pytest.mark.asyncio
async def test_architect_runner_start_unaffected_by_the_propagation_change():
    """`ArchitectRunner` doesn't override `start()` — it inherits this
    change verbatim. Proves BOTH the ordinary successful-start path AND the
    error path still work exactly as `routes_architect.py`'s flat
    `_err(503, exc.code, exc.message)` mapping needs (plain strings,
    regardless of what `.code` now holds)."""
    from sanad_terminal.architect_runner import ArchitectRunner

    ok_runner = ArchitectRunner(
        argv=(sys.executable, str(FAKE_INIT_WIRE)), cwd=Path.cwd(), env={"FAKE_INIT_MODE": "ok"}
    )
    await ok_runner.start()
    try:
        assert ok_runner.alive
    finally:
        await ok_runner.stop()

    err_runner = ArchitectRunner(
        argv=(sys.executable, str(FAKE_INIT_WIRE)),
        cwd=Path.cwd(),
        env={
            "FAKE_INIT_MODE": "error",
            "FAKE_INIT_ERROR_JSON": json.dumps({"code": -32603, "message": "boom"}),
        },
    )
    with pytest.raises(WireRunnerError) as exc:
        await err_runner.start()
    assert exc.value.code == "init_failed"  # no data.code in this error → unchanged fallback
    assert isinstance(exc.value.message, str)


@pytest.mark.asyncio
async def test_run_runner_start_unaffected_by_the_propagation_change():
    """Same proof as above for `RunRunner` — the OTHER `WireRunner`
    subclass that doesn't override `start()`, and whose route
    (`routes_worker.py`) also maps `start()` failures with a flat
    `_err(503, exc.code, exc.message)`."""
    from sanad_terminal.run_runner import RunRunner

    ok_runner = RunRunner(
        run_id="r_000000000000",
        argv=(sys.executable, str(FAKE_INIT_WIRE)),
        cwd=Path.cwd(),
        env={"FAKE_INIT_MODE": "ok"},
        max_turn_seconds=60.0,
        max_steps_per_turn=10,
        max_tokens_per_run=1000,
    )
    await ok_runner.start()
    try:
        assert ok_runner.alive
    finally:
        await ok_runner.stop()

    run_error = {"code": -32603, "message": "boom"}
    err_runner = RunRunner(
        run_id="r_000000000001",
        argv=(sys.executable, str(FAKE_INIT_WIRE)),
        cwd=Path.cwd(),
        env={
            "FAKE_INIT_MODE": "error",
            "FAKE_INIT_ERROR_JSON": json.dumps(run_error),
        },
        max_turn_seconds=60.0,
        max_steps_per_turn=10,
        max_tokens_per_run=1000,
    )
    with pytest.raises(WireRunnerError) as exc:
        await err_runner.start()
    assert exc.value.code == "init_failed"
    # Important 3 (review): no `data.code` here either — the worker route's
    # 503 body must keep rendering the whole error dict, same as coder and
    # architect above.
    assert exc.value.message == str(run_error)
