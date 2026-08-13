import asyncio
import fcntl
import struct
import sys
import termios
from pathlib import Path

import pytest
from sanad_terminal.pty_session import PtySession

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="PTYs are POSIX-only")

ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "xterm-256color"}


async def read_until(pty: PtySession, needle: bytes, timeout: float = 10.0) -> bytes:
    buf = b""
    async with asyncio.timeout(timeout):
        while needle not in buf:
            chunk = await pty.read_output()
            if chunk is None:
                raise AssertionError(f"EOF before {needle!r}; got {buf!r}")
            buf += chunk
    return buf


async def test_echo_roundtrip_and_exit(tmp_path: Path):
    pty = PtySession(
        argv=["bash", "-c", "echo READY; exec cat"],
        cwd=tmp_path,
        env=ENV,
        cols=100,
        rows=30,
    )
    await pty.start()
    await read_until(pty, b"READY")

    pty.write_input(b"hello\n")
    await read_until(pty, b"hello")  # cat echoes (plus tty echo)

    await pty.terminate()
    assert pty.exited.is_set()
    # queue drains to EOF
    async with asyncio.timeout(5):
        while await pty.read_output() is not None:
            pass


async def test_resize_reaches_the_child(tmp_path: Path):
    pty = PtySession(
        argv=["bash", "-c", "echo READY; exec cat"],
        cwd=tmp_path,
        env=ENV,
        cols=100,
        rows=30,
    )
    await pty.start()
    await read_until(pty, b"READY")

    pty.resize(150, 50)
    # Verify via TIOCGWINSZ readback on the master side.
    assert pty._master_fd is not None
    packed = fcntl.ioctl(pty._master_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    rows, cols, _, _ = struct.unpack("HHHH", packed)
    assert (cols, rows) == (150, 50)

    await pty.terminate()


async def test_child_exit_sets_event_and_reaps(tmp_path: Path):
    pty = PtySession(
        argv=["bash", "-c", "echo BYE; exit 7"],
        cwd=tmp_path,
        env=ENV,
        cols=80,
        rows=24,
    )
    await pty.start()
    await read_until(pty, b"BYE")
    async with asyncio.timeout(10):
        await pty.exited.wait()
    assert await pty.wait_exit_code() == 7
    await pty.terminate()  # idempotent after natural exit


async def test_terminate_is_idempotent(tmp_path: Path):
    pty = PtySession(
        argv=["bash", "-c", "exec sleep 30"],
        cwd=tmp_path,
        env=ENV,
        cols=80,
        rows=24,
    )
    await pty.start()
    await pty.terminate()
    await pty.terminate()
    assert pty.exited.is_set()
