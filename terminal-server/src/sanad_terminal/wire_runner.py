"""Generalized wire-subprocess runner — the server-side bridge for any
`sanad --wire` agent (Architect today, Coder from P0 on).

Owns one JSON-RPC-over-stdio subprocess, serializes turns against it, and
keeps a server-authoritative per-turn journal so a dropped browser never
orphans a turn. Subclasses choose the handshake capabilities and how inbound
`request` frames are handled (the base rejects them — a pure one-way stream).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from loguru import logger

_WIRE_PROTOCOL_VERSION = "1.10"
_INIT_TIMEOUT_SECONDS = 30.0
_TURN_KEEP = 5


class WireRunnerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _preexec(uid: int | None, gid: int | None):  # noqa: ANN202
    def _run() -> None:
        os.setsid()  # own process group → we can signal the whole tree on stop
        if gid is not None:
            os.setgid(gid)
        if uid is not None:
            os.setuid(uid)

    return _run


@dataclass
class TurnState:
    """One turn's journal + lifecycle — the server-side source of truth."""

    turn_id: str
    user_input: str
    status: str = "running"  # running | finished | cancelled | failed
    started_at: float = field(default_factory=time.time)
    send_id: str | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    steps: int = 0
    budget_tripped: bool = False

    @property
    def last_seq(self) -> int:
        return len(self.items) - 1

    def summary(self) -> dict[str, Any]:
        return {
            "turnId": self.turn_id,
            "status": self.status,
            "userInput": self.user_input[:200],
            "lastSeq": self.last_seq,
            "startedAt": self.started_at,
        }


class WireRunner:
    """Owns one wire subprocess and serializes turns against it."""

    def __init__(
        self,
        *,
        argv: Sequence[str],
        cwd: Path,
        env: dict[str, str],
        uid: int | None = None,
        gid: int | None = None,
        client_name: str,
        capabilities: dict[str, bool],
        max_turn_seconds: float | None = None,
        max_steps_per_turn: int | None = None,
    ) -> None:
        self._argv = list(argv)
        self._cwd = cwd
        self._env = env
        self._uid = uid
        self._gid = gid
        self._client_name = client_name
        self._capabilities = dict(capabilities)
        self._max_turn_seconds = max_turn_seconds
        self._max_steps_per_turn = max_steps_per_turn

        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()  # idempotent start
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._turn_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._prompt_id: int | None = None
        self._msg_id = 0
        self._alive = False
        self._last_activity = time.monotonic()
        # Turn journal (server-authoritative; survives client disconnects).
        self._turns: dict[str, TurnState] = {}
        self._turn_order: list[str] = []
        self._current: TurnState | None = None
        self._consumer: asyncio.Task[None] | None = None
        self._budget_task: asyncio.Task[None] | None = None
        self._trip_task: asyncio.Task[None] | None = None
        self._journal_cond = asyncio.Condition()

    # -- lifecycle -----------------------------------------------------------

    @property
    def alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    @property
    def busy(self) -> bool:
        """A turn is in progress — a second ask should be refused, not queued."""
        return self._current is not None and self._current.status == "running"

    @property
    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_activity

    async def start(self) -> None:
        """Spawn (if needed) and complete the initialize handshake. Idempotent."""
        async with self._start_lock:
            if self.alive:
                return
            self._proc = await asyncio.create_subprocess_exec(
                *self._argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                cwd=str(self._cwd),
                env=self._env,
                preexec_fn=_preexec(self._uid, self._gid),
                close_fds=True,
            )
            self._alive = True
            self._reader = asyncio.create_task(self._read_loop())

            iid = self._next_id()
            fut = self._new_pending(iid)
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "method": "initialize",
                    "id": str(iid),
                    "params": {
                        "protocol_version": _WIRE_PROTOCOL_VERSION,
                        "client": {"name": self._client_name, "version": "1"},
                        "capabilities": self._capabilities,
                    },
                }
            )
            try:
                resp = await asyncio.wait_for(fut, timeout=_INIT_TIMEOUT_SECONDS)
            except (TimeoutError, asyncio.CancelledError) as exc:
                await self.stop()
                raise WireRunnerError("init_failed", "agent did not initialize") from exc
            if "error" in resp:
                await self.stop()
                raise WireRunnerError("init_failed", str(resp.get("error")))
            self._touch()

    async def stop(self) -> None:
        self._alive = False
        cur = self._current
        if cur is not None and cur.status == "running":
            cur.status = "failed"
            async with self._journal_cond:
                self._journal_cond.notify_all()
        if self._consumer is not None and not self._consumer.done():
            self._consumer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._consumer
            self._consumer = None
        if self._budget_task is not None and not self._budget_task.done():
            self._budget_task.cancel()
            self._budget_task = None
        if self._trip_task is not None and not self._trip_task.done():
            self._trip_task.cancel()
            self._trip_task = None
        proc = self._proc
        self._proc = None
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader
            self._reader = None
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()

    # -- turns ---------------------------------------------------------------

    async def start_turn(self, user_input: str, send_id: str | None = None) -> TurnState:
        """Begin a turn and return its journal handle. The turn runs to
        completion server-side whether or not anyone follows it.

        Idempotent on ``send_id``: resending the same client message id while
        its turn runs (or after it finished) returns THAT turn instead of
        double-prompting — ambiguous network failures can't duplicate work.
        """
        if not self.alive:
            raise WireRunnerError("not_started", "agent is not running")
        cur = self._current
        if cur is not None and cur.status == "running":
            if send_id and cur.send_id == send_id:
                return cur
            raise WireRunnerError("busy", "a turn is already in progress")
        if send_id and self._turn_order:
            last = self._turns[self._turn_order[-1]]
            if last.send_id == send_id:
                return last

        state = TurnState(
            turn_id=f"t_{uuid.uuid4().hex[:12]}",
            user_input=user_input,
            send_id=send_id,
        )
        self._turns[state.turn_id] = state
        self._turn_order.append(state.turn_id)
        while len(self._turn_order) > _TURN_KEEP:
            oldest = self._turn_order[0]
            if self._turns[oldest].status == "running":
                break
            self._turn_order.pop(0)
            self._turns.pop(oldest, None)
        self._current = state

        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._turn_queue = queue
        pid = self._next_id()
        self._prompt_id = pid
        self._touch()
        await self._append(state, {"kind": "turn", "turnId": state.turn_id})
        try:
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "method": "prompt",
                    "id": str(pid),
                    "params": {"user_input": user_input},
                }
            )
        except Exception:
            state.status = "failed"
            self._turn_queue = None
            self._prompt_id = None
            async with self._journal_cond:
                self._journal_cond.notify_all()
            raise
        self._consumer = asyncio.create_task(self._consume(state, queue))
        if self._max_turn_seconds is not None:
            self._budget_task = asyncio.create_task(
                self._budget_watch(state, self._max_turn_seconds)
            )
        return state

    async def _consume(self, state: TurnState, queue: asyncio.Queue[dict[str, Any]]) -> None:
        """Drain the wire into the journal until turn end — the piece that
        keeps a turn alive with zero browsers attached."""
        try:
            while True:
                item = await queue.get()
                await self._append(state, item)
                kind = item.get("kind")
                if kind == "event":
                    event = item.get("event") or {}
                    if isinstance(event, dict):
                        self.observe_event(event)
                    if isinstance(event, dict) and event.get("type") == "StepBegin":
                        state.steps += 1
                        if (
                            self._max_steps_per_turn is not None
                            and state.steps > self._max_steps_per_turn
                            and not state.budget_tripped
                        ):
                            # Cheap pre-filter only — `_trip_budget` itself is
                            # the atomic check-and-set, so even a burst of
                            # StepBegins that all pass this read before the
                            # first trip task runs still yields exactly one
                            # journaled breach (see `_trip_budget`).
                            self._trip_task = asyncio.create_task(
                                self._trip_budget(
                                    state,
                                    f"turn exceeded {self._max_steps_per_turn} steps",
                                )
                            )
                if kind == "end":
                    status = item.get("status")
                    state.status = (
                        "finished"
                        if status == "finished"
                        else "cancelled"
                        if status == "cancelled"
                        else "failed"
                    )
                    break
                if kind == "error":
                    state.status = "failed"
                    break
        finally:
            if state.status == "running":
                state.status = "failed"
            self._turn_queue = None
            self._prompt_id = None
            if self._budget_task is not None and not self._budget_task.done():
                self._budget_task.cancel()
                self._budget_task = None
            if self._trip_task is not None and not self._trip_task.done():
                self._trip_task.cancel()
                self._trip_task = None
            self._touch()
            # Terminal-status hook (RunRunner only — `_on_finished` doesn't
            # exist on the base/coder runners, so this is a no-op for them):
            # fire exactly once per turn, as a background task so a slow
            # callback (upload + report) never blocks the journal.
            on_finished = getattr(self, "_on_finished", None)
            if on_finished is not None and not getattr(self, "_finished_fired", False):
                self._finished_fired = True
                self._finish_task = asyncio.create_task(on_finished(self))
            async with self._journal_cond:
                self._journal_cond.notify_all()

    async def _budget_watch(self, state: TurnState, limit: float) -> None:
        await asyncio.sleep(limit)
        if state.status == "running" and not state.budget_tripped:
            await self._trip_budget(state, f"turn exceeded {limit:.0f}s wall clock")

    async def _trip_budget(self, state: TurnState, reason: str) -> None:
        """Journal the breach, then cancel — the turn ends `cancelled` with a
        `turn_budget_exceeded` error item explaining why. Idempotent per turn:
        a turn can only trip once, so multiple StepBegins past the threshold
        (or a step/wall-clock race) never double-journal the breach."""
        if state.budget_tripped:
            return
        state.budget_tripped = True
        await self._append(
            state,
            {"kind": "error", "code": "turn_budget_exceeded", "message": reason},
        )
        await self.cancel()

    async def _append(self, state: TurnState, item: dict[str, Any]) -> None:
        state.items.append({"seq": len(state.items), **item})
        async with self._journal_cond:
            self._journal_cond.notify_all()

    def turn_summary(self) -> dict[str, Any] | None:
        """The most recent turn's state — how a reconnecting client learns
        whether its previous job is still working."""
        if not self._turn_order:
            return None
        return self._turns[self._turn_order[-1]].summary()

    def get_turn(self, turn_id: str) -> TurnState | None:
        return self._turns.get(turn_id)

    async def follow(self, turn_id: str, from_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
        """Yield a turn's journal from ``from_seq``, then live until it ends.

        Any number of followers, attaching at any time — a reconnect replays
        the missed window and continues; a finished turn replays and returns.
        """
        state = self._turns.get(turn_id)
        if state is None:
            raise WireRunnerError("unknown_turn", "no such turn")
        i = max(0, from_seq)
        while True:
            while i < len(state.items):
                yield state.items[i]
                i += 1
            if state.status != "running":
                return
            async with self._journal_cond:
                if i >= len(state.items) and state.status == "running":
                    await self._journal_cond.wait()

    async def ask(
        self, user_input: str, send_id: str | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Start a turn and follow it from the beginning (the POST /ask path)."""
        state = await self.start_turn(user_input, send_id)
        async for item in self.follow(state.turn_id, 0):
            yield item

    async def cancel(self) -> None:
        """Interrupt the active turn. The turn's ``end`` (status cancelled)
        still flows to whoever is streaming it."""
        if not self.alive or self._prompt_id is None:
            return
        cid = self._next_id()
        with contextlib.suppress(Exception):
            await self._send({"jsonrpc": "2.0", "method": "cancel", "id": str(cid)})

    # -- io ------------------------------------------------------------------

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def _new_pending(self, msg_id: int) -> asyncio.Future[dict[str, Any]]:
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        return fut

    def _touch(self) -> None:
        self._last_activity = time.monotonic()

    async def _send(self, msg: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise WireRunnerError("not_started", "agent is not running")
        proc.stdin.write(json.dumps(msg).encode("utf-8") + b"\n")
        await proc.stdin.drain()

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        stdout = self._proc.stdout
        try:
            while True:
                line = await stdout.readline()
                if not line:  # EOF: the subprocess exited
                    break
                try:
                    msg = json.loads(line.decode("utf-8", errors="replace"))
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                self._dispatch(msg)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("wire runner read loop error")
        finally:
            self._alive = False
            if self._turn_queue is not None:
                with contextlib.suppress(asyncio.QueueFull):
                    self._turn_queue.put_nowait({"kind": "error", "message": "agent exited"})
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(WireRunnerError("exited", "agent exited"))

    def _dispatch(self, msg: dict[str, Any]) -> None:
        method = msg.get("method")
        if method == "event":
            if self._turn_queue is not None:
                self._turn_queue.put_nowait({"kind": "event", "event": msg.get("params")})
            return
        if method == "request":
            rid = msg.get("id")
            params = msg.get("params")
            if rid is not None:
                asyncio.ensure_future(
                    self._handle_request(rid, params if isinstance(params, dict) else {})
                )
            return
        # Otherwise a response to one of our requests (initialize / prompt / cancel).
        raw_id = msg.get("id")
        if raw_id is None:
            return
        try:
            mid = int(raw_id)
        except (TypeError, ValueError):
            return
        if mid == self._prompt_id and self._turn_queue is not None:
            result = msg.get("result") or {}
            status = result.get("status") if isinstance(result, dict) else None
            self._turn_queue.put_nowait({"kind": "end", "status": status})
            return
        fut = self._pending.pop(mid, None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    def observe_event(self, envelope: dict[str, Any]) -> None:
        """Hook fired for every wire event, after it's journaled. Base: no-op.

        Subclasses (RunRunner) override this to accumulate token usage from
        StatusUpdate events and trip a token budget — a seam rather than a
        base-class field so architect/coder behavior is untouched.
        """

    async def _handle_request(self, rid: Any, params: dict[str, Any]) -> None:
        try:
            handled = await self.on_request(rid, params)
        except Exception:
            logger.exception("on_request hook failed; rejecting")
            handled = False
        if not handled:
            await self._reject(rid)

    async def on_request(self, rid: Any, params: dict[str, Any]) -> bool:
        """Handle an inbound JSON-RPC request. Base: unhandled → reject.

        Async so a subclass can journal/register before returning (P1's
        approvals bridge). Returning False keeps the defensive reject so a
        stray request can never wedge the subprocess.
        """
        return False

    async def _reject(self, rid: Any) -> None:
        with contextlib.suppress(Exception):
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32601, "message": "client does not handle requests"},
                }
            )


# Registries of live runners, one dict per runner module (architect, coder).
# The IdleStopper polls these so an active runner holds the machine open —
# without this, a panel-driven turn with no PTY and no attached browser
# would let the machine idle-stop itself mid-task.
_registries: list[dict[str, Any]] = []


def register_registry(reg: dict[str, Any]) -> None:
    _registries.append(reg)


def runners_hold_machine(grace_seconds: float) -> bool:
    """True if any live runner should keep the machine up: a running turn,
    or recent activity (post-turn grace so a fast follow-up can't race the
    stopper)."""
    for reg in _registries:
        for runner in reg.values():
            if runner.alive and (runner.busy or runner.idle_seconds < grace_seconds):
                return True
    return False
