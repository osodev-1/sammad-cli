"""Session registry: capped concurrency, detach/reattach, evict-oldest.

Each WebSocket connection owns one agent session — but the session outlives
the socket. A dropped connection DETACHES: the PTY keeps running, its output
drains into the reattach ring, and a later connection from the same user
ADOPTS the most recently detached session (screen replayed from the ring)
instead of spawning a new agent. Detached sessions are reaped after a grace
window by the sweeper.

A user holds at most `max_per_user` sessions (live + detached). Opening one
more evicts the OLDEST, so stale tabs can never lock the user out. Eviction
awaits the old PTY's full reap before the new spawn proceeds.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from typing import Protocol

from loguru import logger

from sanad_terminal.protocol import CLOSE_REPLACED, error_frame
from sanad_terminal.pty_session import PtySession


class _WebSocketLike(Protocol):
    async def send_text(self, data: str) -> None: ...
    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...


@dataclass
class ActiveSession:
    conn_id: str
    user_id: str
    pty: PtySession
    websocket: _WebSocketLike | None
    # "agent" (the sanad CLI) or "shell" (the drawer). Kinds never mix:
    # adoption, caps and the resume decision are all kind-scoped.
    kind: str = "agent"
    started_at: float = field(default_factory=time.monotonic)
    last_input_at: float = field(default_factory=time.monotonic)
    # A working agent is NOT idle: output counts as activity, so long tasks
    # survive both the idle timeout and the detach grace window.
    last_output_at: float = field(default_factory=time.monotonic)
    warned_idle: bool = False
    detached_at: float | None = None
    drainer: asyncio.Task[None] | None = None

    def last_activity_at(self) -> float:
        return max(self.last_input_at, self.last_output_at)


class SessionManager:
    def __init__(
        self,
        *,
        max_per_user: int = 3,
        detach_grace_seconds: float = 900.0,
        max_session_seconds: float = 14400.0,
        sweep_interval_seconds: float = 15.0,
    ) -> None:
        self._max_per_user = max(1, max_per_user)
        self._detach_grace = detach_grace_seconds
        self._max_session = max_session_seconds
        self._sweep_interval = sweep_interval_seconds
        self._sessions: dict[str, ActiveSession] = {}  # conn_id → session
        self._lock = asyncio.Lock()
        self._sweeper: asyncio.Task[None] | None = None

    # -- lifecycle -------------------------------------------------------------

    def start(self) -> None:
        if self._sweeper is None:
            self._sweeper = asyncio.get_running_loop().create_task(self._sweep_loop())

    async def shutdown(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
            self._sweeper = None
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for s in sessions:
            self._stop_drainer(s)
            with contextlib.suppress(Exception):
                await s.pty.terminate()

    # -- queries ---------------------------------------------------------------

    @property
    def count(self) -> int:
        return len(self._sessions)

    def count_for(self, user_id: str, kind: str | None = None) -> int:
        return sum(
            1
            for s in self._sessions.values()
            if s.user_id == user_id and (kind is None or s.kind == kind)
        )

    @property
    def detached_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.detached_at is not None)

    # -- claim / register ------------------------------------------------------

    # Drawer shells are capped separately from agents so opening the drawer
    # can never evict a working agent (and vice versa).
    SHELL_CAP = 2

    async def claim(self, user_id: str, kind: str = "agent") -> None:
        """Make room for one more session of this kind (evict oldest at cap)."""
        cap = self.SHELL_CAP if kind == "shell" else self._max_per_user
        async with self._lock:
            while self.count_for(user_id, kind) >= cap:
                oldest = min(
                    (
                        s
                        for s in self._sessions.values()
                        if s.user_id == user_id and s.kind == kind
                    ),
                    key=lambda s: s.started_at,
                )
                del self._sessions[oldest.conn_id]
                logger.info("evicting oldest session for {} (conn {})", user_id, oldest.conn_id)
                self._stop_drainer(oldest)
                if oldest.websocket is not None:
                    with contextlib.suppress(Exception):
                        await oldest.websocket.send_text(error_frame("session_replaced"))
                    with contextlib.suppress(Exception):
                        await oldest.websocket.close(code=CLOSE_REPLACED, reason="replaced")
                await oldest.pty.terminate()

    def register(self, session: ActiveSession) -> None:
        self._sessions[session.conn_id] = session

    def unregister(self, session: ActiveSession) -> None:
        if self._sessions.get(session.conn_id) is session:
            del self._sessions[session.conn_id]

    # -- detach / reattach -----------------------------------------------------

    def detach(self, session: ActiveSession) -> None:
        """Socket gone; keep the agent alive and drain its output to the ring."""
        session.websocket = None
        session.detached_at = time.monotonic()

        async def _drain() -> None:
            # Chunks are already ring-buffered at read time; this just keeps
            # the live queue empty so the agent never blocks on backpressure.
            # Output also counts as activity — a detached agent mid-task is
            # not reaped out from under its own work.
            while await session.pty.read_output() is not None:
                session.last_output_at = time.monotonic()

        session.drainer = asyncio.get_running_loop().create_task(_drain())
        logger.info(
            "session detached user={} conn={} (grace {}s)",
            session.user_id,
            session.conn_id,
            int(self._detach_grace),
        )

    async def pop_detached(self, user_id: str, kind: str = "agent") -> ActiveSession | None:
        """Adopt the most recently detached, still-running session of this kind."""
        async with self._lock:
            candidates = sorted(
                (
                    s
                    for s in self._sessions.values()
                    if s.user_id == user_id
                    and s.kind == kind
                    and s.detached_at is not None
                ),
                key=lambda s: s.detached_at or 0.0,
                reverse=True,
            )
            for session in candidates:
                if session.pty.exited.is_set():
                    del self._sessions[session.conn_id]
                    self._stop_drainer(session)
                    with contextlib.suppress(Exception):
                        await session.pty.terminate()
                    continue
                session.detached_at = None
                return session
            return None

    async def finish_attach(self, session: ActiveSession) -> bytes:
        """Stop the drainer and return the replay snapshot for the new socket."""
        self._stop_drainer(session)
        if session.drainer is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await session.drainer
            session.drainer = None
        session.pty.drain_pending_nowait()
        return session.pty.ring_snapshot()

    def _stop_drainer(self, session: ActiveSession) -> None:
        if session.drainer is not None and not session.drainer.done():
            session.drainer.cancel()

    # -- sweeper ---------------------------------------------------------------

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(self._sweep_interval)
            now = time.monotonic()
            doomed: list[ActiveSession] = []
            async with self._lock:
                for session in list(self._sessions.values()):
                    # Grace counts from the LAST SIGN OF LIFE (detach moment or
                    # latest output), so a detached agent still working is kept.
                    quiet_since = (
                        max(session.detached_at, session.last_output_at)
                        if session.detached_at is not None
                        else None
                    )
                    expired_detach = (
                        quiet_since is not None and now - quiet_since > self._detach_grace
                    )
                    dead = session.detached_at is not None and session.pty.exited.is_set()
                    over_lifetime = now - session.started_at > self._max_session
                    if expired_detach or dead or over_lifetime:
                        del self._sessions[session.conn_id]
                        doomed.append(session)
            for session in doomed:
                logger.info(
                    "sweeping session user={} conn={} detached={}",
                    session.user_id,
                    session.conn_id,
                    session.detached_at is not None,
                )
                self._stop_drainer(session)
                if session.websocket is not None:
                    with contextlib.suppress(Exception):
                        await session.websocket.close(code=1000, reason="expired")
                with contextlib.suppress(Exception):
                    await session.pty.terminate()
