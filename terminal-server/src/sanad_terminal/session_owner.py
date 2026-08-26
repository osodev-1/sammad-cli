"""agentd's read (and steal-request write) side of the P6b session lease.

`kimi_cli.sanad.session_lock` (Task 1, reviewed) is the CLI-side primitive
that owns `owner.json` end to end: `try_acquire`/`heartbeat`/`release`. This
module is NOT that module imported — `sanad_terminal` has a documented
no-`kimi_cli`-import policy for its own production code (one sanctioned
exception, in `routes_worker.py`; see `pyproject.toml`'s dependency comment),
and `workspace.find_resumable_session` already reimplements the session-dir
digest for the exact same reason. This module reimplements the pieces
agentd needs on top of that same house style:

- `session_dir_for` — the FULL digest rule from
  `kimi_cli.metadata.WorkDirMeta.sessions_dir`, including the kaos-prefix
  branch `find_resumable_session` has always omitted (agentd only ever
  spawns the CLI locally, so that branch was never exercised — but a
  reimplementation that quietly drops half the rule is a fidelity gap
  waiting to bite the day agentd ever runs against a non-local kaos).
- `read_owner`/`is_live` — mirror `session_lock`'s own reader exactly
  (same field shape, same 30s staleness math), so agentd can tell a caller
  who currently holds a conversation without ever touching `kimi_cli`.
- `request_steal` — the SAME read-modify-atomic-write `session_lock.
  request_steal` performs. agentd is not a privileged writer here: it is
  just another participant in the cooperative-detach protocol every
  holder's own heartbeat already writes through, so this adds no new
  hazard class beyond the one `session_lock`'s own docstring already
  documents and tolerates (a steal request landing in the narrow window
  between a heartbeat's read and its own write can be lost to that write —
  self-healing on the NEXT heartbeat tick, ~10s later, since that tick's
  read now sees it).

See `tests/test_session_owner.py` for the parity tests pinning this
reimplementation against the real `kimi_cli` shapes it mirrors — the
insurance that a future drift between the two trees is loud, not silent.

UNLIKE `session_lock.py`, nothing here self-gates on `SANAD_SESSION_LOCKS`:
every function is a plain, always-available I/O helper, and the caller (
`routes_coder.py`, `workspace.find_resumable_session`) decides whether to
call into it at all, based on `TerminalSettings.session_locks_enabled`. That
keeps the gate a single settings-driven decision instead of two independent
env-var reads that could disagree, and it is what makes "gate off ⇒
behaviour identical to today" simple to prove: the call sites just never
reach this module when the gate is off.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Literal, cast

LOCAL_KAOS_NAME = "local"
"""Mirrors `kaos.local.local_kaos.name` — the sentinel `WorkDirMeta.
sessions_dir` compares against to decide there is NO kaos prefix. agentd
always spawns the CLI on its own machine, so every real call site here
passes the default; `session_dir_for`'s `kaos` parameter exists so the
parity test can exercise the prefixed branch too."""

OWNER_FILE_NAME = "owner.json"

# Mirrors `kimi_cli.sanad.session_lock.STALE_AFTER_SECONDS` exactly — pinned
# by the parity test. Duplicated, not imported (see module docstring).
STALE_AFTER_SECONDS = 30.0

UiMode = Literal["wire", "shell"]
_UI_MODES: frozenset[str] = frozenset(("wire", "shell"))


def session_dir_for(
    kimi_share: Path, workspace: Path, session_id: str, *, kaos: str = LOCAL_KAOS_NAME
) -> Path:
    """`<kimi_share>/sessions/<dir_basename>/<session_id>` — the FULL digest
    rule from `kimi_cli.metadata.WorkDirMeta.sessions_dir`:
    `dir_basename` is `md5(str(workspace path))` when `kaos` is the LOCAL
    kaos, else `f"{kaos}_{md5(...)}"`. `workspace.find_resumable_session`'s
    own digest has always hashed only the local (unprefixed) form; this is
    the same formula, generalized to the branch it omitted.
    """
    path_md5 = hashlib.md5(str(workspace.resolve()).encode("utf-8")).hexdigest()
    dir_basename = path_md5 if kaos == LOCAL_KAOS_NAME else f"{kaos}_{path_md5}"
    return kimi_share / "sessions" / dir_basename / session_id


@dataclass(frozen=True, slots=True)
class OwnerInfo:
    """A snapshot of `owner.json` — mirrors `kimi_cli.sanad.session_lock.
    OwnerInfo` field-for-field (see the parity test). `generation` and `pid`
    are read for completeness/future use; agentd's own logic today only
    ever consults `ui_mode`, `busy`, `steal_requested_by`, and liveness."""

    holder: str
    pid: int
    ui_mode: UiMode
    generation: int
    heartbeat_at: float
    steal_requested_by: str | None = None
    busy: bool = False


def _owner_path(session_dir: Path) -> Path:
    return session_dir / OWNER_FILE_NAME


def _now(now: float | None) -> float:
    return time() if now is None else now


def _owner_from_json(raw: object) -> OwnerInfo | None:
    """Best-effort decode; any shape mismatch is "corrupt" => None — mirrors
    `session_lock._owner_from_json` exactly, field validation included."""
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


def read_owner(session_dir: Path) -> OwnerInfo | None:
    """The current owner, or None when absent, corrupt, or unreadable.

    Fails open, exactly like `session_lock.read_owner`: a missing file, a
    permissions error, a decode error, or an unexpected shape all read as
    "no owner" rather than raising. Ungated — see the module docstring for
    why the gate lives at the call site instead of here.
    """
    path = _owner_path(session_dir)
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        decoded: object = json.loads(raw_text)
    except ValueError:
        return None
    return _owner_from_json(decoded)


def is_live(owner: OwnerInfo, *, now: float | None = None) -> bool:
    """Whether `owner`'s heartbeat is fresh enough to still count as held.
    Pure arithmetic, no I/O — mirrors `session_lock.is_live` exactly."""
    return (_now(now) - owner.heartbeat_at) < STALE_AFTER_SECONDS


def _write_owner(session_dir: Path, owner: OwnerInfo) -> bool:
    """Atomic (tmp + os.replace) write; returns False (never raises) if it
    couldn't land — same discipline as `kimi_cli.utils.io.atomic_json_write`,
    reimplemented rather than imported (see module docstring)."""
    try:
        fd, tmp_path = tempfile.mkstemp(dir=session_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(dataclasses.asdict(owner), f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, _owner_path(session_dir))
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
            raise
    except OSError:
        return False
    return True


def request_steal(session_dir: Path, *, by: str, now: float | None = None) -> bool:
    """Ask the current LIVE owner to stand down (cooperative detach) — the
    same read-modify-atomic-write `session_lock.request_steal` performs;
    see the module docstring for why a write from agentd is safe here.
    Returns False when there is no live owner to steal from, or when the
    write itself couldn't land — either way nothing was recorded for the
    holder's next heartbeat to see, so the caller should treat it as "not
    stolen yet."""
    stamp = _now(now)
    current = read_owner(session_dir)
    if current is None or not is_live(current, now=stamp):
        return False
    updated = dataclasses.replace(current, steal_requested_by=by)
    return _write_owner(session_dir, updated)
