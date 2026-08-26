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
import resource
import time
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

_WIRE_PROTOCOL_VERSION = "1.11"
_INIT_TIMEOUT_SECONDS = 30.0
_TURN_KEEP = 5


class WireRunnerError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        holder: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        # Optional structured payload for `code == "lease_unavailable"`
        # (P6a): the conversation id currently holding the workspace
        # write-lease, so a route can surface "waiting for conversation X"
        # without parsing `message`. `None` for every other error code —
        # every existing raise site omits it, so this is purely additive.
        self.holder = holder
        # P6b: the app-level `error.data` payload from a JSON-RPC error
        # response — populated only when `start()`'s `initialize` handshake
        # is refused with one (today, only the `session_owned` refusal from
        # `kimi_cli.sanad.session_lease.build_session_owned_error`, whose
        # `data` shape is `{"code": "session_owned", "ui_mode": str, "busy":
        # bool}`). `None` for every other error — a timeout, a crash, or any
        # non-dict/data-less error response — so a route can safely do
        # `(exc.data or {}).get("ui_mode")` without a None-check dance.
        self.data = data


def _preexec(
    uid: int | None,
    gid: int | None,
    rlimit_nproc: int = 0,
    rlimit_fsize: int = 0,
):  # noqa: ANN202
    def _run() -> None:
        os.setsid()  # own process group → we can signal the whole tree on stop
        # Ulimits before dropping privilege — uid-split mode only (rlimits on
        # agentd's own root process would be pointless/dangerous). `0` skips
        # a limit; a setrlimit failure (unsupported platform, e.g. macOS dev)
        # must never block spawn.
        if uid is not None:
            if rlimit_nproc > 0:
                with contextlib.suppress(ValueError, OSError):
                    resource.setrlimit(resource.RLIMIT_NPROC, (rlimit_nproc, rlimit_nproc))
            if rlimit_fsize > 0:
                with contextlib.suppress(ValueError, OSError):
                    resource.setrlimit(resource.RLIMIT_FSIZE, (rlimit_fsize, rlimit_fsize))
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
    # running | finished | cancelled | failed | interrupted (a terminal
    # status reached only by construction-time reconciliation, P3 Task 2:
    # a turn still "running" when the durable journal was last written
    # means the process crashed mid-turn).
    status: str = "running"
    started_at: float = field(default_factory=time.time)
    send_id: str | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    steps: int = 0
    budget_tripped: bool = False
    # True once nothing will ever be appended to `items` again — distinct
    # from `status`, which `_consume` flips to a terminal value the MOMENT
    # the wire's `end`/`error` arrives, before a subclass's own `_consume`
    # override finishes ITS post-turn-end work (P5: CoderRunner's
    # checkpoint/journal/queue-drain bookkeeping runs in a finally AFTER
    # `super()._consume()` returns). `follow()` waits on `closed`, not
    # `status`, so a live follower can never race past items a subclass
    # appends after the base class's own bookkeeping. Defaults True: a
    # `TurnState` rebuilt by restart reconstruction (P3 Task 2) represents
    # an already-settled turn with no live consumer task, so a follower
    # must never block on it. `start_turn` explicitly passes `closed=False`
    # for a freshly-started live turn; `_run_turn` flips it back to True
    # exactly once, after the full (possibly overridden) `_consume` chain
    # returns.
    closed: bool = True

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
        rlimit_nproc: int = 0,
        rlimit_fsize: int = 0,
        client_name: str,
        capabilities: dict[str, bool],
        max_turn_seconds: float | None = None,
        max_steps_per_turn: int | None = None,
        journal_sink: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self._argv = list(argv)
        self._cwd = cwd
        self._env = env
        self._uid = uid
        self._gid = gid
        self._rlimit_nproc = rlimit_nproc
        self._rlimit_fsize = rlimit_fsize
        self._client_name = client_name
        self._capabilities = dict(capabilities)
        self._max_turn_seconds = max_turn_seconds
        self._max_steps_per_turn = max_steps_per_turn
        # Durable-journal write sink (P3) — None for the architect and any
        # bare-runner construction; set by CoderRunner when journal_dir is
        # given. Called synchronously from `_append`, wrapped so a sink
        # failure never breaks a live turn (the sink itself already
        # swallows too — belt and suspenders).
        self._journal_sink = journal_sink

        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()  # idempotent start
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._turn_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._prompt_id: int | None = None
        self._msg_id = 0
        self._alive = False
        self._last_activity = time.monotonic()
        self._init_id: int | None = None
        """The `initialize` request's own message id, WHILE the handshake in
        `start()` is outstanding — `None` otherwise. Scopes `_dispatch`'s
        null-id-error fallback (minor, review) to the handshake ONLY: a
        pre-existing, un-gated null-id error (kimi emits these for
        PARSE_ERROR / an invalid request / an invalid response — nothing
        P6b-specific) arriving while exactly one OTHER `call()` happens to
        be outstanding must never be misattributed as that unrelated
        request's answer."""
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

    async def start(self, *, init_timeout: float | None = None) -> None:
        """Spawn (if needed) and complete the initialize handshake. Idempotent.

        `init_timeout` overrides `_INIT_TIMEOUT_SECONDS` for just this call's
        handshake wait. `None` (every pre-P6b call site) keeps the module
        default. P6b's takeover retry (`routes_coder._handle_session_owned`)
        clamps this to whatever remains of its own bounded window, so a
        single final respawn attempt can never blow that window by up to the
        full 30s default on its own.
        """
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
                preexec_fn=_preexec(self._uid, self._gid, self._rlimit_nproc, self._rlimit_fsize),
                close_fds=True,
            )
            self._alive = True
            self._reader = asyncio.create_task(self._read_loop())

            iid = self._next_id()
            fut = self._new_pending(iid)
            # Minor (review): scopes `_dispatch`'s null-id-error fallback to
            # THIS handshake only — cleared in the `finally` below the
            # moment the handshake concludes (success, timeout, OR a
            # `session_owned`-style refusal alike), so a pre-existing,
            # un-gated null-id error arriving later (kimi emits these for
            # PARSE_ERROR / an invalid request / an invalid response) can
            # never be misattributed to some unrelated later `call()` just
            # because it happens to be the only one outstanding at that
            # moment.
            self._init_id = iid
            try:
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
                    resp = await asyncio.wait_for(
                        fut,
                        timeout=init_timeout if init_timeout is not None else _INIT_TIMEOUT_SECONDS,
                    )
                except (TimeoutError, asyncio.CancelledError) as exc:
                    await self.stop()
                    raise WireRunnerError("init_failed", "agent did not initialize") from exc
                if "error" in resp:
                    await self.stop()
                    # P6b: don't collapse every initialize refusal into the
                    # same flat "init_failed" — the child's ONLY channel to
                    # explain a `session_owned` refusal (its stderr is
                    # DEVNULL) is this response's `error.data.code` (an
                    # app-level string discriminator; JSON-RPC's own
                    # `error.code` is required to be an int, so it can't
                    # carry it — see
                    # `kimi_cli.sanad.session_lease.build_session_owned_error`).
                    # When present, THAT becomes this exception's `.code`
                    # (and `.data` carries the rest — `ui_mode`/`busy`) so a
                    # caller like `routes_coder._spawn` can map it to its
                    # own HTTP status instead of every failure flattening
                    # to a 503. Any error without that shape (or a
                    # non-dict `error` at all) falls back to `init_failed`,
                    # exactly as before — a genuine crash/timeout is not,
                    # and must not become, distinguishable from any other
                    # opaque init failure.
                    err = resp.get("error")
                    err_obj = err if isinstance(err, dict) else {}
                    data = err_obj.get("data")
                    data_obj = data if isinstance(data, dict) else None
                    app_code = data_obj.get("code") if data_obj is not None else None
                    # Important 3 (review): only trust the error object's
                    # OWN `message` field when an app-level `data.code` was
                    # actually recovered — the shape
                    # `build_session_owned_error` (and friends) deliberately
                    # emit. Every OTHER initialize error (the ordinary,
                    # un-gated 503 path every route — coder, architect,
                    # worker — already had before P6b) must keep rendering
                    # the WHOLE error dict via `str(err)`, exactly as it
                    # always did; using `.message` unconditionally silently
                    # changed that 503 body across all three routes even
                    # with SANAD_SESSION_LOCKS unset.
                    message = err_obj.get("message") if isinstance(app_code, str) else None
                    raise WireRunnerError(
                        app_code if isinstance(app_code, str) else "init_failed",
                        message if isinstance(message, str) else str(err),
                        data=data_obj,
                    )
                self._touch()
            finally:
                self._init_id = None

    async def stop(self) -> None:
        self._init_id = None
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
            closed=False,
        )
        # `self._current` is the ONLY thing set here, synchronously, before
        # any `await` — it's what the busy-check above reads, so setting it
        # here (and ONLY here, before this coroutine can ever yield) is what
        # makes that check atomic against a second concurrent `start_turn`
        # call: whichever caller's synchronous prefix reaches this line
        # first wins, and the other's own busy-check (which can only run
        # later, since asyncio never preempts mid-coroutine) then sees it.
        #
        # Deliberately NOT registered into `_turns`/`_turn_order` yet (see
        # below) — this turn is not externally discoverable (`/turn`,
        # `get_turn`, `follow`, `busy`-driven `steer`/`cancel`) until its
        # prompt has actually been transmitted.
        self._current = state

        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._turn_queue = queue
        self._touch()
        await self._append(state, {"kind": "turn", "turnId": state.turn_id})
        # Fired once the turn exists (and `self._append` above has given it
        # its first item) but BEFORE the prompt is sent AND before the turn
        # is registered anywhere a client can observe or interact with it.
        # Base: no-op. CoderRunner (P5) hooks this for its PRE-turn
        # checkpoint snapshot, which must represent the workspace tree
        # exactly as it stood before the agent could possibly act on it — a
        # snapshot taken any LATER (once the prompt is in flight, or once
        # this runner's own consumer task exists) can lose that race to a
        # fast-answering agent that doesn't need OUR side's involvement to
        # mutate the workspace (e.g. a non-gated tool call in an
        # accept-edits-like posture).
        #
        # Registering the turn (below) only AFTER the prompt is sent does
        # NOT gate `/steer` or `/cancel` (an earlier version of this comment
        # claimed it did — inaccurate, corrected in final review). Neither
        # reads `_turns`/`_turn_order` at all, so a client's `/steer` or
        # `/cancel` can already reach here in the gap between "turn looks
        # busy" (`self._current` set, above) and "prompt actually
        # transmitted" (`_send` below) — a race that predates this hook.
        # `_before_prompt_sent` (P5's checkpoint snapshot) doesn't create
        # that gap, it WIDENS it, since the prompt now waits on this await
        # too.
        #
        # P6a closes this for real: `cancel()` already gated on
        # `self._prompt_id is None` (still true here — it only holds
        # whatever the PREVIOUS turn left it as until `self._prompt_id =
        # pid` a few lines down), so it was already a safe no-op in this
        # window rather than sending a stray `cancel` for a prompt that was
        # never transmitted; that's unchanged. `CoderRunner.steer()` (the
        # one caller with no equivalent check) now gates on that SAME
        # `self._prompt_id is None` condition too, so a control message can
        # no longer precede the prompt it's meant to steer.
        try:
            await self._before_prompt_sent(state)
        except BaseException:
            # Mirrors the `_send` failure path below. Without this, a
            # CANCELLED hook (the realistic case — P5's pre-turn git
            # checkpoint awaits in here) leaves `self._current` at
            # status "running" forever: `busy` stays True, so the
            # conversation is permanently unusable AND it keeps the
            # machine pinned. `BaseException` on purpose — CancelledError
            # is the whole point and is not an `Exception`.
            state.status = "failed"
            self._turn_queue = None
            raise
        pid = self._next_id()
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
            raise
        self._prompt_id = pid
        self._turns[state.turn_id] = state
        self._turn_order.append(state.turn_id)
        self._evict_old_turns()
        self._consumer = asyncio.create_task(self._run_turn(state, queue))
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

    async def _run_turn(
        self, state: TurnState, queue: asyncio.Queue[dict[str, Any]]
    ) -> None:
        """Wraps `self._consume` (a polymorphic call — runs whatever override
        chain a subclass installs) so `state.closed` flips True only once
        EVERYTHING tied to this turn has actually finished, including a
        subclass's own post-turn-end work in ITS `_consume` finally (P5:
        CoderRunner's checkpoint/journal/queue-drain bookkeeping). `_consume`
        itself flips `status` to a terminal value the moment the wire's
        `end`/`error` arrives — well before that subclass work runs — so
        `follow()` must not treat that early status flip as "nothing more is
        coming." See `TurnState.closed` for the full rationale."""
        try:
            await self._consume(state, queue)
        finally:
            state.closed = True
            async with self._journal_cond:
                self._journal_cond.notify_all()

    def _evict_old_turns(self) -> None:
        """Drop the oldest RAM-cached terminal turns beyond `_TURN_KEEP` —
        shared by `start_turn` (as each new turn is appended) and by
        journal reconstruction on boot (P3 Task 2, which populates several
        turns at once and then applies the same cap in one pass). Never
        evicts a still-`running` turn."""
        while len(self._turn_order) > _TURN_KEEP:
            oldest = self._turn_order[0]
            if self._turns[oldest].status == "running":
                break
            self._turn_order.pop(0)
            self._turns.pop(oldest, None)

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

    def _append_sync(self, state: TurnState, item: dict[str, Any]) -> dict[str, Any]:
        """Synchronous twin of `_append`. Stamps + appends to memory and
        writes through the journal sink exactly like `_append`, but always
        skips the `_journal_cond` notify. Two call sites, both safe to skip
        it, for different reasons:

        - Construction-time journal reconstruction (P3 Task 2's
          `CoderRunner.__init__`) — the ORIGINAL reason this method exists.
          There is no running event loop at all here, so `_append`'s `async
          with self._journal_cond` couldn't be awaited even if it wanted to;
          safe because nothing can be `follow()`ing a turn that doesn't
          exist outside of `__init__` yet.
        - `CoderRunner.enqueue` (P4b), added later — called at RUNTIME,
          under a live event loop, to journal a `{"kind":"queued", ...}`
          marker onto the CURRENT turn as followers may already be
          streaming it. Still safe to skip the notify here: queue depth is
          read through `/turn` (`queue_summary`), never delivered over
          `follow()`'s streamed items, so no waiter is blocked on
          `_journal_cond` for this particular item to wake.
        """
        stamped = {"seq": len(state.items), **item}
        state.items.append(stamped)
        if self._journal_sink is not None:
            try:
                self._journal_sink(state.turn_id, stamped)
            except Exception as exc:  # broad: a sink error must never break construction
                logger.warning(
                    "wire runner: journal sink raised for turn {}: {}", state.turn_id, exc
                )
        return stamped

    async def _append(self, state: TurnState, item: dict[str, Any]) -> None:
        stamped = {"seq": len(state.items), **item}
        state.items.append(stamped)
        async with self._journal_cond:
            self._journal_cond.notify_all()
        if self._journal_sink is not None:
            try:
                self._journal_sink(state.turn_id, stamped)
            except Exception as exc:  # broad: a sink error must never break the turn
                logger.warning(
                    "wire runner: journal sink raised for turn {}: {}", state.turn_id, exc
                )

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
            if state.closed:
                return
            async with self._journal_cond:
                if i >= len(state.items) and not state.closed:
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

    async def call(
        self, method: str, params: dict[str, Any], timeout: float = 10.0
    ) -> dict[str, Any]:
        """Generic request/response round trip — the pending-future machinery
        `initialize` uses, generalized for any standalone JSON-RPC method
        (`set_permission_mode` today). Raises ``WireRunnerError("call_failed", ...)``
        on an error response, a dropped subprocess, or a timeout; never raises
        anything else."""
        if not self.alive:
            raise WireRunnerError("not_started", "agent is not running")
        mid = self._next_id()
        fut = self._new_pending(mid)
        try:
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "method": method,
                    "id": str(mid),
                    "params": params,
                }
            )
        except Exception as exc:
            self._pending.pop(mid, None)
            raise WireRunnerError("call_failed", str(exc)) from exc
        try:
            resp = await asyncio.wait_for(fut, timeout=timeout)
        except (TimeoutError, asyncio.CancelledError) as exc:
            self._pending.pop(mid, None)
            raise WireRunnerError("call_failed", f"{method} timed out") from exc
        except WireRunnerError as exc:
            # `_read_loop`'s finally resolves every pending future with this
            # on subprocess exit — surface it as a call failure, not a crash.
            raise WireRunnerError("call_failed", exc.message) from exc
        if "error" in resp:
            raise WireRunnerError("call_failed", str(resp.get("error")))
        self._touch()
        result = resp.get("result")
        return result if isinstance(result, dict) else {}

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
            # A null id is normally unaddressable and dropped — but
            # `kimi_cli.sanad.session_lease.refuse_wire_initialize` answers
            # THIS way whenever `parse_initialize_request_id` couldn't
            # recover a STRING id from our request (EOF, unparseable JSON,
            # or — the id `_send` gives every request IS a string today,
            # but nothing enforces that staying true — a non-string id).
            # P6b's binding contract (Task 2 review): correlate this to "the
            # error to my `initialize` request", specifically — the SAME
            # child process this handshake ran against, on the SAME
            # connection, is the only one that can ever answer this way.
            # Leaving it to `_read_loop`'s EOF handler (the child exits
            # right after answering this way) would instead resolve that
            # same future with a flat `WireRunnerError("exited", ...)`,
            # discarding the real `session_owned` payload entirely.
            #
            # Minor (review): scoped to `self._init_id` — the handshake's
            # OWN id, set for the duration of `start()` and cleared the
            # moment it concludes — rather than merely "whichever request
            # happens to be the only one outstanding right now". A
            # pre-existing, UN-GATED null-id error (kimi emits these for
            # PARSE_ERROR / an invalid request / an invalid response —
            # nothing P6b-specific) arriving later, while some unrelated
            # `call()` happens to be the sole pending request, must never
            # be misattributed as that call's answer. Restricted to
            # `error` responses (never a bare/malformed message) so this
            # can't misattribute an unrelated null-id message as a false
            # success either.
            if (
                "error" in msg
                and self._init_id is not None
                and len(self._pending) == 1
                and self._init_id in self._pending
            ):
                fut = self._pending.pop(self._init_id, None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
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

    async def _before_prompt_sent(self, state: TurnState) -> None:
        """Hook fired from `start_turn`, once the turn exists but before its
        prompt is sent and before it's registered/discoverable anywhere.
        Base: no-op. See the call site's comment for why this exact moment
        matters and what CoderRunner (P5) uses it for. A subclass hook MUST
        NOT raise for a recoverable failure — CoderRunner's own use catches
        everything internally, since a checkpoint is a safety net, never a
        gate; an exception escaping this hook here would fail the turn
        before its prompt was ever sent."""

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
