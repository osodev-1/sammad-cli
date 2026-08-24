"""P4 final-review fixes — server-side follow-up queue, pure-logic layer.

Both findings here are exercised WITHOUT spawning the fake wire subprocess
(mirrors test_coder_journal_recovery.py's construction-only style):

- IMPORTANT C: `enqueue` must reject once the queue is at
  `coder_max_queue_depth` — neither `_queue` nor the running turn's
  `state.items` may grow past the cap.
- MINOR D: `_maybe_drain_queue` must not strand a popped item when
  `start_turn` raises after the `popleft()` — the item goes back onto the
  queue instead of vanishing.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sanad_terminal.coder_runner import CoderRunner, new_conversation_id
from sanad_terminal.wire_runner import TurnState, WireRunnerError

FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"


def _make_runner(tmp_path: Path, *, max_queue_depth: int = 50) -> CoderRunner:
    return CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
        max_queue_depth=max_queue_depth,
    )


# -- IMPORTANT C: queue depth cap --------------------------------------------


def test_enqueue_rejects_past_the_cap_without_growing_state_items(tmp_path):
    runner = _make_runner(tmp_path, max_queue_depth=2)

    # A running current turn, so `enqueue`'s journal-marker append path
    # (`_append_sync` onto `state.items`) is actually exercised.
    state = TurnState(turn_id="t_x", user_input="running turn")
    runner._current = state
    runner._turns[state.turn_id] = state
    runner._turn_order.append(state.turn_id)

    assert runner.enqueue("s1", "one") == 1
    assert runner.enqueue("s2", "two") == 2

    with pytest.raises(WireRunnerError) as exc_info:
        runner.enqueue("s3", "three")
    assert exc_info.value.code == "queue_full"

    # The queue itself never grew past the cap...
    assert runner.queue_summary() == [
        {"sendId": "s1", "input": "one"},
        {"sendId": "s2", "input": "two"},
    ]
    # ...and the rejected item was never journaled onto the running turn.
    queued_markers = [i for i in state.items if i.get("kind") == "queued"]
    assert [m["sendId"] for m in queued_markers] == ["s1", "s2"]
    assert len(state.items) == 2


def test_enqueue_idempotent_resend_does_not_count_against_the_cap(tmp_path):
    """A resend of a send_id already queued is a no-op dedup hit (existing
    P4b behavior) — it must not be confused with "queue full" and must not
    itself trip the cap check."""
    runner = _make_runner(tmp_path, max_queue_depth=1)
    assert runner.enqueue("s1", "one") == 1
    # Resending the SAME send_id when already at the cap must still report
    # its existing position, not raise queue_full.
    assert runner.enqueue("s1", "one again") == 1
    assert runner.queue_summary() == [{"sendId": "s1", "input": "one"}]


def test_enqueue_cap_default_is_conservative(tmp_path):
    runner = _make_runner(tmp_path)
    assert runner._max_queue_depth == 50


# -- MINOR D: drain guard must not strand a popped item ----------------------


@pytest.mark.asyncio
async def test_maybe_drain_queue_requeues_item_when_start_turn_raises(tmp_path, monkeypatch):
    runner = _make_runner(tmp_path)
    # Fake "alive" without spawning a real subprocess — `_maybe_drain_queue`
    # only needs `self.alive` to read True to reach the `start_turn` call.
    runner._alive = True
    runner._proc = SimpleNamespace(returncode=None)  # type: ignore[assignment]

    runner.enqueue("s1", "queued while alive")

    async def _boom(user_input: str, send_id: str | None = None) -> TurnState:
        # Simulates `_send`'s pipe write failing while `alive` was still
        # True (the narrow TOCTOU the finding describes).
        raise WireRunnerError("call_failed", "pipe broke")

    monkeypatch.setattr(runner, "start_turn", _boom)

    # Must not raise — the whole point of the guard.
    await runner._maybe_drain_queue()

    # The popped item must be back at the head of the queue, not stranded.
    assert runner.queue_summary() == [{"sendId": "s1", "input": "queued while alive"}]


@pytest.mark.asyncio
async def test_maybe_drain_queue_preserves_order_when_requeueing_the_head(tmp_path, monkeypatch):
    runner = _make_runner(tmp_path)
    runner._alive = True
    runner._proc = SimpleNamespace(returncode=None)  # type: ignore[assignment]

    runner.enqueue("s1", "first")
    runner.enqueue("s2", "second")

    async def _boom(user_input: str, send_id: str | None = None) -> TurnState:
        raise WireRunnerError("call_failed", "pipe broke")

    monkeypatch.setattr(runner, "start_turn", _boom)

    await runner._maybe_drain_queue()

    assert runner.queue_summary() == [
        {"sendId": "s1", "input": "first"},
        {"sendId": "s2", "input": "second"},
    ]
