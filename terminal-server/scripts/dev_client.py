"""Raw-mode WS client for testing the terminal loop without a frontend.

Usage:
    uv run python terminal-server/scripts/dev_client.py \
        --url ws://localhost:8080/ws --ticket tt_...

Bridges this terminal's stdin/stdout to the remote PTY: binary frames both
ways, control frames printed to stderr, resize forwarded on SIGWINCH.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import shutil
import signal
import sys
import termios
import tty

import websockets


async def run(url: str, ticket: str) -> int:
    size = shutil.get_terminal_size()
    async with websockets.connect(url, max_size=2**22) as ws:
        await ws.send(
            json.dumps({"type": "auth", "ticket": ticket, "cols": size.columns, "rows": size.lines})
        )

        loop = asyncio.get_running_loop()

        def on_winch() -> None:
            s = shutil.get_terminal_size()
            asyncio.ensure_future(
                ws.send(json.dumps({"type": "resize", "cols": s.columns, "rows": s.lines}))
            )

        loop.add_signal_handler(signal.SIGWINCH, on_winch)

        async def stdin_pump() -> None:
            stdin_fd = sys.stdin.fileno()
            reader = asyncio.StreamReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            await loop.connect_read_pipe(lambda: protocol, os.fdopen(stdin_fd, "rb", 0))
            while True:
                data = await reader.read(4096)
                if not data:
                    return
                await ws.send(data)

        async def ws_pump() -> int:
            async for message in ws:
                if isinstance(message, bytes):
                    sys.stdout.buffer.write(message)
                    sys.stdout.buffer.flush()
                else:
                    control = json.loads(message)
                    print(f"\r\n[control] {control}", file=sys.stderr)
                    if control.get("type") == "exit":
                        return int(control.get("code") or 0)
            return 0

        stdin_task = asyncio.create_task(stdin_pump())
        try:
            return await ws_pump()
        finally:
            stdin_task.cancel()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://localhost:8080/ws")
    parser.add_argument("--ticket", required=True)
    args = parser.parse_args()

    stdin_fd = sys.stdin.fileno()
    saved = termios.tcgetattr(stdin_fd)
    tty.setraw(stdin_fd)
    try:
        code = asyncio.run(run(args.url, args.ticket))
    finally:
        termios.tcsetattr(stdin_fd, termios.TCSADRAIN, saved)
    with contextlib.suppress(Exception):
        print(f"\n[dev_client] exited with code {code}", file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
