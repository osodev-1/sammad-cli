"""The Architect runner — a persistent ``sanad --wire --agent architect``
subprocess that agentd drives over JSON-RPC (stdio) and bridges to the browser.

One runner per workspace. It speaks the CLI's wire protocol: an ``initialize``
handshake, then one ``prompt`` (turn) at a time, streaming the turn's ``event``
frames back to the caller until the prompt response signals turn end. The
architect agent (M3a) has no write tools and we initialize with
``supports_question: false``, so the subprocess never sends a request that
expects a response — the turn is a pure one-way event stream, which is exactly
what a chunked HTTP response needs.

Governance holds by construction: this bridge can start turns and cancel them,
but the agent it runs cannot mutate the blueprint. Applying a drafted change is
a separate, user-driven POST to the transaction endpoint (M2).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from loguru import logger

# The wire protocol version the CLI speaks. Kept as a local constant so agentd
# does not import kimi_cli (they share only the on-the-wire contract).
_WIRE_PROTOCOL_VERSION = "1.10"

# Bound the initialize handshake so a broken subprocess can't hang a request.
_INIT_TIMEOUT_SECONDS = 30.0


def _preexec(uid: int | None, gid: int | None):  # noqa: ANN202
    def _run() -> None:
        os.setsid()  # own process group → we can signal the whole tree on stop
        if gid is not None:
            os.setgid(gid)
        if uid is not None:
            os.setuid(uid)

    return _run


class ArchitectError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ArchitectRunner:
    """Owns one wire subprocess and serializes turns against it."""

    def __init__(
        self,
        *,
        argv: Sequence[str],
        cwd: Path,
        env: dict[str, str],
        uid: int | None = None,
        gid: int | None = None,
    ) -> None:
        self._argv = list(argv)
        self._cwd = cwd
        self._env = env
        self._uid = uid
        self._gid = gid

        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._turn_lock = asyncio.Lock()  # one prompt at a time
        self._start_lock = asyncio.Lock()  # idempotent start
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._turn_queue: asyncio.Queue[dict[str, Any]] | None = None
        self._prompt_id: int | None = None
        self._msg_id = 0
        self._alive = False
        self._last_activity = time.monotonic()

    # -- lifecycle -----------------------------------------------------------

    @property
    def alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    @property
    def busy(self) -> bool:
        """A turn is in progress — a second ask should be refused, not queued."""
        return self._turn_lock.locked()

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
                        "client": {"name": "sanad-architect-bridge", "version": "1"},
                        "capabilities": {
                            "supports_question": False,
                            "supports_plan_mode": False,
                        },
                    },
                }
            )
            try:
                resp = await asyncio.wait_for(fut, timeout=_INIT_TIMEOUT_SECONDS)
            except (TimeoutError, asyncio.CancelledError) as exc:
                await self.stop()
                raise ArchitectError("init_failed", "architect did not initialize") from exc
            if "error" in resp:
                await self.stop()
                raise ArchitectError("init_failed", str(resp.get("error")))
            self._touch()

    async def stop(self) -> None:
        self._alive = False
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

    async def ask(self, user_input: str) -> AsyncIterator[dict[str, Any]]:
        """Run one turn, yielding stream items until (and including) turn end.

        Items are ``{"kind": "event", "event": {type, payload}}`` for each wire
        event, terminated by ``{"kind": "end", "status": ...}`` (or
        ``{"kind": "error", ...}`` if the subprocess dies mid-turn).
        """
        if not self.alive:
            raise ArchitectError("not_started", "architect is not running")
        async with self._turn_lock:
            if not self.alive:
                raise ArchitectError("not_started", "architect is not running")
            self._touch()
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            self._turn_queue = queue
            pid = self._next_id()
            self._prompt_id = pid
            try:
                await self._send(
                    {
                        "jsonrpc": "2.0",
                        "method": "prompt",
                        "id": str(pid),
                        "params": {"user_input": user_input},
                    }
                )
                while True:
                    item = await queue.get()
                    yield item
                    if item["kind"] in ("end", "error"):
                        break
            finally:
                self._turn_queue = None
                self._prompt_id = None
                self._touch()

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
            raise ArchitectError("not_started", "architect is not running")
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
            logger.exception("architect read loop error")
        finally:
            self._alive = False
            if self._turn_queue is not None:
                with contextlib.suppress(asyncio.QueueFull):
                    self._turn_queue.put_nowait({"kind": "error", "message": "architect exited"})
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ArchitectError("exited", "architect exited"))

    def _dispatch(self, msg: dict[str, Any]) -> None:
        method = msg.get("method")
        if method == "event":
            if self._turn_queue is not None:
                self._turn_queue.put_nowait({"kind": "event", "event": msg.get("params")})
            return
        if method == "request":
            # The architect has no write tools and questions are disabled, so no
            # request should ever arrive. Reject defensively so a stray request
            # can never wedge the subprocess waiting on a response.
            rid = msg.get("id")
            if rid is not None:
                asyncio.ensure_future(self._reject(rid))
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

    async def _reject(self, rid: Any) -> None:
        with contextlib.suppress(Exception):
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32601, "message": "client does not handle requests"},
                }
            )


# One runner per workspace root — mirrors the per-workspace lock in
# routes_blueprint. On a one-project-per-machine host there is exactly one.
_runners: dict[str, ArchitectRunner] = {}


def get_runner(root: Path) -> ArchitectRunner | None:
    return _runners.get(str(root))


def put_runner(root: Path, runner: ArchitectRunner) -> None:
    _runners[str(root)] = runner


async def drop_runner(root: Path) -> None:
    runner = _runners.pop(str(root), None)
    if runner is not None:
        await runner.stop()


async def shutdown_runners() -> None:
    runners = list(_runners.values())
    _runners.clear()
    for runner in runners:
        await runner.stop()
