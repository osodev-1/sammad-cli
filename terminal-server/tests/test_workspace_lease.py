"""Tests for the per-workspace write-lease primitive (P6a Task 1).

The lease is what makes "one conversation mutates at a time" true, and what
lets a revert close P5's TOCTOU by ACQUIRING rather than snapshot-checking.
Two properties carry that weight and are pinned hardest here:

* `try_acquire` is atomic — it contains no `await`, so under asyncio's
  single-threaded scheduling no other coroutine can interleave between its
  "is it free?" check and its "mark it held" write.
* `release` only ever releases for the CURRENT holder, so a late/stale
  release from a finished turn can never hand a live holder's lease away.
"""

from __future__ import annotations

from pathlib import Path

from loguru import logger
from sanad_terminal.workspace_lease import (
    DEFAULT_STALE_AFTER_SECONDS,
    REVERT_HOLDER,
    WriteLease,
    is_revert_holder,
    lease_for,
    new_revert_holder,
)

CID_A = "c_aaaaaaaaaaaa"
CID_B = "c_bbbbbbbbbbbb"


def _lease(ttl: float = 3900.0) -> WriteLease:
    return WriteLease(stale_after_seconds=ttl)


# -- acquire / release ------------------------------------------------------


def test_acquire_when_free_succeeds_and_records_the_holder():
    lease = _lease()
    assert lease.holder_of() is None
    assert lease.try_acquire(CID_A, now=100.0) is True
    assert lease.holder_of() == CID_A
    assert lease.is_held_by(CID_A) is True
    assert lease.is_held_by(CID_B) is False


def test_second_different_holder_is_refused():
    lease = _lease()
    assert lease.try_acquire(CID_A, now=100.0) is True
    assert lease.try_acquire(CID_B, now=101.0) is False
    # The original holder is untouched by the failed attempt.
    assert lease.holder_of() == CID_A


def test_same_holder_reacquire_is_idempotent():
    """A retry by the holder must not deadlock itself."""
    lease = _lease()
    assert lease.try_acquire(CID_A, now=100.0) is True
    assert lease.try_acquire(CID_A, now=150.0) is True
    assert lease.holder_of() == CID_A
    # Re-acquiring does NOT restamp the clock — held_seconds keeps measuring
    # from the original acquire, so the TTL can still catch a wedged holder.
    assert lease.held_seconds(now=200.0) == 100.0


def test_release_by_holder_frees_the_lease():
    lease = _lease()
    lease.try_acquire(CID_A, now=100.0)
    assert lease.release(CID_A) is True
    assert lease.holder_of() is None
    # ...and the next conversation can take it.
    assert lease.try_acquire(CID_B, now=101.0) is True


def test_release_by_non_holder_is_a_noop_and_does_not_free():
    """A late release from a finished turn must never steal a live lease."""
    lease = _lease()
    lease.try_acquire(CID_A, now=100.0)
    assert lease.release(CID_B) is False
    assert lease.holder_of() == CID_A


def test_release_when_unheld_is_a_noop():
    lease = _lease()
    assert lease.release(CID_A) is False
    assert lease.holder_of() is None


def test_revert_holder_sentinel_cannot_collide_with_a_conversation_id():
    """Conversation ids are `c_<12 hex>`; the sentinel is deliberately not."""
    import re

    from sanad_terminal.coder_runner import CONVERSATION_ID_RE

    assert re.fullmatch(CONVERSATION_ID_RE, REVERT_HOLDER) is None
    assert re.fullmatch(CONVERSATION_ID_RE, CID_A) is not None


def test_revert_and_a_conversation_contend_for_the_same_lease():
    lease = _lease()
    assert lease.try_acquire(CID_A, now=100.0) is True
    assert lease.try_acquire(REVERT_HOLDER, now=101.0) is False
    lease.release(CID_A)
    assert lease.try_acquire(REVERT_HOLDER, now=102.0) is True
    assert lease.try_acquire(CID_A, now=103.0) is False


# -- held_seconds -----------------------------------------------------------


def test_held_seconds_is_zero_when_unheld():
    assert _lease().held_seconds(now=100.0) == 0.0


def test_held_seconds_measures_from_acquire():
    lease = _lease()
    lease.try_acquire(CID_A, now=100.0)
    assert lease.held_seconds(now=175.5) == 75.5


# -- TTL / stale reclaim ----------------------------------------------------


def test_stale_lease_is_reclaimable_by_a_new_holder():
    """Backstop for a runner that died holding the lease."""
    lease = _lease(ttl=3900.0)
    lease.try_acquire(CID_A, now=100.0)
    # Not yet stale — still refused.
    assert lease.try_acquire(CID_B, now=100.0 + 3899.0) is False
    # Past the TTL — reclaimable.
    assert lease.try_acquire(CID_B, now=100.0 + 3901.0) is True
    assert lease.holder_of() == CID_B


def test_stale_reclaim_logs_a_warning():
    """It should never happen in normal operation — a reclaim means a
    release leaked, so it must be visible in logs."""
    lines: list[str] = []
    sink_id = logger.add(lines.append, level="WARNING")
    try:
        lease = _lease(ttl=10.0)
        lease.try_acquire(CID_A, now=100.0)
        lines.clear()
        assert lease.try_acquire(CID_B, now=200.0) is True
    finally:
        logger.remove(sink_id)
    assert any(CID_A in line and CID_B in line for line in lines), lines


def test_a_fresh_lease_is_not_treated_as_stale():
    lease = _lease(ttl=10.0)
    lease.try_acquire(CID_A, now=100.0)
    assert lease.try_acquire(CID_B, now=105.0) is False
    assert lease.holder_of() == CID_A


# -- waiters ----------------------------------------------------------------


def test_waiters_preserve_fifo_order():
    lease = _lease()
    lease.add_waiter(CID_A)
    lease.add_waiter(CID_B)
    assert lease.waiters_snapshot() == [CID_A, CID_B]
    assert lease.pop_waiter() == CID_A
    assert lease.pop_waiter() == CID_B
    assert lease.pop_waiter() is None


def test_add_waiter_is_idempotent():
    """A conversation that re-queues must not get two slots."""
    lease = _lease()
    lease.add_waiter(CID_A)
    lease.add_waiter(CID_A)
    assert lease.waiters_snapshot() == [CID_A]


def test_remove_waiter():
    lease = _lease()
    lease.add_waiter(CID_A)
    lease.add_waiter(CID_B)
    lease.remove_waiter(CID_A)
    assert lease.waiters_snapshot() == [CID_B]
    # Removing something absent is a no-op, not an error.
    lease.remove_waiter(CID_A)
    assert lease.waiters_snapshot() == [CID_B]


def test_waiters_snapshot_is_a_copy():
    lease = _lease()
    lease.add_waiter(CID_A)
    snap = lease.waiters_snapshot()
    snap.append(CID_B)
    assert lease.waiters_snapshot() == [CID_A]


# -- registry ---------------------------------------------------------------


def test_lease_for_returns_the_same_instance_per_root(tmp_path: Path):
    root = tmp_path / "ws"
    assert lease_for(root) is lease_for(root)


def test_lease_for_is_distinct_per_root(tmp_path: Path):
    a = lease_for(tmp_path / "ws-a")
    b = lease_for(tmp_path / "ws-b")
    assert a is not b
    a.try_acquire(CID_A, now=100.0)
    assert b.holder_of() is None


def test_lease_for_updates_the_ttl_on_an_existing_lease(tmp_path: Path):
    """`lease_for` is a get-or-create that ALSO accepts an authoritative TTL.

    Settings are request-scoped in this service, so the configured TTL
    arrives from a caller rather than being read here — which means a later
    caller must be able to correct a lease created earlier without one.
    """
    root = tmp_path / "ws"
    first = lease_for(root)
    assert first.stale_after_seconds == DEFAULT_STALE_AFTER_SECONDS
    same = lease_for(root, stale_after_seconds=60.0)
    assert same is first
    assert first.stale_after_seconds == 60.0


def test_lease_for_honours_an_explicit_ttl_at_creation(tmp_path: Path):
    lease = lease_for(tmp_path / "ws-ttl", stale_after_seconds=42.0)
    assert lease.stale_after_seconds == 42.0


def test_ttl_boundary_is_strictly_greater_than(tmp_path: Path):
    """Exactly AT the TTL is not yet stale — "older than", not "at least"."""
    lease = _lease(ttl=10.0)
    lease.try_acquire(CID_A, now=100.0)
    assert lease.try_acquire(CID_B, now=110.0) is False
    assert lease.holder_of() == CID_A
    assert lease.try_acquire(CID_B, now=110.001) is True


# -- P6a final-review regressions -------------------------------------------


def test_two_reverts_cannot_both_hold_the_lease():
    """Final-review Critical. `try_acquire` is re-entrant on identity — right
    for a turn (whose identity is a unique conversation id), but catastrophic
    for a SHARED constant: two concurrent reverts acquiring under the bare
    `REVERT_HOLDER` would BOTH be granted, and the first to finish would free
    the lease while the second was still running `checkout-index`."""
    lease = _lease()
    first = new_revert_holder()
    second = new_revert_holder()
    assert first != second, "each revert must get its own identity"

    assert lease.try_acquire(first, now=100.0) is True
    assert lease.try_acquire(second, now=101.0) is False, (
        "a second concurrent revert must be refused, not re-entrantly granted"
    )

    # And the loser cannot free the winner's lease.
    assert lease.release(second) is False
    assert lease.holder_of() == first
    assert lease.release(first) is True


def test_is_revert_holder_recognises_any_revert_but_no_conversation():
    assert is_revert_holder(new_revert_holder()) is True
    assert is_revert_holder(REVERT_HOLDER) is True
    assert is_revert_holder(CID_A) is False
    assert is_revert_holder(None) is False
