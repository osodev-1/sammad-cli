"""P6b: the on-disk session lease — one conversation, one owner.

A kimi session (`context.jsonl` + `state.json` under one session dir) can be
opened by two OS processes today: the browser panel (`sanad --wire --session
<id>`) and a terminal TUI (`sanad run -r <id>`). `state.json` merges only a
few fields on save, so `approval`/`plan_mode`/`todos` get clobbered from
whichever process holds a stale in-memory copy, and `context.jsonl` rotation
(`revert_to`/`clear`) races a concurrent appender. This module is the lease
that makes "one conversation, one owner" true: a small `owner.json` file
recording who currently holds the session, refreshed by heartbeat, released
cleanly, and stealable only cooperatively (the taker marks a request; the
holder notices on its own heartbeat and steps aside — P6b decision 1).

Env-gated exactly like `sanad/activation.py`: `SANAD_SESSION_LOCKS` absent
means every function below no-ops and returns its most permissive result
without touching disk at all, so local CLIs are byte-identical to before
this module existed. The one path that is NOT permissive is a genuine live
foreign owner in `try_acquire` — that is the actual collision this lease
exists to catch.

Everywhere else this fails OPEN: a missing/corrupt/unreadable `owner.json`,
or a write that can't land (full disk, permissions, or a session dir that
doesn't exist yet), is treated as "no owner" rather than raised. A lease bug
that bricks a session is worse than the two-writer collision it is meant to
prevent — contrast the blueprint trust store in `activation.py`, which fails
CLOSED because it guards code execution, not a UI collision. But fail-open
is not fail-SILENT: `try_acquire` and `heartbeat` both report a `persisted`
flag so a caller can tell a genuine grant apart from one that never made it
to disk, rather than the module quietly promising a one-owner guarantee it
didn't actually keep.

No asyncio here, and no I/O beyond the one `owner.json` file — deliberately
no separate lock file and no `flock` on `owner.json` itself either (an
`os.replace`-based atomic write swaps the inode out from under any held file
lock anyway, so it wouldn't help). That means `release` cannot be made fully
atomic against a concurrent successor `try_acquire`; see its docstring for
the guard this module uses instead. Every function that measures time
accepts an injectable `now` so tests never sleep.
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import os
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Literal, cast

from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

OWNER_FILE_NAME = "owner.json"

# How often a holder should call `heartbeat()` while it's alive.
HEARTBEAT_SECONDS = 10.0
# An owner whose heartbeat is older than this is treated as absent.
STALE_AFTER_SECONDS = 30.0

UiMode = Literal["wire", "shell"]
_UI_MODES: frozenset[str] = frozenset(("wire", "shell"))

# Why `heartbeat` reports `still_ours=False`: a live, DIFFERENT holder is on
# record ("taken" — a genuine handoff), or no owner could be read at all
# ("vanished" — missing/corrupt/unreadable file, or an unexpected internal
# failure). See `HeartbeatResult`.
StandDownReason = Literal["taken", "vanished"]


@dataclass(frozen=True, slots=True)
class OwnerInfo:
    """A snapshot of `owner.json` — who currently holds the session lease.

    `generation` is an acquire counter, not a fencing token: it restarts at
    1 after a `release()` (the file is removed), so a later, unrelated
    ownership lineage for the same session can legitimately reuse a
    generation number a stale caller once saw. Only compare `generation`
    against a value read from the SAME unbroken lineage you last observed
    (e.g. `release`'s own `generation` guard below) — never treat it as a
    globally unique token.
    """

    holder: str
    pid: int
    ui_mode: UiMode
    generation: int
    heartbeat_at: float
    steal_requested_by: str | None = None
    busy: bool = False


@dataclass(frozen=True, slots=True)
class AcquireResult:
    """Outcome of `try_acquire`.

    `owner` is the CURRENT owner on refusal (so the caller can say who holds
    it and whether they're busy); it is the newly-granted `OwnerInfo` on
    success, and it is None only when the gate is off.

    `persisted` is False when that grant could NOT be written to disk (full
    disk, permissions, or a session dir that doesn't exist yet — all
    `OSError`s `_write_owner` swallows). The caller is still granted the
    lease — fail-open means a write failure must never brick the session —
    but `persisted=False` means the one-owner guarantee is UNVERIFIED: a
    concurrent acquirer would currently also succeed. Defaults to True so
    the gate-off return (`owner=None`, nothing written by design) and every
    pre-existing call site stay source-compatible.
    """

    ok: bool
    owner: OwnerInfo | None = None
    persisted: bool = True


@dataclass(frozen=True, slots=True)
class HeartbeatResult:
    """Outcome of `heartbeat` — the holder's only signal channel.

    `reason` is set only when `still_ours` is False, and says which of two
    different situations happened — collapsing them would make a holder
    stand down even when nobody actually took the session from it:
      * `"taken"` — a live, DIFFERENT holder is recorded. A real handoff.
      * `"vanished"` — no owner could be read at all (missing, corrupt, or
        unreadable `owner.json`, or an unexpected internal failure). Nobody
        holds the session; a caller may reasonably just re-`try_acquire`
        rather than treating this as an eviction.

    `persisted` is False when `still_ours=True` was reached from disk but
    the refreshed heartbeat itself could not be written back. A caller that
    sees `persisted=False` should treat its own on-disk freshness as
    unverified — another process may see the un-refreshed `heartbeat_at`
    go stale and legitimately take over even though this call "succeeded".
    """

    still_ours: bool
    steal_requested_by: str | None = None
    reason: StandDownReason | None = None
    persisted: bool = True


def locks_enabled() -> bool:
    """Mirrors `activation.py`'s gating idiom: absent => feature is inert."""
    return os.environ.get("SANAD_SESSION_LOCKS") == "1"


def _owner_path(session_dir: Path) -> Path:
    return session_dir / OWNER_FILE_NAME


def _now(now: float | None) -> float:
    return time() if now is None else now


def _owner_from_json(raw: object) -> OwnerInfo | None:
    """Best-effort decode; any shape mismatch is "corrupt" => None."""
    if not isinstance(raw, dict):
        return None
    data = cast("dict[str, object]", raw)

    holder = data.get("holder")
    pid = data.get("pid")
    ui_mode = data.get("ui_mode")
    generation = data.get("generation")
    heartbeat_at = data.get("heartbeat_at")
    steal_requested_by = data.get("steal_requested_by")
    busy = data.get("busy", False)

    if not isinstance(holder, str) or not holder:
        return None
    if not isinstance(pid, int) or isinstance(pid, bool):
        return None
    if not isinstance(ui_mode, str) or ui_mode not in _UI_MODES:
        return None
    if not isinstance(generation, int) or isinstance(generation, bool):
        return None
    if not isinstance(heartbeat_at, (int, float)) or isinstance(heartbeat_at, bool):
        return None
    if steal_requested_by is not None and not isinstance(steal_requested_by, str):
        return None
    if not isinstance(busy, bool):
        return None

    return OwnerInfo(
        holder=holder,
        pid=pid,
        ui_mode=cast("UiMode", ui_mode),
        generation=generation,
        heartbeat_at=float(heartbeat_at),
        steal_requested_by=steal_requested_by,
        busy=busy,
    )


def _write_owner(session_dir: Path, owner: OwnerInfo) -> bool:
    """Atomic write; returns False (never raises) if it couldn't land.

    `OSError` covers more than "disk full": `atomic_json_write`'s
    `tempfile.mkstemp(dir=path.parent, ...)` raises `FileNotFoundError` (an
    `OSError`) if `session_dir` doesn't exist yet, which is an ordinary
    ordering bug for a caller, not just a rare hardware failure — hence
    every caller of this helper threads its bool result into a `persisted`
    flag instead of discarding it.
    """
    try:
        atomic_json_write(dataclasses.asdict(owner), _owner_path(session_dir))
    except OSError:
        logger.debug("Failed to write owner.json under {dir}", dir=session_dir)
        return False
    return True


def read_owner(session_dir: Path) -> OwnerInfo | None:
    """The current owner, or None when absent, corrupt, or gate-off.

    Fails open: an unreadable file, a decode error, or an unexpected shape
    all read as "no owner" rather than raising.
    """
    if not locks_enabled():
        return None

    path = _owner_path(session_dir)
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError:
        return None

    try:
        decoded: object = json.loads(raw_text)
    except ValueError:
        logger.debug("Corrupt owner.json at {path}, treating as unowned", path=path)
        return None

    owner = _owner_from_json(decoded)
    if owner is None:
        logger.debug("Malformed owner.json at {path}, treating as unowned", path=path)
    return owner


def is_live(owner: OwnerInfo, *, now: float | None = None) -> bool:
    """Whether `owner`'s heartbeat is fresh enough to still count as held.

    Deliberately UNGATED — unlike every other function here, this does not
    check `locks_enabled()`. It's pure arithmetic over an already-
    materialized `OwnerInfo` with no I/O and no `session_dir` parameter, so
    there's no disk behavior to gate. In practice it's only ever called
    with an `OwnerInfo` obtained from `read_owner`, which is itself gated.
    """
    return (_now(now) - owner.heartbeat_at) < STALE_AFTER_SECONDS


def try_acquire(
    session_dir: Path,
    *,
    holder: str,
    ui_mode: UiMode,
    now: float | None = None,
) -> AcquireResult:
    """Take the lease for `holder`.

    Grants when the session is free, the recorded owner is stale, or `holder`
    already owns it (re-acquire is idempotent and always bumps `generation`).
    Refuses only when a LIVE, DIFFERENT holder is recorded — that owner is
    returned so the caller can explain who holds it and whether it's busy.

    Gate off => always grants, without ever touching disk (byte-identical to
    a CLI that never linked this module). See `AcquireResult.persisted` for
    what a grant means when the write itself couldn't land.
    """
    if not locks_enabled():
        return AcquireResult(ok=True, owner=None)

    stamp = _now(now)
    current = read_owner(session_dir)

    if current is not None and current.holder != holder and is_live(current, now=stamp):
        return AcquireResult(ok=False, owner=current)

    generation = current.generation + 1 if current is not None else 1
    granted = OwnerInfo(
        holder=holder,
        pid=os.getpid(),
        ui_mode=ui_mode,
        generation=generation,
        heartbeat_at=stamp,
        steal_requested_by=None,
        busy=False,
    )
    # A write that can't land still fails open — the caller is granted the
    # lease in the only sense that matters (the session stays usable); a
    # concurrent acquirer would simply win the next write instead. But we
    # no longer stay silent about it: `persisted=False` tells the caller
    # the one-owner guarantee is unverified right now.
    persisted = _write_owner(session_dir, granted)
    return AcquireResult(ok=True, owner=granted, persisted=persisted)


def request_steal(session_dir: Path, *, by: str, now: float | None = None) -> bool:
    """Ask the current LIVE owner to stand down (cooperative detach).

    Read-modify-atomic-write of `steal_requested_by` only. Returns False when
    there is no live owner to steal from (including gate-off), OR when the
    write itself couldn't land — either way there is nothing recorded for
    the holder's next heartbeat to see, so the caller should treat it as "not
    stolen yet" and may retry.
    """
    if not locks_enabled():
        return False

    stamp = _now(now)
    current = read_owner(session_dir)
    if current is None or not is_live(current, now=stamp):
        return False

    updated = dataclasses.replace(current, steal_requested_by=by)
    return _write_owner(session_dir, updated)


def heartbeat(
    session_dir: Path,
    *,
    holder: str,
    busy: bool,
    now: float | None = None,
) -> HeartbeatResult:
    """Refresh `heartbeat_at`/`busy` for `holder`, if it's still the owner.

    This is the holder's only signal channel, so it must be cheap and must
    NEVER raise: gate-off, a missing session dir, a corrupt file, a write
    that can't land, or any other unexpected failure all resolve to a
    well-formed `HeartbeatResult` rather than an exception. See
    `HeartbeatResult` for what `reason` and `persisted` mean.
    """
    if not locks_enabled():
        return HeartbeatResult(still_ours=True)

    try:
        stamp = _now(now)
        current = read_owner(session_dir)
        if current is None:
            # Nobody is recorded as owner at all — corrupt/missing/unreadable
            # file. NOT the same as "someone else took it": don't conflate
            # the two, or a transient read glitch evicts the legitimate
            # holder from its own conversation (this was I2).
            return HeartbeatResult(still_ours=False, reason="vanished")
        if current.holder != holder:
            return HeartbeatResult(still_ours=False, reason="taken")

        updated = dataclasses.replace(current, heartbeat_at=stamp, busy=busy)
        persisted = _write_owner(session_dir, updated)
        return HeartbeatResult(
            still_ours=True,
            steal_requested_by=current.steal_requested_by,
            persisted=persisted,
        )
    except Exception:  # noqa: BLE001 - this channel must never raise.
        with contextlib.suppress(Exception):
            logger.debug("heartbeat() failed unexpectedly for {dir}", dir=session_dir)
        return HeartbeatResult(still_ours=False, reason="vanished")


def release(session_dir: Path, *, holder: str, generation: int | None = None) -> None:
    """Free the lease, but only if `holder` (and, when given, `generation`)
    matches the currently recorded owner.

    The holder guard alone stops a late release from a taken-over process
    from deleting a successor's lease — but it does NOT stop a stale release
    from the SAME holder id: a reconnecting panel that reuses its view id
    can re-`try_acquire` (bumping `generation`) before its previous
    instance's `release` call lands, and a holder-only check would let that
    stale release tear down the new instance's lease anyway. Pass the
    `generation` your last `try_acquire`/`heartbeat` observed to close that
    window; omitting it falls back to the weaker holder-only check.

    This is still NOT atomic against a concurrent successor `try_acquire`
    landing between this function's read and its unlink — this module is
    deliberately flock-free (see the module docstring), so that narrow
    window remains. Never call `release` from a background task that can
    race the SAME process's own next `try_acquire` for this session; call it
    only from the same synchronous flow that last acquired.
    """
    if not locks_enabled():
        return

    current = read_owner(session_dir)
    if current is None or current.holder != holder:
        return
    if generation is not None and current.generation != generation:
        return

    try:
        _owner_path(session_dir).unlink(missing_ok=True)
    except OSError:
        logger.debug("Failed to remove owner.json under {dir}", dir=session_dir)
