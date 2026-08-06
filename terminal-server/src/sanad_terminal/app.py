"""FastAPI application: /healthz + the /ws PTY bridge."""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from loguru import logger

from sanad_terminal.control_plane import ControlPlaneClient, ControlPlaneError
from sanad_terminal.manager import ActiveSession, SessionManager
from sanad_terminal.protocol import (
    CLOSE_AUTH,
    CLOSE_AUTH_TIMEOUT,
    CLOSE_EXPIRED,
    CLOSE_IDLE,
    CLOSE_INTERNAL,
    CLOSE_LIFETIME,
    CLOSE_NORMAL,
    CLOSE_PROTOCOL,
    AuthFrame,
    PingFrame,
    ProtocolError,
    ResizeFrame,
    clamp_size,
    error_frame,
    exit_frame,
    parse_client_frame,
    pong_frame,
    ready_frame,
    warning_frame,
)
from sanad_terminal.pty_session import PtySession
from sanad_terminal.settings import TerminalSettings
from sanad_terminal.workspace import (
    build_child_env,
    has_previous_session,
    prepare_user_dirs,
)

_WATCHDOG_TICK_SECONDS = 15.0


def create_app(
    settings: TerminalSettings | None = None,
    control_plane: ControlPlaneClient | None = None,
) -> FastAPI:
    resolved = settings or TerminalSettings.load()
    cp = control_plane or ControlPlaneClient(resolved.control_plane_url, resolved.shared_secret)
    manager = SessionManager(
        max_per_user=resolved.max_sessions_per_user,
        detach_grace_seconds=resolved.detach_grace_seconds,
        max_session_seconds=resolved.max_session_seconds,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        manager.start()
        yield
        await manager.shutdown()
        await cp.aclose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = resolved
    app.state.control_plane = cp
    app.state.manager = manager

    from sanad_terminal.routes_workspace import register_error_handlers, router

    app.include_router(router)
    register_error_handlers(app)

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {
            "status": "ok",
            "activeSessions": manager.count,
            "detachedSessions": manager.detached_count,
        }

    @app.websocket("/ws")
    async def terminal_ws(ws: WebSocket) -> None:
        # Browsers always send Origin — enforce the allowlist for them. Absent
        # Origin means a non-browser client (dev tooling); the ticket is the
        # only credential either way.
        origin = ws.headers.get("origin")
        if origin is not None and origin not in resolved.allowed_origins:
            await ws.close(code=CLOSE_AUTH, reason="origin not allowed")
            return

        await ws.accept()

        # -- auth frame (must be first, within the timeout) -------------------
        try:
            first = await asyncio.wait_for(
                ws.receive(), timeout=resolved.auth_frame_timeout_seconds
            )
        except TimeoutError:
            await _safe_send(ws, error_frame("auth_timeout"))
            await _safe_close(ws, CLOSE_AUTH_TIMEOUT)
            return

        if first.get("type") == "websocket.disconnect":
            return
        text = first.get("text")
        if text is None:
            await _safe_send(ws, error_frame("protocol_error", "auth frame must be text"))
            await _safe_close(ws, CLOSE_PROTOCOL)
            return
        try:
            frame = parse_client_frame(text)
        except ProtocolError as exc:
            await _safe_send(ws, error_frame("protocol_error", str(exc)))
            await _safe_close(ws, CLOSE_PROTOCOL)
            return
        if not isinstance(frame, AuthFrame):
            await _safe_send(ws, error_frame("protocol_error", "first frame must be auth"))
            await _safe_close(ws, CLOSE_PROTOCOL)
            return

        # -- redeem the one-time ticket ---------------------------------------
        try:
            identity = await cp.redeem_ticket(frame.ticket)
        except ControlPlaneError as exc:
            logger.info("ticket redeem failed: {}", exc)
            await _safe_send(ws, error_frame(exc.code))
            close = CLOSE_EXPIRED if exc.code == "ticket_expired" else CLOSE_AUTH
            await _safe_close(ws, close)
            return

        user_id = identity.user_id
        cols, rows = clamp_size(frame.cols, frame.rows)

        # -- reattach the most recent detached session, else spawn fresh -------
        adopted = await manager.pop_detached(user_id)
        if adopted is not None:
            session = adopted
            pty = session.pty
            session.websocket = ws
            session.last_input_at = time.monotonic()
            session.warned_idle = False
            replay = await manager.finish_attach(session)
            pty.resize(cols, rows)  # new grid + SIGWINCH repaints the TUI
            await _safe_send(ws, ready_frame(user_id, cols, rows, resumed=True))
            if replay:
                with contextlib.suppress(Exception):
                    await ws.send_bytes(replay)
            logger.info("session reattached user={} pid={}", user_id, pty.pid)
        else:
            # Capped concurrent sessions per user (evict oldest at the cap).
            await manager.claim(user_id)
            try:
                user_dir = prepare_user_dirs(resolved.users_dir, user_id)
                env = build_child_env(
                    user_dir=user_dir,
                    session_token=identity.session_token,
                    api_base_url=resolved.child_api_base_url,
                    cols=cols,
                    rows=rows,
                )
                # First terminal after a cold start continues the last
                # conversation in this workspace; extra terminals start fresh
                # (two agents must not fight over one session).
                argv = list(resolved.spawn_argv)
                if manager.count_for(user_id) == 0 and has_previous_session(
                    user_dir / "kimi-share", user_dir / "workspace"
                ):
                    argv.append("--continue")
                pty = PtySession(
                    argv=argv,
                    cwd=user_dir / "workspace",
                    env=env,
                    cols=cols,
                    rows=rows,
                )
                await pty.start()
            except Exception as exc:
                logger.error("spawn failed for {}: {}", user_id, exc)
                await _safe_send(ws, error_frame("spawn_failed"))
                await _safe_close(ws, CLOSE_INTERNAL)
                return

            session = ActiveSession(
                conn_id=str(uuid.uuid4()), user_id=user_id, pty=pty, websocket=ws
            )
            manager.register(session)
            await _safe_send(ws, ready_frame(user_id, cols, rows))
            logger.info("session started user={} pid={} argv={}", user_id, pty.pid, argv)

        # -- pumps -------------------------------------------------------------
        async def client_pump() -> str:
            while True:
                message = await ws.receive()
                kind = message.get("type")
                if kind == "websocket.disconnect":
                    return "disconnect"
                data = message.get("bytes")
                if data:
                    session.last_input_at = time.monotonic()
                    session.warned_idle = False
                    pty.write_input(data)
                    continue
                text = message.get("text")
                if text is None:
                    continue
                try:
                    control = parse_client_frame(text)
                except ProtocolError as exc:
                    await _safe_send(ws, error_frame("protocol_error", str(exc)))
                    return "protocol_error"
                if isinstance(control, ResizeFrame):
                    c, r = clamp_size(control.cols, control.rows)
                    pty.resize(c, r)
                elif isinstance(control, PingFrame):
                    await _safe_send(ws, pong_frame())
                else:  # a second auth frame is a protocol violation
                    await _safe_send(ws, error_frame("protocol_error", "unexpected auth"))
                    return "protocol_error"

        async def output_pump() -> str:
            while True:
                chunk = await pty.read_output()
                if chunk is None:
                    return "eof"
                await ws.send_bytes(chunk)

        async def watchdog() -> str:
            while True:
                await asyncio.sleep(_WATCHDOG_TICK_SECONDS)
                now = time.monotonic()
                if now - session.started_at >= resolved.max_session_seconds:
                    return "max_lifetime"
                idle = now - session.last_input_at
                remaining = resolved.idle_timeout_seconds - idle
                if remaining <= 0:
                    return "idle_timeout"
                if remaining <= resolved.idle_warning_seconds and not session.warned_idle:
                    session.warned_idle = True
                    await _safe_send(ws, warning_frame("idle", remaining))

        tasks = {
            asyncio.create_task(client_pump(), name="client"),
            asyncio.create_task(output_pump(), name="output"),
            asyncio.create_task(watchdog(), name="watchdog"),
        }
        outcome = "internal"
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in pending:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            finished = done.pop()
            exc = finished.exception()
            outcome = "internal" if exc else str(finished.result())
            if exc:
                logger.warning("session pump error for {}: {}", user_id, exc)
        finally:
            if outcome == "disconnect" and not pty.exited.is_set():
                # The socket died, not the agent — keep it running detached so
                # a reconnect (or page reload) lands back in the same session.
                manager.detach(session)
            else:
                manager.unregister(session)
                await pty.terminate()

        # -- close according to outcome ---------------------------------------
        if outcome == "eof":
            code = await pty.wait_exit_code()
            await _safe_send(ws, exit_frame(code))
            await _safe_close(ws, CLOSE_NORMAL)
        elif outcome == "idle_timeout":
            await _safe_send(ws, error_frame("idle_timeout"))
            await _safe_close(ws, CLOSE_IDLE)
        elif outcome == "max_lifetime":
            await _safe_send(ws, error_frame("max_lifetime"))
            await _safe_close(ws, CLOSE_LIFETIME)
        elif outcome == "protocol_error":
            await _safe_close(ws, CLOSE_PROTOCOL)
        elif outcome == "internal":
            await _safe_send(ws, error_frame("protocol_error", "internal error"))
            await _safe_close(ws, CLOSE_INTERNAL)
        # "disconnect": nothing to send — the peer is gone.
        logger.info("session ended user={} outcome={}", user_id, outcome)

    return app


async def _safe_send(ws: WebSocket, text: str) -> None:
    with contextlib.suppress(Exception):
        await ws.send_text(text)


async def _safe_close(ws: WebSocket, code: int) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=code)
