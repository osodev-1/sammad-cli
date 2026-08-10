"""Internal git REST — called only by the sanad-web proxy.

Reuses ``workspace_root`` auth. Git runs inside the user's workspace as the
agent's unprivileged user (uid split) so files keep consistent ownership. The
workspace directory layout puts ``home/`` beside ``workspace/``; git's HOME is
pointed there so it never touches a shared config.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from sanad_terminal.git_ops import GitError, GitRepo
from sanad_terminal.routes_workspace import workspace_root
from sanad_terminal.settings import TerminalSettings

router = APIRouter(prefix="/internal/git")

Root = Annotated[Path, Depends(workspace_root)]


def _settings(request: Request) -> TerminalSettings:
    return request.app.state.settings  # type: ignore[no-any-return]


def _repo(request: Request, root: Path) -> GitRepo:
    settings = _settings(request)
    uid: int | None = None
    gid: int | None = None
    if settings.agent_user:
        import pwd

        pw = pwd.getpwnam(settings.agent_user)
        uid, gid = pw.pw_uid, pw.pw_gid
    # home/ sits beside workspace/ (see workspace.prepare_*_dirs).
    home = root.parent / "home"
    return GitRepo(root, uid=uid, gid=gid, home=home if home.is_dir() else None)


def _error(exc: GitError, status: int = 400) -> JSONResponse:
    code = exc.code
    http = 409 if code in ("dirty_tree", "nothing_to_commit") else status
    return JSONResponse(status_code=http, content={"error": {"code": code, "message": exc.message}})


@router.get("/status")
async def status(request: Request, root: Root) -> JSONResponse:
    st = await _repo(request, root).status()
    return JSONResponse(
        {
            "isRepo": st.is_repo,
            "branch": st.branch,
            "head": st.head,
            "ahead": st.ahead,
            "behind": st.behind,
            "dirtyCount": st.dirty_count,
            "staged": st.staged,
            "unstaged": st.unstaged,
            "untracked": st.untracked,
        }
    )


@router.get("/branches")
async def branches(request: Request, root: Root) -> JSONResponse:
    current, names = await _repo(request, root).branches()
    return JSONResponse({"current": current, "branches": names})


@router.get("/log")
async def log(
    request: Request, root: Root, limit: int = 50, path: str | None = None
) -> JSONResponse:
    """Recent commits, newest first — optionally scoped to a path (the
    blueprint History timeline passes path=.sanad)."""
    entries = await _repo(request, root).log(limit=limit, path=path)
    return JSONResponse({"commits": entries})


@router.get("/show")
async def show(request: Request, root: Root, ref: str, path: str | None = None) -> JSONResponse:
    """One commit's unified diff, for the expandable history entry."""
    try:
        text = await _repo(request, root).show(ref, path=path)
    except GitError as exc:
        return _error(exc, 404 if exc.code == "show_failed" else 400)
    return JSONResponse({"diff": text})


@router.post("/init")
async def init(request: Request, root: Root) -> JSONResponse:
    await _repo(request, root).ensure_repo()
    return JSONResponse({"ok": True})


class BranchBody(BaseModel):
    name: str = Field(min_length=1, max_length=255)


@router.post("/branch")
async def create_branch(request: Request, root: Root, body: BranchBody) -> JSONResponse:
    try:
        await _repo(request, root).create_branch(body.name)
    except GitError as exc:
        return _error(exc)
    return JSONResponse({"ok": True})


@router.post("/checkout")
async def checkout(request: Request, root: Root, body: BranchBody) -> JSONResponse:
    try:
        await _repo(request, root).checkout(body.name)
    except GitError as exc:
        return _error(exc)
    return JSONResponse({"ok": True})


class CommitBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    authorName: str = Field(default="Sanad Workspace", max_length=200)
    authorEmail: str = Field(default="workspace@sanadcode.com", max_length=320)


@router.post("/commit")
async def commit(request: Request, root: Root, body: CommitBody) -> JSONResponse:
    try:
        head = await _repo(request, root).commit(body.message, body.authorName, body.authorEmail)
    except GitError as exc:
        return _error(exc)
    return JSONResponse({"ok": True, "head": head})


@router.post("/stash")
async def stash(request: Request, root: Root) -> JSONResponse:
    try:
        await _repo(request, root).stash()
    except GitError as exc:
        return _error(exc)
    return JSONResponse({"ok": True})


@router.post("/discard")
async def discard(request: Request, root: Root) -> JSONResponse:
    await _repo(request, root).discard_all()
    return JSONResponse({"ok": True})
