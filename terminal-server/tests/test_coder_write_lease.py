"""P6a Task 2 — runner integration for the per-workspace write-lease:

* `CoderRunner.start_turn` acquires `lease_for(root)` before delegating to
  `WireRunner.start_turn`, and releases it (via `_consume`'s `finally`, and
  defensively in `stop()`) on every terminal path — finished, failed,
  cancelled, and a runner stopped mid-turn.
* A second conversation whose acquire fails is queued (never started), with
  `reason="waiting_for_lease"` and `blockedBy=<holder>` on its queue item —
  mirroring what Task 3's `/send` route does with the `WireRunnerError`
  `start_turn` raises.
* The cross-runner handoff: releasing the lease wakes the next FIFO waiter's
  OWN `_maybe_drain_queue`, so a queued conversation's turn actually starts
  without needing its own turn-end to trigger it (`_maybe_drain_queue` only
  ever fires on its own runner's turn-end otherwise).

Every test drives the real fake `sanad --wire` subprocess (`_fake_coder_wire.py`)
through actual `CoderRunner` instances — no mocking of `start_turn`/`_consume`
themselves, mirroring the sibling `test_wire_runner.py`/`test_coder_checkpoints.py`
style. No journal_dir is configured (irrelevant to lease behavior) and no git
repo is seeded — checkpointing is best-effort and fails silently (caught,
logged) against a bare `tmp_path`, exactly as the existing non-journaled coder
tests in `test_wire_runner.py` already rely on.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from sanad_terminal.architect_runner import ArchitectRunner
from sanad_terminal.coder_runner import (
    CoderRunner,
    new_conversation_id,
    put_conversation,
)
from sanad_terminal.wire_runner import WireRunnerError
from sanad_terminal.workspace_lease import lease_for

FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"
FAKE_ARCHITECT_WIRE = Path(__file__).parent / "_fake_architect_wire.py"


def _coder(root: Path, **kwargs) -> CoderRunner:
    return CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=root,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
        **kwargs,
    )


async def _drain(runner: CoderRunner, turn_id: str) -> list[dict]:
    return [item async for item in runner.follow(turn_id, 0)]


async def _await_consumer(runner: CoderRunner, *, timeout: float = 5.0) -> None:
    """Await a turn's ENTIRE consumer chain — including CoderRunner's own
    `_consume` finally (checkpoint post, journal note, lease release,
    handoff) — mirroring test_coder_checkpoints.py's `_run_turn_to_completion`
    helper. The `assert ... is not None` narrows `Task[None] | None` for
    the type checker exactly like that sibling helper does."""
    consumer = runner._consumer
    assert consumer is not None
    await asyncio.wait_for(consumer, timeout=timeout)


async def _wait_for(predicate, *, tries: int = 150, interval: float = 0.02) -> None:
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(interval)
    assert predicate()  # final attempt — raises with a normal assertion failure


# -- acquire / release on the runner's own lifecycle -------------------------


@pytest.mark.asyncio
async def test_start_turn_acquires_the_lease_and_releases_on_finish(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        lease = lease_for(tmp_path)
        assert lease.holder_of() is None
        state = await runner.start_turn("hello")
        # Acquired synchronously as part of start_turn, before the turn even
        # finishes running.
        assert lease.holder_of() == runner.conversation_id
        await _await_consumer(runner)
        assert state.status == "finished"
        assert lease.holder_of() is None
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_lease_is_released_on_a_failed_turn(tmp_path):
    """Killing the subprocess mid-turn is the realistic way `_consume`
    reaches `status == "failed"` (`_read_loop`'s finally injects a synthetic
    `{"kind":"error", ...}` on EOF) — mirrors
    `test_pending_requests_survive_subprocess_crash` in test_wire_runner.py."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        lease = lease_for(tmp_path)
        state = await runner.start_turn("HANG")
        assert lease.holder_of() == runner.conversation_id
        assert runner._proc is not None
        runner._proc.kill()
        await _await_consumer(runner)
        assert state.status == "failed"
        assert lease.holder_of() is None
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_lease_is_released_on_a_cancelled_turn(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        lease = lease_for(tmp_path)
        state = await runner.start_turn("HANG")
        assert lease.holder_of() == runner.conversation_id
        await runner.cancel()
        await _await_consumer(runner)
        assert state.status == "cancelled"
        assert lease.holder_of() is None
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_lease_is_released_when_the_runner_is_stopped_mid_turn(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    lease = lease_for(tmp_path)
    await runner.start_turn("HANG")
    assert lease.holder_of() == runner.conversation_id
    await runner.stop()
    assert lease.holder_of() is None


@pytest.mark.asyncio
async def test_idempotent_resend_of_a_finished_turn_never_touches_the_lease(tmp_path):
    """A resend matching the last already-finished turn's send_id must
    return that turn unconditionally (WireRunner's own documented
    idempotency contract) — even while some OTHER conversation holds the
    lease. If CoderRunner naively tried to acquire on every call, this would
    regress into a spurious `lease_unavailable` for a call that isn't
    actually attempting to mutate anything."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("hello", send_id="done1")
        await _await_consumer(runner)
        assert state.status == "finished"

        # Simulate a different conversation holding the lease right now.
        lease = lease_for(tmp_path)
        assert lease.try_acquire("c_someoneelse01") is True
        try:
            again = await runner.start_turn("hello", send_id="done1")
            assert again.turn_id == state.turn_id
        finally:
            lease.release("c_someoneelse01")
    finally:
        await runner.stop()


# -- queue-at-the-lease + the cross-runner handoff ---------------------------


@pytest.mark.asyncio
async def test_send_while_lease_held_elsewhere_is_queued_and_does_not_start(tmp_path):
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        await a.start_turn("HANG")
        lease = lease_for(tmp_path)
        assert lease.holder_of() == a.conversation_id

        with pytest.raises(WireRunnerError) as exc_info:
            await b.start_turn("do the thing", send_id="b1")
        assert exc_info.value.code == "lease_unavailable"
        assert exc_info.value.holder == a.conversation_id

        # Task 3's /send route reacts to exactly this signal by queuing —
        # simulated here at the runner level.
        position = b.enqueue(
            "b1", "do the thing", reason="waiting_for_lease", blocked_by=a.conversation_id
        )
        assert position == 1
        assert b.queue_summary() == [
            {
                "sendId": "b1",
                "input": "do the thing",
                "reason": "waiting_for_lease",
                "blockedBy": a.conversation_id,
            }
        ]
        assert b.busy is False
        assert b._turn_order == []
    finally:
        await a.stop()
        await b.stop()


@pytest.mark.asyncio
async def test_release_hands_off_to_the_waiting_conversations_queued_turn(tmp_path):
    """The crux: B's queued turn must actually START once A releases —
    `_maybe_drain_queue` only fires on its OWN runner's turn-end, so without
    the cross-runner handoff B would wait forever."""
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        await a.start_turn("HANG")
        with pytest.raises(WireRunnerError) as exc_info:
            await b.start_turn("do the thing", send_id="b1")
        b.enqueue(
            "b1", "do the thing", reason="waiting_for_lease", blocked_by=exc_info.value.holder
        )

        await a.cancel()
        await _await_consumer(a)

        # B's turn must actually begin — not just get popped off the queue.
        await _wait_for(lambda: b._turn_order != [])
        assert b.queue_summary() == []
        started = b._turns[b._turn_order[0]]
        assert started.send_id == "b1"
        assert started.user_input == "do the thing"

        # `status` flips terminal before B's OWN `_consume` finally (where
        # the lease release lives) has actually run — await the full
        # consumer chain, not just `busy`, before checking the lease.
        await _await_consumer(b)
        assert started.status == "finished"
        assert lease_for(tmp_path).holder_of() is None
    finally:
        await a.stop()
        await b.stop()


@pytest.mark.asyncio
async def test_several_queued_conversations_hand_off_in_fifo_order(tmp_path):
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    c = _coder(tmp_path)
    d = _coder(tmp_path)
    for r in (a, b, c, d):
        put_conversation(tmp_path, r)
        await r.start()
    try:
        await a.start_turn("HANG")

        for cid_runner, send_id in ((b, "b1"), (c, "c1"), (d, "d1")):
            with pytest.raises(WireRunnerError) as exc_info:
                await cid_runner.start_turn(f"work for {send_id}", send_id=send_id)
            cid_runner.enqueue(
                send_id,
                f"work for {send_id}",
                reason="waiting_for_lease",
                blocked_by=exc_info.value.holder,
            )

        assert lease_for(tmp_path).waiters_snapshot() == [
            b.conversation_id,
            c.conversation_id,
            d.conversation_id,
        ]

        await a.cancel()
        await _await_consumer(a)

        # The whole chain (A -> B -> C -> D) unwinds via each runner's own
        # background consumer task waking the next one on release. `status`
        # flips terminal (and `busy` follows) the MOMENT the wire's `end`
        # arrives — before this same turn's OWN `_consume` finally (where
        # the lease release + next handoff live) has actually run (see
        # `TurnState.closed`'s docstring) — so wait for D's full consumer
        # chain, not just `not d.busy`, before asserting the lease is free.
        await _wait_for(lambda: d._turn_order != [])
        await _await_consumer(d)

        assert b._turns[b._turn_order[0]].status == "finished"
        assert c._turns[c._turn_order[0]].status == "finished"
        assert d._turns[d._turn_order[0]].status == "finished"
        assert lease_for(tmp_path).waiters_snapshot() == []
        assert lease_for(tmp_path).holder_of() is None
    finally:
        for r in (a, b, c, d):
            await r.stop()


@pytest.mark.asyncio
async def test_maybe_drain_queue_leaves_item_queued_while_lease_held_elsewhere(tmp_path):
    """Direct proof of the P6a addition to `_maybe_drain_queue`'s own gate:
    called on an IDLE runner whose queue has an item, with the lease held by
    someone else, it must leave the item queued and return — no pop, no
    spin, no exception."""
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        await a.start_turn("HANG")
        b.enqueue("b1", "queued", reason="waiting_for_lease", blocked_by=a.conversation_id)

        await b._maybe_drain_queue()

        assert b.queue_summary() == [
            {
                "sendId": "b1",
                "input": "queued",
                "reason": "waiting_for_lease",
                "blockedBy": a.conversation_id,
            }
        ]
        assert b._turn_order == []
        assert b.busy is False
    finally:
        await a.stop()
        await b.stop()


# -- staleness safety net -----------------------------------------------------


@pytest.mark.asyncio
async def test_stale_dead_holder_lease_is_reclaimed_not_wedged(tmp_path):
    """A holder that never released (simulating a leaked lease from a dead
    runner) must not permanently wedge the workspace — `try_acquire`'s own
    staleness reclaim (Task 1) kicks in once the TTL has elapsed, and a real
    `CoderRunner.start_turn` benefits from it exactly like any other caller."""
    lease = lease_for(tmp_path, stale_after_seconds=0.01)
    assert lease.try_acquire("c_deadholder001", now=time.monotonic() - 10.0) is True

    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("hello")
        assert lease.holder_of() == runner.conversation_id
        await _await_consumer(runner)
        assert state.status == "finished"
        assert lease.holder_of() is None
    finally:
        await runner.stop()


# -- lease must not leak when start_turn fails after acquiring ---------------


class _BrokenPipeStdin:
    def write(self, data: bytes) -> None:
        return None

    async def drain(self) -> None:
        raise BrokenPipeError("mock: pipe closed")


@pytest.mark.asyncio
async def test_lease_is_not_leaked_when_start_turn_fails_after_acquiring(tmp_path):
    """The single biggest risk this task calls out: if `start_turn` acquires
    the lease and then fails before a consumer task exists to eventually
    release it (e.g. a broken pipe on the prompt send — see
    test_coder_queue_runtime.py's sibling coverage for `_maybe_drain_queue`),
    CoderRunner itself must release what it just acquired rather than
    leaving the workspace wedged."""
    runner = _coder(tmp_path)
    runner._alive = True
    runner._proc = SimpleNamespace(returncode=None, stdin=_BrokenPipeStdin())  # type: ignore[assignment]

    lease = lease_for(tmp_path)
    assert lease.holder_of() is None
    with pytest.raises(BrokenPipeError):
        await runner.start_turn("hello")
    assert lease.holder_of() is None


# -- ArchitectRunner must be completely unaffected ---------------------------


@pytest.mark.asyncio
async def test_architect_runner_never_touches_the_write_lease(tmp_path):
    """The lease is a CoderRunner-only concern — ArchitectRunner has no
    `conversation_id` at all (the lease's holder identity), and a normal
    architect turn must complete without ever creating a lease entry for its
    workspace root."""
    runner = ArchitectRunner(
        argv=(sys.executable, str(FAKE_ARCHITECT_WIRE)),
        cwd=tmp_path,
        env={},
    )
    assert not hasattr(runner, "conversation_id")
    await runner.start()
    try:
        state = await runner.start_turn("hello")
        items = [item async for item in runner.follow(state.turn_id, 0)]
        assert items[-1]["kind"] == "end"
        assert lease_for(tmp_path).holder_of() is None
    finally:
        await runner.stop()


# -- P6a review regressions -------------------------------------------------
# One test per Critical the Task 2 review proved with a probe. Each drives the
# real failure sequence, so a regression reproduces the original defect rather
# than merely failing an assertion about internals.


@pytest.mark.asyncio
async def test_empty_send_id_cannot_bypass_the_lease(tmp_path):
    """Review Critical 1. `_is_idempotent_start_turn_passthrough` guarded on
    `send_id is None` while the base guards on TRUTHINESS. So once a
    conversation had ANY prior turn carrying `send_id=""`, a later `""` send
    looked like an "idempotent resend" and SKIPPED the acquire — while the
    base, seeing `""` as falsy, went on to start a genuinely new turn. Net
    effect: a full turn running with no lease alongside a real holder.

    `SendBody.sendId` is `str | None` with no `min_length`, so `""` reaches
    `start_turn` straight from HTTP. The prior turn is what arms the bug, so
    the test has to establish one first.
    """
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        # Arm it: B completes a turn carrying an empty send_id, while the
        # lease is free and uncontended.
        await b.start_turn("first", send_id="")
        await _await_consumer(b)
        assert lease_for(tmp_path).holder_of() is None
        assert len(b._turn_order) == 1

        # A now holds the lease.
        await a.start_turn("HANG")
        assert lease_for(tmp_path).holder_of() == a.conversation_id

        # The same empty send_id again. This is the send that used to slip
        # past the acquire and start a second concurrent writer.
        with pytest.raises(WireRunnerError) as exc_info:
            await b.start_turn("second", send_id="")
        assert exc_info.value.code == "lease_unavailable"
        assert exc_info.value.holder == a.conversation_id

        assert len(b._turn_order) == 1, "B started a second turn with no lease"
        assert b.busy is False
        assert lease_for(tmp_path).holder_of() == a.conversation_id
    finally:
        await a.stop()
        await b.stop()


@pytest.mark.asyncio
async def test_cancelling_the_handoff_does_not_leave_the_woken_runner_holding_the_lease(
    tmp_path, monkeypatch
):
    """Review Critical 2. The handoff runs the WOKEN runner's `start_turn`
    inside the RELEASING runner's task, so it used to inherit that task's
    cancellation scope; `except Exception` misses `CancelledError`, so a
    cancel delivered mid-handoff left B holding the lease with no consumer
    to release it — and `_current` stuck `running`, so `b.busy` stayed True
    forever and even fresh input (which a busy runner routes to
    enqueue-without-drain) could not recover it. `asyncio.shield` decouples
    the woken runner's work from our cancellation.

    Cancelling `_wake_next_waiter`'s task directly is what makes this
    deterministic: reproducing it via `stop()` depends on exactly when the
    loop redelivers cancellation into a `finally`, which is far too delicate
    to pin a regression on.
    """
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        await a.start_turn("HANG")
        with pytest.raises(WireRunnerError) as exc_info:
            await b.start_turn("b work", send_id="b1")
        b.enqueue("b1", "b work", reason="waiting_for_lease", blocked_by=exc_info.value.holder)

        # Hold B inside its pre-prompt work so the handoff is genuinely
        # in flight when the cancellation lands.
        in_flight = asyncio.Event()
        original = CoderRunner._before_prompt_sent

        async def slow_pre_prompt(self, state):
            if self is b:
                in_flight.set()
                await asyncio.sleep(0.3)
            return await original(self, state)

        monkeypatch.setattr(CoderRunner, "_before_prompt_sent", slow_pre_prompt)

        # End A's turn WITHOUT awaiting its consumer: the automatic handoff
        # runs inside A's own `_consume` finally, so A's consumer task is
        # sitting in the handoff await while B does its slow pre-prompt work.
        await a.cancel()
        await asyncio.wait_for(in_flight.wait(), timeout=5.0)

        # Cancel A's consumer *there* — the exact delivery the old code
        # swallowed into B's half-finished start_turn.
        consumer = a._consumer
        assert consumer is not None
        consumer.cancel()

        # The forbidden outcome: B holds the lease with no turn to release
        # it. Shielded, B's start_turn completes on its own schedule.
        await _wait_for(
            lambda: lease_for(tmp_path).holder_of() != b.conversation_id or b._turn_order != []
        )
        if lease_for(tmp_path).holder_of() == b.conversation_id:
            assert b._turn_order != [], "B holds the lease with no turn — leaked"
    finally:
        await a.stop()
        await b.stop()


@pytest.mark.asyncio
async def test_a_ghost_waiter_does_not_strand_the_next_waiter(tmp_path):
    """Review Critical 3. `_wake_next_waiter` popped exactly one waiter and
    returned, so a waiter that had since been dropped/stopped consumed the
    wake-up and every conversation behind it waited forever with the lease
    sitting free."""
    a = _coder(tmp_path)
    ghost = _coder(tmp_path)
    c = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, ghost)
    put_conversation(tmp_path, c)
    await a.start()
    await ghost.start()
    await c.start()
    try:
        await a.start_turn("HANG")
        lease = lease_for(tmp_path)

        # The ghost queues at the lease first...
        with pytest.raises(WireRunnerError):
            await ghost.start_turn("ghost work", send_id="g1")
        # ...then goes away without ever running (stream failure / stop).
        await ghost.stop()

        # C queues behind it with a real queued item.
        with pytest.raises(WireRunnerError) as exc_c:
            await c.start_turn("c work", send_id="c1")
        c.enqueue("c1", "c work", reason="waiting_for_lease", blocked_by=exc_c.value.holder)

        await a.cancel()
        await _await_consumer(a)

        # C must actually run despite the ghost being ahead of it.
        await _wait_for(lambda: c._turn_order != [])
        assert c.queue_summary() == []
        assert c._turns[c._turn_order[0]].send_id == "c1"
        await _await_consumer(c)
        assert lease.holder_of() is None
    finally:
        await a.stop()
        await c.stop()


@pytest.mark.asyncio
async def test_queue_path_without_start_turn_still_gets_woken(tmp_path):
    """Review Critical 4. `/send` reaches the queue WITHOUT calling
    `start_turn` whenever the item is explicitly queued or the runner is
    busy, so nothing registered a waiter and the handoff could never find
    the item. `_maybe_drain_queue`'s declining branch now registers it —
    the same component that owns the queue item owns the FIFO entry."""
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        await a.start_turn("HANG")
        lease = lease_for(tmp_path)

        # B never calls start_turn — this is the explicit-queue path.
        b.enqueue("b1", "b work")
        await b._maybe_drain_queue()

        assert b._turn_order == [], "B must not start while A holds the lease"
        assert b.conversation_id in lease.waiters_snapshot(), (
            "the drain's declining branch must register the waiter, or the "
            "handoff can never reach this item"
        )

        await a.cancel()
        await _await_consumer(a)

        await _wait_for(lambda: b._turn_order != [])
        assert b._turns[b._turn_order[0]].send_id == "b1"
        await _await_consumer(b)
        assert lease.holder_of() is None
    finally:
        await a.stop()
        await b.stop()


@pytest.mark.asyncio
async def test_lease_is_still_held_while_post_turn_bookkeeping_runs(tmp_path, monkeypatch):
    """Review Minor 12. The spec requires the release to land AFTER the
    post-turn bookkeeping (checkpoint_post → journal → fsync), so a
    checkpoint still sees the workspace exclusively its own. That ordering
    was previously asserted only by a comment."""
    a = _coder(tmp_path)
    put_conversation(tmp_path, a)
    await a.start()
    seen: list[str | None] = []

    original = CoderRunner._checkpoint_post

    async def spy(self, state):
        seen.append(lease_for(tmp_path).holder_of())
        return await original(self, state)

    monkeypatch.setattr(CoderRunner, "_checkpoint_post", spy)
    try:
        await a.start_turn("hello")
        await _await_consumer(a)
        assert seen == [a.conversation_id], (
            "the lease must still be held while post-turn bookkeeping runs"
        )
        assert lease_for(tmp_path).holder_of() is None
    finally:
        await a.stop()


@pytest.mark.asyncio
async def test_cancelled_pre_prompt_hook_does_not_leave_the_turn_busy(tmp_path, monkeypatch):
    """Final-review Important. The lease WAS released when `_before_prompt_sent`
    was cancelled, but `self._current` was left at status "running" — so
    `busy` stayed True forever: the conversation was permanently unusable,
    it pinned the machine, and `_maybe_drain_queue` silently declined every
    handoff aimed at it (it early-returns on `busy` without re-registering a
    waiter)."""
    a = _coder(tmp_path)
    put_conversation(tmp_path, a)
    await a.start()
    try:
        entered = asyncio.Event()

        async def hang_in_hook(self, state):
            entered.set()
            await asyncio.sleep(30)

        monkeypatch.setattr(CoderRunner, "_before_prompt_sent", hang_in_hook)

        turn = asyncio.create_task(a.start_turn("hello", send_id="m1"))
        await asyncio.wait_for(entered.wait(), timeout=5.0)
        turn.cancel()
        with pytest.raises(asyncio.CancelledError):
            await turn

        # The workspace must not be wedged...
        assert lease_for(tmp_path).holder_of() is None
        # ...and the conversation must not be permanently busy.
        assert a.busy is False, "a cancelled pre-prompt hook left the turn 'running' forever"
    finally:
        await a.stop()


@pytest.mark.asyncio
async def test_a_failed_start_turn_still_hands_the_lease_to_the_next_waiter(tmp_path, monkeypatch):
    """Final-review residual. Three of the four lease-release sites handed off
    to the next FIFO waiter; `start_turn`'s FAILURE path did not — so a
    conversation queued behind a turn whose start_turn raised (a dead child,
    or a cancellation during the pre-turn git checkpoint) was stranded with a
    queued item and a FIFO slot but no turn-end of its own to trigger a
    drain."""
    a = _coder(tmp_path)
    b = _coder(tmp_path)
    put_conversation(tmp_path, a)
    put_conversation(tmp_path, b)
    await a.start()
    await b.start()
    try:
        # B in exactly the state the system produces for a lease-blocked
        # send: a queued item plus a FIFO slot, waiting to be handed the
        # lease by whoever releases it next.
        lease = lease_for(tmp_path)
        b.enqueue("b1", "b work", reason="waiting_for_lease")
        lease.add_waiter(b.conversation_id)
        assert b.conversation_id in lease.waiters_snapshot()

        # A's start_turn acquires the lease and THEN fails.
        original = CoderRunner._before_prompt_sent

        async def boom(self, state):
            if self is a:
                raise OSError("simulated dead child")
            return await original(self, state)

        monkeypatch.setattr(CoderRunner, "_before_prompt_sent", boom)
        with pytest.raises(OSError):
            await a.start_turn("will fail", send_id="a1")
        monkeypatch.setattr(CoderRunner, "_before_prompt_sent", original)

        # The failed start_turn released the lease — and must ALSO have
        # handed off, or B waits forever with the lease sitting free.
        await _wait_for(lambda: b._turn_order != [])
        assert b._turns[b._turn_order[0]].send_id == "b1"
        await _await_consumer(b)
        assert lease.holder_of() is None
    finally:
        await a.stop()
        await b.stop()
