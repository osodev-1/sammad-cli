"""Machine-side blueprint watcher + event bus for the `/ws` events channel.

Watches ``<workspace>/.sanad`` with watchfiles, bumps a monotonic version on
every change, and fans that version out to subscribed WebSocket clients so the
browser graph refreshes on *external* edits (a PTY-agent write, a `git
checkout`) without waiting for the 4s poll — NF-001.

The bus is passive: it never spawns a PTY and is deliberately kept out of the
idle-stop accounting, so an open graph tab does not keep a machine awake. One
bus per ``.sanad`` path, created lazily (mirrors the per-workspace lock in
``routes_blueprint``); on a one-project-per-machine host there is exactly one.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

from loguru import logger
from watchfiles import awatch


# Our own transaction records and the disposable graph cache live under
# .sanad/.cache — writing them must never trigger a change event (it would make
# every apply echo back a redundant bump).
def _outside_cache(_change: object, path: str) -> bool:
    return ".cache" not in Path(path).parts


class BlueprintEventBus:
    """Watches one ``.sanad`` tree and pushes version bumps to subscribers."""

    def __init__(self, sanad_dir: Path, *, poll_missing_seconds: float = 1.0) -> None:
        self._sanad_dir = sanad_dir
        self._poll_missing = poll_missing_seconds
        self._version = 0
        self._subscribers: set[asyncio.Queue[int]] = set()
        self._task: asyncio.Task[None] | None = None

    @property
    def version(self) -> int:
        return self._version

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[int]]:
        """Yield a queue that receives the new version on every change."""
        queue: asyncio.Queue[int] = asyncio.Queue(maxsize=8)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    def _bump(self) -> None:
        self._version += 1
        for queue in list(self._subscribers):
            # A full queue means a slow client already has a pending
            # notification; the version is monotonic, so dropping this one loses
            # nothing — the next bump (or the client's own poll) carries the
            # latest state.
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(self._version)

    async def _run(self) -> None:
        # `.sanad` may not exist yet (uninitialized blueprint). watchfiles needs
        # an existing path, so wait for the directory, watch until it errors,
        # then wait again — surviving a `rm -rf .sanad` followed by re-init.
        while True:
            if not self._sanad_dir.is_dir():
                await asyncio.sleep(self._poll_missing)
                continue
            try:
                async for _changes in awatch(
                    self._sanad_dir,
                    watch_filter=_outside_cache,
                    recursive=True,
                ):
                    self._bump()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # FileNotFoundError on dir removal, etc.
                logger.debug("blueprint watcher restart ({}): {}", self._sanad_dir, exc)
                await asyncio.sleep(self._poll_missing)


# One bus per .sanad path — created on first subscribe, reused thereafter.
_buses: dict[str, BlueprintEventBus] = {}


def get_bus(sanad_dir: Path) -> BlueprintEventBus:
    key = str(sanad_dir)
    bus = _buses.get(key)
    if bus is None:
        bus = BlueprintEventBus(sanad_dir)
        _buses[key] = bus
        bus.start()
    return bus


async def shutdown_buses() -> None:
    """Stop every watcher (called from the app lifespan on shutdown)."""
    buses = list(_buses.values())
    _buses.clear()
    for bus in buses:
        await bus.stop()
