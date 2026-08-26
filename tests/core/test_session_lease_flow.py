"""P6b Task 2: the heartbeat-tick flow, composed from `session_lock.py`
(Task 1's primitive) + `session_lease.py` (Task 2's decision matrix), with
REAL on-disk `owner.json` state — no Shell/WireServer/asyncio-loop machinery
involved.

This is the exact sequence `WireServer._lease_heartbeat_tick` and
`Shell._lease_heartbeat_tick` each run once per beat: `heartbeat()` ->
`decide_heartbeat_action()` -> act. Reproducing it directly against real
disk state proves the REQUIRED brief behaviours — "an idle holder receiving
a steal request stands down and releases", "a BUSY holder receiving a steal
request does NOT detach and clears the request", "the lease is released on
a normal exit" — without needing a full KimiSoul/Runtime/Shell fixture.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kimi_cli.sanad import session_lease as sla
from kimi_cli.sanad import session_lock as sl


@pytest.fixture(autouse=True)
def _locks_on(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SANAD_SESSION_LOCKS", "1")


@pytest.fixture
def session_dir(tmp_path: Path) -> Path:
    d = tmp_path / "session"
    d.mkdir()
    return d


def _tick(session_dir: Path, holder: str, ui_mode: sl.UiMode, *, busy: bool) -> sla.HeartbeatAction:
    """One heartbeat tick — mirrors `_lease_heartbeat_tick` on both sides,
    minus the notification-publish/quit-event/stop-event side effects
    (which are Shell/WireServer-specific UI plumbing, not lease state)."""
    result = sl.heartbeat(session_dir, holder=holder, busy=busy)
    action = sla.decide_heartbeat_action(result, busy=busy)
    if action is sla.HeartbeatAction.REFUSE_STEAL:
        sl.try_acquire(session_dir, holder=holder, ui_mode=ui_mode)
    return action


def test_idle_holder_stands_down_and_releases_on_steal_request(session_dir: Path):
    holder = sla.holder_id("shell")
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode="shell")
    assert acquired.ok
    assert acquired.owner is not None

    taker = sla.holder_id("wire")
    assert sl.request_steal(session_dir, by=taker)

    action = _tick(session_dir, holder, "shell", busy=False)
    assert action is sla.HeartbeatAction.STAND_DOWN

    # The caller (Shell/WireServer) reacts to STAND_DOWN by releasing.
    sl.release(session_dir, holder=holder, generation=acquired.owner.generation)
    assert sl.read_owner(session_dir) is None

    # The taker can now acquire cleanly.
    taken = sl.try_acquire(session_dir, holder=taker, ui_mode="wire")
    assert taken.ok
    assert taken.owner is not None
    assert taken.owner.holder == taker


def test_busy_holder_refuses_steal_and_clears_the_request(session_dir: Path):
    holder = sla.holder_id("wire")
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode="wire")
    assert acquired.ok
    assert acquired.owner is not None
    first_generation = acquired.owner.generation

    taker = sla.holder_id("shell")
    assert sl.request_steal(session_dir, by=taker)

    action = _tick(session_dir, holder, "wire", busy=True)
    assert action is sla.HeartbeatAction.REFUSE_STEAL

    # Still ours — NOT stood down, NOT released.
    owner = sl.read_owner(session_dir)
    assert owner is not None
    assert owner.holder == holder
    # The steal request was cleared so the taker learns it was refused
    # instead of waiting for a detach that will never come.
    assert owner.steal_requested_by is None
    # Self-reacquire bumped the generation (a real disk write happened).
    assert owner.generation > first_generation
    # Minor (review): the mid-turn self-reacquire inside REFUSE_STEAL must
    # PRESERVE `busy` — a self-reacquire is not a fresh grant. Before the
    # fix, `try_acquire` unconditionally reset `busy=False` on every grant,
    # so this refuse-steal write published "idle" to disk for up to a
    # heartbeat while the holder was actively streaming — the owner-status
    # endpoint would report `busy: false` for a genuinely busy holder.
    # NOTHING in this suite asserted this before; it would not have noticed
    # a busy holder publishing itself as idle.
    assert owner.busy is True

    # A second heartbeat with nothing new pending just continues.
    assert _tick(session_dir, holder, "wire", busy=True) is sla.HeartbeatAction.CONTINUE
    assert _tick(session_dir, holder, "wire", busy=False) is sla.HeartbeatAction.CONTINUE


def test_lease_is_released_on_a_normal_exit_with_no_steal_pending(session_dir: Path):
    holder = sla.holder_id("shell")
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode="shell")
    assert acquired.ok
    assert acquired.owner is not None
    assert sl.read_owner(session_dir) is not None

    # A normal exit calls release() directly — no steal, no heartbeat tick
    # needed; this is what `Shell._release_lease` / `WireServer._shutdown`
    # do on every exit path.
    sl.release(session_dir, holder=holder, generation=acquired.owner.generation)

    assert sl.read_owner(session_dir) is None


def test_taken_over_by_a_stale_seizure_stands_down_unconditionally(session_dir: Path):
    """Not a cooperative steal at all: our heartbeat went stale, someone
    else's plain try_acquire seized the (now-stale) lease outright. The next
    time we heartbeat, we must stand down even if we THINK we're busy —
    the other side may already be writing state.json / context.jsonl."""
    holder = sla.holder_id("shell")
    now = 1_000_000.0
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode="shell", now=now)
    assert acquired.ok

    seizer = sla.holder_id("wire")
    later = now + sl.STALE_AFTER_SECONDS + 1
    seized = sl.try_acquire(session_dir, holder=seizer, ui_mode="wire", now=later)
    assert seized.ok
    assert seized.owner is not None
    assert seized.owner.holder == seizer

    result = sl.heartbeat(session_dir, holder=holder, busy=True, now=later + 1)
    assert result.still_ours is False
    assert result.reason == "taken"
    assert sla.decide_heartbeat_action(result, busy=True) is sla.HeartbeatAction.STAND_DOWN


def test_vanished_owner_continues_and_leaves_nothing_to_release(session_dir: Path):
    """Review fix (M11): `owner.json` going missing out from under a live
    holder (corrupt file, external deletion, unreadable) must NOT be
    treated as an eviction — `heartbeat()` reports `reason="vanished"`
    fail-open by design (Task 1), and `decide_heartbeat_action` must
    CONTINUE, never STAND_DOWN, for it. Also pins that nothing is left for
    a caller to release afterward: a `release()` call using the holder we
    "lost" is correctly a no-op (there is genuinely no owner record to
    guard against), since `read_owner` already returns None."""
    holder = sla.holder_id("shell")
    acquired = sl.try_acquire(session_dir, holder=holder, ui_mode="shell")
    assert acquired.ok
    assert acquired.owner is not None

    (session_dir / sl.OWNER_FILE_NAME).unlink()
    assert sl.read_owner(session_dir) is None

    result = sl.heartbeat(session_dir, holder=holder, busy=False)
    assert result.still_ours is False
    assert result.reason == "vanished"
    assert sla.decide_heartbeat_action(result, busy=False) is sla.HeartbeatAction.CONTINUE

    # No release happens on CONTINUE (the caller only releases on
    # STAND_DOWN) — but even if it were called, it's correctly a no-op:
    # there's nothing on disk to protect a successor from.
    sl.release(session_dir, holder=holder, generation=acquired.owner.generation)
    assert sl.read_owner(session_dir) is None

    # A fresh acquire after "vanishing" succeeds cleanly (self-healing on
    # the NEXT deliberate acquire, not inside heartbeat() itself).
    reacquired = sl.try_acquire(session_dir, holder=holder, ui_mode="shell")
    assert reacquired.ok
    assert reacquired.owner is not None
    assert reacquired.owner.generation == 1  # no prior record => counter restarts
