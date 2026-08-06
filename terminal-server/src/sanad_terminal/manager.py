"""One live terminal per user, replace semantics.

A stale tab must never lock the user out: a new connection evicts the old one
(error `session_replaced` + close 4409) and only proceeds after the old PTY is
fully reaped — which also serializes same-user access to the unlocked
config.toml the CLI rewrites at startup.
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
    user_id: str
    pty: PtySession
    websocket: _WebSocketLike
    started_at: float = field(default_factory=time.monotonic)
    last_input_at: float = field(default_factory=time.monotonic)
    warned_idle: bool = False


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, ActiveSession] = {}
        self._lock = asyncio.Lock()

    @property
    def count(self) -> int:
        return len(self._sessions)

    def get(self, user_id: str) -> ActiveSession | None:
        return self._sessions.get(user_id)

    async def claim(self, user_id: str) -> None:
        """Evict any existing session for user_id and wait for its full reap."""
        async with self._lock:
            old = self._sessions.pop(user_id, None)
            if old is None:
                return
            logger.info("replacing live session for {}", user_id)
            with contextlib.suppress(Exception):
                await old.websocket.send_text(error_frame("session_replaced"))
            with contextlib.suppress(Exception):
                await old.websocket.close(code=CLOSE_REPLACED, reason="replaced")
            await old.pty.terminate()

    def register(self, session: ActiveSession) -> None:
        self._sessions[session.user_id] = session

    def unregister(self, session: ActiveSession) -> None:
        # Only remove if this exact session is still the registered one — a
        # replacement may already have taken the slot.
        if self._sessions.get(session.user_id) is session:
            del self._sessions[session.user_id]

    async def shutdown(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for s in sessions:
            with contextlib.suppress(Exception):
                await s.pty.terminate()
