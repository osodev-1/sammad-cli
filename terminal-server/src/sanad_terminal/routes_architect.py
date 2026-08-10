"""Internal Architect REST — the plan→review→apply chat, hosted on the machine.

The browser talks to this through the same proxy credential as the blueprint
and git routes (``workspace_root``). ``start`` redeems a one-time ticket to a
gateway session token — agentd-side, so the browser never sees it (RT-006 /
SE-004) — and spawns the wire subprocess. ``ask`` streams one turn back as
newline-delimited JSON. The architect can only read and DRAFT; applying a
drafted change is a separate POST to ``/internal/blueprint/apply`` (M2).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from sanad_terminal.architect_runner import (
    ArchitectError,
    ArchitectRunner,
    drop_runner,
    get_runner,
    put_runner,
)
from sanad_terminal.control_plane import ControlPlaneError
from sanad_terminal.routes_workspace import _settings, workspace_root
from sanad_terminal.workspace import build_child_env

router = APIRouter(prefix="/internal/architect")

Root = Annotated[Path, Depends(workspace_root)]


class StartBody(BaseModel):
    ticket: str = Field(min_length=1, max_length=256)


class AskBody(BaseModel):
    input: str = Field(min_length=1, max_length=32_000)


def _spawn_params(settings: Any, root, session_token: str):  # noqa: ANN001, ANN202
    """argv/env/uid/gid for a `sanad --wire --agent architect` subprocess."""
    argv = [*settings.spawn_argv, "--wire", "--agent", "architect"]
    env = build_child_env(
        user_dir=root.parent,  # workspace_root is <user_dir>/workspace in both modes
        session_token=session_token,
        api_base_url=settings.child_api_base_url,
        cols=80,
        rows=24,
    )
    uid = gid = None
    if settings.agent_user:
        import pwd

        pw = pwd.getpwnam(settings.agent_user)
        uid, gid = pw.pw_uid, pw.pw_gid
    return argv, env, uid, gid


@router.post("/start")
async def start(root: Root, request: Request, body: StartBody) -> JSONResponse:
    """Ensure the architect subprocess is running for this workspace."""
    existing = get_runner(root)
    if existing is not None and existing.alive:
        return JSONResponse({"ok": True, "started": False})

    settings = _settings(request)
    cp = request.app.state.control_plane
    try:
        identity = await cp.redeem_ticket(body.ticket)
    except ControlPlaneError as exc:
        status = 410 if exc.code == "ticket_expired" else 401
        return JSONResponse(
            status_code=status,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    # Defense in depth: this machine serves exactly one user (task mode).
    if settings.fixed_user and identity.user_id != settings.fixed_user:
        return JSONResponse(
            status_code=401,
            content={"error": {"code": "invalid_ticket", "message": "user mismatch"}},
        )

    argv, env, uid, gid = _spawn_params(settings, root, identity.session_token)
    runner = ArchitectRunner(argv=argv, cwd=root, env=env, uid=uid, gid=gid)
    try:
        await runner.start()
    except ArchitectError as exc:
        await runner.stop()
        return JSONResponse(
            status_code=503,
            content={"error": {"code": exc.code, "message": exc.message}},
        )
    put_runner(root, runner)
    return JSONResponse({"ok": True, "started": True})


@router.post("/ask", response_model=None)
async def ask(root: Root, body: AskBody) -> StreamingResponse | JSONResponse:
    """Run one turn, streaming its wire events as newline-delimited JSON."""
    runner = get_runner(root)
    if runner is None or not runner.alive:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "not_started", "message": "architect is not running"}},
        )
    if runner.busy:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "busy", "message": "a turn is already in progress"}},
        )

    async def stream() -> AsyncIterator[bytes]:
        # A turn that ends any way other than "finished"/"cancelled" (provider
        # auth died, subprocess crashed) marks the runner UNHEALTHY: drop it so
        # the next start spawns fresh with freshly redeemed auth. Without this,
        # the idempotent start keeps handing back a zombie whose every LLM call
        # 401s — the "architect stopped responding" trap.
        failed = False
        try:
            async for item in runner.ask(body.input):
                if item.get("kind") == "end" and item.get("status") not in (
                    "finished",
                    "cancelled",
                ):
                    failed = True
                    yield (
                        json.dumps(
                            {
                                "kind": "error",
                                "code": "turn_failed",
                                "message": (
                                    "The architect's session expired — it restarts "
                                    "automatically on your next message."
                                ),
                            }
                        ).encode("utf-8")
                        + b"\n"
                    )
                yield json.dumps(item).encode("utf-8") + b"\n"
        except ArchitectError as exc:
            failed = True
            yield (
                json.dumps(
                    {"kind": "error", "code": "turn_failed", "message": exc.message}
                ).encode("utf-8")
                + b"\n"
            )
        if failed or not runner.alive:
            await drop_runner(root)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.post("/cancel")
async def cancel(root: Root) -> JSONResponse:
    """Interrupt the active turn (its end still streams to the ask caller)."""
    runner = get_runner(root)
    if runner is not None and runner.alive:
        await runner.cancel()
    return JSONResponse({"ok": True})


@router.post("/reset")
async def reset(root: Root) -> JSONResponse:
    """Stop the architect subprocess. The next start spawns a fresh one with
    freshly redeemed auth — the recovery lever for a wedged or stale runner,
    and half of the workspace-reset affordance (the other half restarts the
    agent PTYs so new blueprint definitions load)."""
    await drop_runner(root)
    return JSONResponse({"ok": True})
