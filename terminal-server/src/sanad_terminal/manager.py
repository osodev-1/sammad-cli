"""Concurrent terminals per user, capped, evict-oldest.

Each WebSocket connection is its own session (own PTY, own agent process).
A user may hold up to `max_per_user` at once; opening one more evicts their
OLDEST session (error `session_replaced` + close 4409) so a pile of stale tabs
can never lock the user out. Eviction awaits the old PTY's full reap before
the new spawn proceeds, which also serializes same-user startup writes.

Concurrent same-user agents share one KIMI_SHARE_DIR; the config file they
each rewrite at startup is safe because the fork's save_config is atomic
(tmp + os.replace) — last writer wins, never a torn file.
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
    websocket: _WebSocketLike
    started_at: float = field(default_factory=time.monotonic)
    last_input_at: float = field(default_factory=time.monotonic)
    warned_idle: bool = False


class SessionManager:
    def __init__(self, *, max_per_user: int = 3) -> None:
        self._max_per_user = max(1, max_per_user)
        self._sessions: dict[str, ActiveSession] = {}  # conn_id → session
        self._lock = asyncio.Lock()

    @property
    def count(self) -> int:
        return len(self._sessions)

    def count_for(self, user_id: str) -> int:
        return sum(1 for s in self._sessions.values() if s.user_id == user_id)

    async def claim(self, user_id: str) -> None:
        """Make room for one more session for user_id (evict oldest if at cap)."""
        async with self._lock:
            while self.count_for(user_id) >= self._max_per_user:
                oldest = min(
                    (s for s in self._sessions.values() if s.user_id == user_id),
                    key=lambda s: s.started_at,
                )
                del self._sessions[oldest.conn_id]
                logger.info("evicting oldest session for {} (conn {})", user_id, oldest.conn_id)
                with contextlib.suppress(Exception):
                    await oldest.websocket.send_text(error_frame("session_replaced"))
                with contextlib.suppress(Exception):
                    await oldest.websocket.close(code=CLOSE_REPLACED, reason="replaced")
                await oldest.pty.terminate()

    def register(self, session: ActiveSession) -> None:
        self._sessions[session.conn_id] = session

    def unregister(self, session: ActiveSession) -> None:
        # Only remove if this exact session still owns the slot — an eviction
        # may already have removed it.
        if self._sessions.get(session.conn_id) is session:
            del self._sessions[session.conn_id]

    async def shutdown(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for s in sessions:
            with contextlib.suppress(Exception):
                await s.pty.terminate()
