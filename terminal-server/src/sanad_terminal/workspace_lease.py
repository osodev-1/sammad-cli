"""Per-workspace WRITE-LEASE — one conversation mutates at a time (P6a).

`workspace_locks.lock_for` (P5) is a bare `asyncio.Lock` and stays exactly
what it is: the blueprint-family mutex, taken and released inside a single
request handler. It cannot be the write-lease, for three reasons:

* it has no holder identity — nothing can ask "who holds it, and since
  when?", which the queue-at-the-lease UX and the `/turn` readout need;
* the coroutine that acquires it must be the one that releases it, whereas
  a write-lease is acquired when a turn STARTS and released when that turn
  ENDS, minutes later, across many separate HTTP requests;
* it has no reclaim path, so a runner that dies holding it would wedge the
  workspace permanently.

So this module adds a small ownership object instead. agentd is
single-replica (an explicit spec non-goal), so — like the sibling
`_conversations` and `_locks` registries — it lives in RAM, with no disk
and no cross-process concerns.

THE ATOMICITY THAT MATTERS: `try_acquire` contains no `await`. Under
asyncio's single-threaded scheduling that makes it genuinely atomic — no
other coroutine can interleave between its "is it free?" read and its
"mark it held" write. This is the same gapless-check-then-set discipline
`WireRunner.start_turn` already relies on for `busy`, and it is what lets
P5's revert close its TOCTOU: the revert ACQUIRES the lease rather than
snapshot-checking `busy` and then locking as a separate step.
"""

from __future__ import annotations

import time
from collections import deque
from pathlib import Path
from typing import Final
from uuid import uuid4

from loguru import logger

# The holder a revert takes the lease under. Conversation ids are minted as
# `c_<12 hex>` (`coder_runner.CONVERSATION_ID_RE`), so this sentinel can
# never collide with a real conversation.
REVERT_HOLDER: Final[str] = "__revert__"


def new_revert_holder() -> str:
    """A UNIQUE holder identity for one revert.

    `try_acquire` is deliberately re-entrant: a holder that retries must not
    deadlock against its own lease. That is right for a turn, whose holder
    identity is a unique conversation id — but it is DANGEROUS for a shared
    constant. Two concurrent reverts acquiring under the bare
    `REVERT_HOLDER` would BOTH be told they hold it (identity match →
    re-entrant True), and then the first one's `finally` would free the
    lease while the second was still running `checkout-index` — re-opening
    the exact restore-vs-live-writer race this phase exists to close.

    So every revert gets its own identity, and only the revert that
    actually acquired can release it (`release` is holder-guarded). Use
    `is_revert_holder` to recognise one, never `== REVERT_HOLDER`.
    """
    return f"{REVERT_HOLDER}:{uuid4().hex[:12]}"


def is_revert_holder(holder: str | None) -> bool:
    """True when `holder` is a revert (any revert), not a conversation."""
    return holder is not None and holder.split(":", 1)[0] == REVERT_HOLDER


class WriteLease:
    """Ownership of one workspace's mutating work.

    Held by a conversation id for the duration of one turn, or by
    `REVERT_HOLDER` for the duration of a revert. Everything here is
    synchronous and await-free on purpose — see the module docstring.
    """

    def __init__(self, *, stale_after_seconds: float) -> None:
        self.stale_after_seconds = stale_after_seconds
        self._holder: str | None = None
        self._acquired_at: float = 0.0
        # Conversations queued at the lease, oldest first, so a release can
        # hand off in arrival order instead of whoever wakes up first.
        self._waiters: deque[str] = deque()

    # -- acquire / release --------------------------------------------------

    def try_acquire(self, holder: str, *, now: float | None = None) -> bool:
        """Take the lease for `holder`. Atomic: contains no `await`.

        Returns True if `holder` holds the lease when this returns — which
        includes the re-entrant case where it already did, so a retry can
        never deadlock itself against its own lease.
        """
        stamp = time.monotonic() if now is None else now

        if self._holder is None:
            self._grant(holder, stamp)
            return True

        if self._holder == holder:
            # Already ours. Deliberately does NOT restamp `_acquired_at`:
            # the TTL keeps measuring from the original acquire, so a
            # wedged holder that retries can still be reclaimed.
            return True

        if stamp - self._acquired_at > self.stale_after_seconds:
            # Should be unreachable in normal operation: every acquire has a
            # release on every exit path. Getting here means a release
            # leaked, so say so loudly rather than silently papering over it.
            logger.warning(
                "write-lease reclaimed from stale holder {} after {:.0f}s "
                "(ttl {:.0f}s) for {} — a release leaked",
                self._holder,
                stamp - self._acquired_at,
                self.stale_after_seconds,
                holder,
            )
            self._grant(holder, stamp)
            return True

        return False

    def release(self, holder: str) -> bool:
        """Release, but only if `holder` currently holds it.

        A release from anyone else is a no-op returning False. That guard is
        load-bearing: a late release from an already-finished turn must
        never hand away a lease a different conversation now legitimately
        holds.
        """
        if self._holder != holder:
            return False
        self._holder = None
        self._acquired_at = 0.0
        return True

    def _grant(self, holder: str, stamp: float) -> None:
        self._holder = holder
        self._acquired_at = stamp
        # Holding and waiting are mutually exclusive states.
        self.remove_waiter(holder)

    # -- readout ------------------------------------------------------------

    def holder_of(self) -> str | None:
        return self._holder

    def is_held_by(self, holder: str) -> bool:
        return self._holder == holder

    def held_seconds(self, *, now: float | None = None) -> float:
        if self._holder is None:
            return 0.0
        stamp = time.monotonic() if now is None else now
        return stamp - self._acquired_at

    # -- waiters ------------------------------------------------------------

    def add_waiter(self, holder: str) -> None:
        """Queue `holder` at the lease. Idempotent — a conversation that
        re-queues must not end up with two slots in the handoff order."""
        if holder not in self._waiters:
            self._waiters.append(holder)

    def pop_waiter(self) -> str | None:
        return self._waiters.popleft() if self._waiters else None

    def remove_waiter(self, holder: str) -> None:
        if holder in self._waiters:
            self._waiters.remove(holder)

    def waiters_snapshot(self) -> list[str]:
        return list(self._waiters)


# One lease per workspace root, mirroring `workspace_locks._locks`.
_leases: dict[str, WriteLease] = {}

# Matches `TerminalSettings.coder_write_lease_ttl_seconds`. Only a fallback:
# callers that hold settings pass the configured value, which wins.
DEFAULT_STALE_AFTER_SECONDS: Final[float] = 3900.0


def lease_for(root: Path, *, stale_after_seconds: float | None = None) -> WriteLease:
    """The lease for `root`, created on first use.

    Settings are request-scoped in this service, so the TTL is passed in by
    callers that have them rather than re-read from the environment here
    (that would be a hidden dependency and a circular import). Passing it
    updates the TTL on an existing lease too, so whoever holds settings is
    always authoritative; omitting it falls back to the module default.
    """
    key = str(root)
    lease = _leases.get(key)
    if lease is None:
        lease = WriteLease(
            stale_after_seconds=(
                DEFAULT_STALE_AFTER_SECONDS
                if stale_after_seconds is None
                else stale_after_seconds
            )
        )
        _leases[key] = lease
    elif stale_after_seconds is not None:
        lease.stale_after_seconds = stale_after_seconds
    return lease
