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
or a write that can't land (full disk, permissions), is treated as "no
owner" rather than raised. A lease bug that bricks a session is worse than
the two-writer collision it is meant to prevent — contrast the blueprint
trust store in `activation.py`, which fails CLOSED because it guards code
execution, not a UI collision.

No asyncio here, and no I/O beyond the one `owner.json` file. Every function
that measures time accepts an injectable `now` so tests never sleep.
"""

from __future__ import annotations

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


@dataclass(frozen=True, slots=True)
class OwnerInfo:
    """A snapshot of `owner.json` — who currently holds the session lease."""

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
    """

    ok: bool
    owner: OwnerInfo | None = None


@dataclass(frozen=True, slots=True)
class HeartbeatResult:
    """Outcome of `heartbeat` — the holder's only signal channel."""

    still_ours: bool
    steal_requested_by: str | None = None


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
    """Atomic write; returns False (never raises) if it couldn't land."""
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
    """Whether `owner`'s heartbeat is fresh enough to still count as held."""
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
    a CLI that never linked this module).
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
    # concurrent acquirer would simply win the next write instead.
    _write_owner(session_dir, granted)
    return AcquireResult(ok=True, owner=granted)


def request_steal(session_dir: Path, *, by: str, now: float | None = None) -> bool:
    """Ask the current LIVE owner to stand down (cooperative detach).

    Read-modify-atomic-write of `steal_requested_by` only. Returns False when
    there is no live owner to steal from (including gate-off) — the caller
    should just call `try_acquire` instead.
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
    NEVER raise: gate-off, a missing session dir, a corrupt file, or a write
    that can't land all resolve to a well-formed `HeartbeatResult` rather
    than an exception.
    """
    if not locks_enabled():
        return HeartbeatResult(still_ours=True, steal_requested_by=None)

    try:
        stamp = _now(now)
        current = read_owner(session_dir)
        if current is None or current.holder != holder:
            return HeartbeatResult(still_ours=False, steal_requested_by=None)

        updated = dataclasses.replace(current, heartbeat_at=stamp, busy=busy)
        _write_owner(session_dir, updated)
        return HeartbeatResult(still_ours=True, steal_requested_by=current.steal_requested_by)
    except Exception:  # noqa: BLE001 - this channel must never raise.
        logger.debug("heartbeat() failed unexpectedly for {dir}", dir=session_dir)
        return HeartbeatResult(still_ours=False, steal_requested_by=None)


def release(session_dir: Path, *, holder: str) -> None:
    """Free the lease, but only if `holder` currently holds it.

    A release from a non-holder (e.g. a late release racing a successor's
    acquire) is a no-op — it must never delete a successor's lease. Gate off
    is also a no-op, and a missing/already-clear file is treated as already
    released.
    """
    if not locks_enabled():
        return

    current = read_owner(session_dir)
    if current is None or current.holder != holder:
        return

    try:
        _owner_path(session_dir).unlink(missing_ok=True)
    except OSError:
        logger.debug("Failed to remove owner.json under {dir}", dir=session_dir)
