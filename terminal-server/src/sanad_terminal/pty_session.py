"""One PTY-attached agent process, bridged to asyncio.

An asyncio port of the proven recipe in tests/e2e/shell_pty_helpers.py:
openpty + TIOCSWINSZ on both fds, Popen with a preexec that makes the slave
the controlling tty of a fresh session, non-blocking master reads via
loop.add_reader, and a graceful SIGHUP→SIGTERM→SIGKILL reap.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import errno
import fcntl
import os
import pty
import signal
import struct
import subprocess
import termios
from collections.abc import Callable, Sequence
from pathlib import Path

from loguru import logger

_READ_CHUNK = 65536
# Pause reading the PTY once this many bytes sit unconsumed in the queue; the
# kernel PTY buffer then fills and the agent blocks on write — natural
# backpressure instead of unbounded memory.
_HIGH_WATER = 1 * 1024 * 1024
_LOW_WATER = 256 * 1024
# Recent-output ring kept for reattach: enough to repaint the screen and some
# scrollback after a dropped connection, bounded so detached sessions can't
# grow memory.
_RING_CAP = 256 * 1024


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _preexec_for_tty(
    slave_fd: int, uid: int | None = None, gid: int | None = None
) -> Callable[[], None]:
    def _run() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        # uid split (task mode): agentd runs as root, the agent runs as an
        # unprivileged user, so agentd's env (machine credentials) is
        # unreachable from the user's shell via /proc.
        if gid is not None:
            os.setgid(gid)
        if uid is not None:
            os.setuid(uid)

    return _run


class PtySession:
    """Spawns argv on a PTY and exposes async read/write/resize/terminate."""

    def __init__(
        self,
        *,
        argv: Sequence[str],
        cwd: Path,
        env: dict[str, str],
        cols: int,
        rows: int,
        uid: int | None = None,
        gid: int | None = None,
    ) -> None:
        self._argv = list(argv)
        self._cwd = cwd
        self._env = env
        self._cols = cols
        self._rows = rows
        self._uid = uid
        self._gid = gid
        self._master_fd: int | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._buffered = 0
        self._reader_paused = False
        self._eof = False
        self._ring: collections.deque[bytes] = collections.deque()
        self._ring_bytes = 0
        self.exited = asyncio.Event()

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process else None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        master_fd, slave_fd = pty.openpty()
        _set_winsize(master_fd, self._cols, self._rows)
        _set_winsize(slave_fd, self._cols, self._rows)
        os.set_blocking(master_fd, False)

        def _spawn() -> subprocess.Popen[bytes]:
            return subprocess.Popen(
                self._argv,
                cwd=self._cwd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                env=self._env,
                preexec_fn=_preexec_for_tty(slave_fd, uid=self._uid, gid=self._gid),
                close_fds=True,
            )

        try:
            self._process = await loop.run_in_executor(None, _spawn)
        except Exception:
            os.close(master_fd)
            os.close(slave_fd)
            raise
        os.close(slave_fd)
        self._master_fd = master_fd
        loop.add_reader(master_fd, self._on_readable)

    # -- output ---------------------------------------------------------------

    def _on_readable(self) -> None:
        assert self._master_fd is not None
        try:
            data = os.read(self._master_fd, _READ_CHUNK)
        except BlockingIOError:
            return
        except OSError as exc:
            # EIO = the child side is gone — normal end of stream for a PTY.
            if exc.errno not in (errno.EIO,):
                logger.warning("pty read error: {}", exc)
            self._finish_output()
            return
        if not data:
            self._finish_output()
            return
        # Every chunk lands in the reattach ring at read time — the live queue
        # and the ring are parallel views, so replay-after-attach never
        # duplicates what the resumed stream will deliver.
        self._ring.append(data)
        self._ring_bytes += len(data)
        while self._ring_bytes > _RING_CAP and len(self._ring) > 1:
            dropped = self._ring.popleft()
            self._ring_bytes -= len(dropped)
        self._buffered += len(data)
        self._queue.put_nowait(data)
        if self._buffered >= _HIGH_WATER and not self._reader_paused:
            self._reader_paused = True
            asyncio.get_running_loop().remove_reader(self._master_fd)

    def _finish_output(self) -> None:
        if self._eof:
            return
        self._eof = True
        loop = asyncio.get_running_loop()
        if self._master_fd is not None and not self._reader_paused:
            with contextlib.suppress(ValueError, OSError):
                loop.remove_reader(self._master_fd)
        self._queue.put_nowait(None)
        self.exited.set()

    async def read_output(self) -> bytes | None:
        """Next PTY chunk, or None at end of stream."""
        chunk = await self._queue.get()
        if chunk is None:
            self._queue.put_nowait(None)  # keep EOF sticky for later readers
            return None
        self._buffered -= len(chunk)
        if (
            self._reader_paused
            and self._buffered <= _LOW_WATER
            and self._master_fd is not None
            and not self._eof
        ):
            self._reader_paused = False
            asyncio.get_running_loop().add_reader(self._master_fd, self._on_readable)
        return chunk

    def drain_pending_nowait(self) -> None:
        """Empty the live queue without blocking (chunks are already in the ring).

        Used when finishing an attach: the drainer is stopped, any straggler
        chunks are cleared here, then the ring snapshot is replayed — chunks
        arriving after this point flow only through the queue.
        """
        while True:
            try:
                chunk = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if chunk is None:
                self._queue.put_nowait(None)  # keep EOF sticky
                return
            self._buffered -= len(chunk)
        # An empty queue with a paused reader would deadlock the next
        # read_output — resume the reader now that pressure is gone.
        if self._reader_paused and self._master_fd is not None and not self._eof:
            self._reader_paused = False
            asyncio.get_running_loop().add_reader(self._master_fd, self._on_readable)

    def ring_snapshot(self) -> bytes:
        """Recent output for screen restoration on reattach."""
        return b"".join(self._ring)

    # -- input / control ------------------------------------------------------

    def write_input(self, data: bytes) -> None:
        if self._master_fd is None or self._eof:
            return
        try:
            os.write(self._master_fd, data)
        except BlockingIOError:
            # PTY input buffer full (pathological typing rate) — drop rather
            # than block the event loop; the terminal will feel briefly sticky.
            logger.warning("pty input buffer full; dropping {} bytes", len(data))
        except OSError:
            self._finish_output()

    def resize(self, cols: int, rows: int) -> None:
        if self._master_fd is None or self._eof:
            return
        self._cols, self._rows = cols, rows
        with contextlib.suppress(OSError):
            _set_winsize(self._master_fd, cols, rows)
        # The kernel signals the foreground process group on TIOCSWINSZ, but be
        # explicit — some shells only pick it up via SIGWINCH.
        if self._process and self._process.poll() is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(self._process.pid, signal.SIGWINCH)

    async def wait_exit_code(self) -> int | None:
        if self._process is None:
            return None
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._process.wait)

    async def terminate(self) -> None:
        """Reap the child: SIGHUP → 3s → SIGTERM → 2s → SIGKILL. Idempotent."""
        process = self._process
        if process is not None and process.poll() is None:
            loop = asyncio.get_running_loop()

            def _signal_group(sig: signal.Signals) -> None:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(process.pid, sig)

            for sig, grace in ((signal.SIGHUP, 3.0), (signal.SIGTERM, 2.0)):
                _signal_group(sig)
                try:
                    await asyncio.wait_for(loop.run_in_executor(None, process.wait), timeout=grace)
                    break
                except TimeoutError:
                    continue
            if process.poll() is None:
                _signal_group(signal.SIGKILL)
                await loop.run_in_executor(None, process.wait)

        if self._master_fd is not None:
            fd, self._master_fd = self._master_fd, None
            with contextlib.suppress(ValueError, OSError):
                asyncio.get_running_loop().remove_reader(fd)
            with contextlib.suppress(OSError):
                os.close(fd)
        self._finish_output()
