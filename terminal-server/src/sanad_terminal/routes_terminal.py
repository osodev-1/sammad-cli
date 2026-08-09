"""Internal terminal control — restart the workspace's agent sessions.

The CLI discovers skills (and, later, other blueprint definitions) when the
agent process is constructed, so an already-running conversation cannot pick
up a freshly applied definition. ``POST /internal/terminal/restart`` is the
activation affordance: it terminates every AGENT-kind PTY for the workspace's
user; the frontend then reconnects, the next attach finds no live agent and
spawns fresh — which, being first, resumes the newest conversation from disk
(app.py's --resume rule). Same chat, fresh definitions. Drawer shells are a
different kind and are never touched.

Auth mirrors ``routes_workspace.workspace_root`` but resolves the USER — the
session registry is keyed by user id, not by workspace path:
- task mode: derived per-machine bearer; the user is the machine's fixed user.
- railway mode: shared-secret header + explicit ``x-workspace-user``.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse

from sanad_terminal.manager import SessionManager
from sanad_terminal.routes_workspace import WorkspaceApiError, _settings

router = APIRouter(prefix="/internal/terminal")


def terminal_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_terminal_secret: Annotated[str | None, Header()] = None,
    x_workspace_user: Annotated[str | None, Header()] = None,
) -> str:
    """Authenticate the proxy call; return whose sessions it may touch."""
    settings = _settings(request)

    if settings.mode == "task":
        token = ""
        if authorization and authorization.startswith("Bearer "):
            token = authorization[7:].strip()
        if not token or not hmac.compare_digest(token, settings.agentd_token):
            raise WorkspaceApiError(401, "unauthorized", "invalid machine credential")
        return settings.fixed_user

    if not x_terminal_secret or not hmac.compare_digest(x_terminal_secret, settings.shared_secret):
        raise WorkspaceApiError(401, "unauthorized", "invalid service credential")
    if not x_workspace_user:
        raise WorkspaceApiError(400, "invalid_request", "missing workspace user")
    return x_workspace_user


User = Annotated[str, Depends(terminal_user)]


@router.post("/restart")
async def restart_agents(request: Request, user_id: User) -> JSONResponse:
    manager: SessionManager = request.app.state.manager
    stopped = await manager.restart_kind(user_id, kind="agent")
    return JSONResponse({"stopped": stopped})
