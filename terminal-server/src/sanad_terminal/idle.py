"""Task-mode idle stop: when nobody needs this machine, turn it off.

The task's restart policy is "no", so a clean process exit stops the compute
task and billing with it. "Nobody needs it" = zero sessions (live OR detached
— detached sessions carry their own grace and count as needed) AND no
internal/workspace API traffic for `idle_stop_seconds`. The health check path
is excluded from activity so load-balancer probes can never keep a machine
alive forever.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import time

from loguru import logger

from sanad_terminal.manager import SessionManager


class IdleStopper:
    def __init__(
        self,
        manager: SessionManager,
        *,
        idle_stop_seconds: float,
        tick_seconds: float = 15.0,
    ) -> None:
        self._manager = manager
        self._idle_stop = idle_stop_seconds
        self._tick = tick_seconds
        self._last_activity = time.monotonic()
        self._task: asyncio.Task[None] | None = None

    def touch(self) -> None:
        self._last_activity = time.monotonic()

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._tick)
            if self._manager.count > 0:
                self._last_activity = time.monotonic()
                continue
            quiet = time.monotonic() - self._last_activity
            if quiet >= self._idle_stop:
                logger.info("idle for {:.0f}s with zero sessions — stopping the machine", quiet)
                # SIGTERM → uvicorn graceful shutdown → clean exit → task stops.
                os.kill(os.getpid(), signal.SIGTERM)
                return
