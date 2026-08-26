"""P6b Task 2: CLI-side session-lease orchestration.

`session_lock.py` (Task 1, reviewed, NOT modified here) is the on-disk
primitive: `try_acquire` / `heartbeat` / `request_steal` / `release`. This
module holds the policy layer that sits on top of it and has to behave
IDENTICALLY on both sides of the wire/shell split — the pure heartbeat
decision matrix, the holder-id formula, and the exact user-facing shapes
(the wire `initialize` refusal, the shell refusal message, the "taken over"
notification) — so it is unit-testable directly instead of only being
reachable through two different async loops (wire's hand-rolled task, the
shell's `Shell._start_background_task`).

Deliberately separate from `session_lock.py` itself: everything below is
CLI/UI policy (what to say, when to stand down), never a second copy of the
lease's own fail-open/atomicity guarantees.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
import uuid
from enum import Enum
from typing import TYPE_CHECKING, cast

from kimi_cli.utils.logging import logger
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCErrorResponseNullableID,
)
from kimi_cli.wire.types import Notification

if TYPE_CHECKING:
    from kimi_cli.sanad.session_lock import HeartbeatResult, OwnerInfo


def holder_id(ui_mode: str) -> str:
    """A per-process, per-view lease holder id.

    Deterministic in (ui_mode, pid) so the initial `try_acquire` in
    `cli/__init__.py` and the later `heartbeat`/`release` calls inside
    `run_shell`/`run_wire_stdio` (same OS process, same ui mode, called
    later in the same call stack) always agree on who "we" are without
    threading an extra parameter through `KimiCLI.create()`. Two DIFFERENT
    processes can never collide on this value because PIDs are unique among
    concurrently-running processes; a stale PID reused long after this
    process exited is a non-issue because this process will have released
    (or gone stale past `STALE_AFTER_SECONDS`) its lease by then.
    """
    return f"{ui_mode}:{os.getpid()}"


class HeartbeatAction(Enum):
    """What a single heartbeat tick tells the caller to do next."""

    CONTINUE = "continue"
    """Nothing to do — still ours, no steal pending (or the primitive
    couldn't read `owner.json` this tick; see `decide_heartbeat_action`)."""

    STAND_DOWN = "stand_down"
    """Release the lease and exit this view: either we genuinely lost it,
    or a steal was requested while we were idle (cooperative detach)."""

    REFUSE_STEAL = "refuse_steal"
    """A steal was requested but we are mid-turn: do NOT detach. The
    caller must clear the steal request (self-reacquire) so the taker
    learns it was refused instead of hanging."""


def decide_heartbeat_action(result: HeartbeatResult, *, busy: bool) -> HeartbeatAction:
    """Pure decision matrix for one heartbeat tick.

    See `.superpowers/sdd/P6B-DECISIONS.md` decision 1 (cooperative detach)
    and decision 2 (a mid-turn takeover is refused, never queued) for the
    product rationale. This function does no I/O — it only classifies an
    already-obtained `HeartbeatResult`, so the whole matrix can be tested
    directly instead of only through an async loop:

    - `still_ours=False, reason="taken"` — a live, DIFFERENT holder is on
      record. A genuine loss (typically: our own heartbeat went stale for
      >`STALE_AFTER_SECONDS` and someone else's plain `try_acquire` seized
      it — no steal request needed for that). We are a zombie owner now,
      regardless of whether we were mid-turn: STAND_DOWN unconditionally.
    - `still_ours=False, reason="vanished"` — nothing readable (missing,
      corrupt, or unreadable `owner.json`, or an unexpected internal
      failure inside `heartbeat()`). This is fail-open by design, NOT an
      eviction — standing down here would evict a legitimate holder over a
      transient FS error. CONTINUE; the next beat re-establishes.
    - `still_ours=True` and a steal was requested:
        - idle (`busy=False`) — cooperative detach. STAND_DOWN.
        - busy — refuse a mid-turn takeover. REFUSE_STEAL.
    - `still_ours=True`, no steal requested — CONTINUE.
    """
    if not result.still_ours:
        if result.reason == "taken":
            return HeartbeatAction.STAND_DOWN
        return HeartbeatAction.CONTINUE

    if result.steal_requested_by is not None:
        return HeartbeatAction.REFUSE_STEAL if busy else HeartbeatAction.STAND_DOWN

    return HeartbeatAction.CONTINUE


def build_takeover_notification(*, ui_mode: str) -> Notification:
    """The out-of-band notice a stood-down holder publishes on its own
    (in-process) `root_wire_hub` so its own connected view learns why the
    conversation just ended:

    - wire process standing down: `_root_hub_loop` already forwards ANY
      `is_event(msg)` to the connected wire client (agentd -> the browser
      panel) with NO new wire types needed — this is the only channel a
      wire-mode child has to talk to its user (stderr is `DEVNULL`).
    - shell process standing down: `Shell._handle_root_hub_message` gets a
      new `Notification` case (it previously dropped everything but
      Approval*) that renders this via `toast()`.

    `ui_mode` is OUR OWN mode (the one standing down) — the message names
    whichever OTHER view must have taken over.
    """
    other = "the terminal" if ui_mode == "wire" else "the browser panel"
    return Notification(
        id=str(uuid.uuid4()),
        category="system",
        type="session_lease_taken_over",
        source_kind="session_lease",
        source_id=ui_mode,
        title="Session taken over",
        body=f"This conversation was taken over in {other}.",
        severity="warning",
        created_at=time.time(),
    )


def build_shell_refusal_message(owner: OwnerInfo) -> str:
    """The human-readable message printed when a shell (TUI) start is
    refused because `owner` already holds a live lease on this session."""
    other = "the browser panel" if owner.ui_mode == "wire" else "another terminal session"
    state = "busy" if owner.busy else "idle"
    return (
        f"This session is already open in {other} ({state}).\n"
        "A takeover is available from the panel; this terminal cannot open "
        "it until that view releases it or takes it over."
    )


def parse_initialize_request_id(raw_line: bytes) -> str | None:
    """Best-effort extraction of the JSON-RPC request id from a client's
    first line, so the `session_owned` refusal can correlate its response
    even though the CLI intentionally skips ALL real wire-protocol setup —
    `KimiCLI.create()` (and therefore `WireServer`) never runs when the
    lease is refused, so there is no `_dispatch_msg`/`_handle_initialize`
    to do this for us.

    Returns None on anything that isn't a well-formed JSON object with a
    string `"id"` field — EOF (`raw_line == b""`), invalid JSON, or an
    unexpected shape. The caller falls back to a null-id error response in
    that case; it is still valid JSON-RPC and still gets the refusal reason
    across the wire.
    """
    if not raw_line:
        return None
    try:
        decoded: object = json.loads(raw_line.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    if not isinstance(decoded, dict):
        return None
    msg = cast("dict[str, object]", decoded)
    request_id = msg.get("id")
    return request_id if isinstance(request_id, str) else None


def build_session_owned_error(
    owner: OwnerInfo, request_id: str | None
) -> JSONRPCErrorResponse | JSONRPCErrorResponseNullableID:
    """The `initialize` refusal response. Task 3's agentd must learn to
    parse this exact shape.

    `error.code` is the JSON-RPC-level numeric code (`ErrorCodes.
    SESSION_OWNED`, since JSON-RPC's own `code` field is required to be an
    int). `error.data` carries the app-level, machine-readable payload the
    brief asked for::

        {"code": "session_owned", "ui_mode": <str>, "busy": <bool>}

    `ui_mode`/`busy` describe the CURRENT owner (`owner`, the live holder
    that caused the refusal) — NOT this (refused) process.
    """
    error = JSONRPCErrorObject(
        code=ErrorCodes.SESSION_OWNED,
        message=(
            f"Session is owned by another view ({owner.ui_mode}, "
            f"{'busy' if owner.busy else 'idle'})"
        ),
        data={"code": "session_owned", "ui_mode": owner.ui_mode, "busy": owner.busy},
    )
    if request_id is not None:
        return JSONRPCErrorResponse(id=request_id, error=error)
    return JSONRPCErrorResponseNullableID(id=None, error=error)


REFUSE_WIRE_INITIALIZE_READ_TIMEOUT_SECONDS = 5.0
"""How long to wait for the client's first line before giving up and
answering with a null-id error anyway (review fix M6) — without this, a
parent that never sends `initialize` would hang this process forever."""


async def refuse_wire_initialize(owner: OwnerInfo) -> None:
    """Speak just enough wire protocol to refuse a competing agentd child.

    Called BEFORE `KimiCLI.create()` even runs — the CLI already knows the
    session is refused, so there is no `WireServer` yet to answer the
    client's `initialize` handshake normally. agentd's ONLY channel to this
    process is that handshake (its stderr is `DEVNULL`), so this reads the
    client's first line (expected to be `initialize`) and answers with
    `build_session_owned_error`'s response, in the exact wire encoding
    `WireServer._write_loop` itself uses (`model_dump_json() + b"\\n"` on
    stdout), then closes the stream.

    `acp.stdio_streams` and `STDIO_BUFFER_LIMIT` are imported here rather
    than at module level so that a shell-mode refusal (which never calls
    this function) does not pull in `kimi_cli.wire.server`'s much heavier
    dependency chain (soul, approval_runtime, kosong chat providers, ...).

    Best-effort, by construction: this function must NEVER raise. The
    refusal is a courtesy to a client that may have already gone away (a
    `BrokenPipeError`/`ConnectionResetError` from a parent that closed the
    pipe is entirely expected), and `cli/__init__.py` does not wrap this
    call — an exception here previously propagated out of `_run()`
    (review fix Important 2, together with moving `_latest_created_session`'s
    assignment) risking `_reload_loop`'s crash-cleanup path treating a
    session we never actually held as our own to delete.
    """
    import acp  # type: ignore[reportMissingTypeStubs]

    from kimi_cli.wire.server import STDIO_BUFFER_LIMIT

    try:
        reader, writer = await acp.stdio_streams(limit=STDIO_BUFFER_LIMIT)
    except Exception:
        logger.debug("refuse_wire_initialize: could not open stdio streams")
        return

    try:
        raw_line = b""
        with contextlib.suppress(Exception):
            raw_line = await asyncio.wait_for(
                reader.readline(), timeout=REFUSE_WIRE_INITIALIZE_READ_TIMEOUT_SECONDS
            )
        request_id = parse_initialize_request_id(raw_line)
        response = build_session_owned_error(owner, request_id)
        with contextlib.suppress(Exception):
            writer.write(response.model_dump_json().encode("utf-8") + b"\n")
            await writer.drain()
    finally:
        with contextlib.suppress(Exception):
            writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
