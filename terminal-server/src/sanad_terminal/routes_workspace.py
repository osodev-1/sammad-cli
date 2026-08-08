"""Internal workspace REST — called only by the sanad-web proxy.

Every request must carry X-Terminal-Secret (timing-safe compared) and
X-Workspace-User (the Clerk user id sanad-web authenticated). Browsers never
reach these routes directly; the proxy is the only caller, so responses use a
minimal {error:{code,message}} JSON shape the proxy re-wraps.
"""

from __future__ import annotations

import hmac
import mimetypes
from dataclasses import asdict
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from sanad_terminal import workspace_fs as wfs
from sanad_terminal.settings import TerminalSettings
from sanad_terminal.workspace import InvalidUserId, prepare_user_dirs

router = APIRouter(prefix="/internal/workspace")


class WorkspaceApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _settings(request: Request) -> TerminalSettings:
    return request.app.state.settings  # type: ignore[no-any-return]


def workspace_root(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_terminal_secret: Annotated[str | None, Header()] = None,
    x_workspace_user: Annotated[str | None, Header()] = None,
) -> Path:
    """Authenticate the proxy call and return the user's workspace root.

    railway mode: shared-secret header + explicit user (multi-user container).
    task mode: derived per-machine bearer; the user is FIXED — client-supplied
    identity headers are ignored by construction.
    """
    settings = _settings(request)

    if settings.mode == "task":
        token = ""
        if authorization and authorization.startswith("Bearer "):
            token = authorization[7:].strip()
        if not token or not hmac.compare_digest(token, settings.agentd_token):
            raise WorkspaceApiError(401, "unauthorized", "invalid machine credential")
        from sanad_terminal.workspace import prepare_single_user_dirs

        return prepare_single_user_dirs(settings.data_dir) / "workspace"

    if not x_terminal_secret or not hmac.compare_digest(x_terminal_secret, settings.shared_secret):
        raise WorkspaceApiError(401, "unauthorized", "invalid service credential")
    if not x_workspace_user:
        raise WorkspaceApiError(400, "invalid_request", "missing workspace user")
    try:
        user_dir = prepare_user_dirs(settings.users_dir, x_workspace_user)
    except InvalidUserId as exc:
        raise WorkspaceApiError(400, "invalid_request", str(exc)) from exc
    return user_dir / "workspace"


Root = Annotated[Path, Depends(workspace_root)]


def _entries_payload(entries: list[wfs.Entry]) -> list[dict[str, object]]:
    return [asdict(e) for e in entries]


@router.get("/tree")
async def tree(root: Root, path: str = "") -> JSONResponse:
    entries = wfs.list_dir(root, path)
    return JSONResponse({"entries": _entries_payload(entries)})


@router.get("/snapshot")
async def snapshot(root: Root) -> JSONResponse:
    entries, truncated = wfs.snapshot(root)
    return JSONResponse({"entries": _entries_payload(entries), "truncated": truncated})


@router.get("/file")
async def read_file(root: Root, path: str) -> Response:
    target = wfs.file_for_read(root, path)
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"

    def stream():
        with target.open("rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        stream(),
        media_type=media_type,
        headers={
            "content-length": str(target.stat().st_size),
            "x-file-name": target.name,
        },
    )


@router.get("/archive-list")
async def archive_list(root: Root, path: str) -> JSONResponse:
    """List a zip/tar archive's members without extracting (read-only viewer)."""
    try:
        entries, truncated = wfs.archive_list(root, path)
    except wfs.UnsupportedArchive:
        return _error(415, "unsupported_archive", "This file could not be read as an archive.")
    return JSONResponse(
        {
            "entries": [{"name": e.name, "size": e.size, "isDir": e.is_dir} for e in entries],
            "truncated": truncated,
        }
    )


@router.put("/file")
async def write_file(root: Root, path: str, request: Request) -> JSONResponse:
    settings = _settings(request)
    body = await request.body()
    if len(body) > settings.max_upload_bytes:
        raise WorkspaceApiError(413, "too_large", "file exceeds the size limit")
    entry = wfs.write_file(root, path, body)
    return JSONResponse({"entry": asdict(entry)})


@router.post("/upload")
async def upload(
    root: Root, request: Request, files: list[UploadFile], dir: str = ""
) -> JSONResponse:
    settings = _settings(request)
    saved: list[wfs.Entry] = []
    for file in files:
        name = wfs.sanitize_filename(file.filename or "upload.bin")
        rel = f"{dir.rstrip('/')}/{name}" if dir else name
        content = await file.read()
        if len(content) > settings.max_upload_bytes:
            raise WorkspaceApiError(413, "too_large", f"{name} exceeds the size limit")
        saved.append(wfs.write_file(root, rel, content))
    return JSONResponse({"entries": _entries_payload(saved)})


class MkdirBody(BaseModel):
    path: str = Field(min_length=1)


@router.post("/mkdir")
async def mkdir(root: Root, body: MkdirBody) -> JSONResponse:
    entry = wfs.make_dir(root, body.path)
    return JSONResponse({"entry": asdict(entry)})


class ArchiveBody(BaseModel):
    path: str = ""


@router.post("/archive")
async def archive(root: Root, body: ArchiveBody) -> StreamingResponse:
    spool = wfs.build_zip(root, body.path)
    name = (Path(body.path).name or "workspace") + ".zip"

    def stream():
        try:
            while chunk := spool.read(65536):
                yield chunk
        finally:
            spool.close()

    return StreamingResponse(stream(), media_type="application/zip", headers={"x-file-name": name})


@router.delete("/file")
async def delete_path(root: Root, path: str) -> JSONResponse:
    wfs.delete(root, path)
    return JSONResponse({"deleted": path})


class MoveBody(BaseModel):
    src: str = Field(min_length=1, alias="from")
    dst: str = Field(min_length=1, alias="to")

    model_config = {"populate_by_name": True}


@router.patch("/move")
async def move(root: Root, body: MoveBody) -> JSONResponse:
    entry = wfs.move(root, body.src, body.dst)
    return JSONResponse({"entry": asdict(entry)})


@router.get("/search")
async def search(root: Root, q: str = "") -> JSONResponse:
    return JSONResponse({"entries": _entries_payload(wfs.search(root, q))})


@router.post("/keepalive")
async def keepalive(root: Root, request: Request) -> JSONResponse:
    """Explicit liveness signal (e.g. an open preview) — resets the idle-stop
    clock via the activity middleware; the auth dependency is the point."""
    _ = root
    stopper = getattr(request.app.state, "idle_stopper", None)
    if stopper is not None:
        stopper.touch()
    return JSONResponse({"ok": True})


def register_error_handlers(app) -> None:  # noqa: ANN001 - FastAPI at runtime
    @app.exception_handler(WorkspaceApiError)
    async def _api_error(request: Request, exc: WorkspaceApiError) -> JSONResponse:
        return _error(exc.status, exc.code, exc.message)

    @app.exception_handler(wfs.PathViolation)
    async def _violation(request: Request, exc: wfs.PathViolation) -> JSONResponse:
        return _error(400, "invalid_path", str(exc))

    @app.exception_handler(wfs.NotFound)
    async def _not_found(request: Request, exc: wfs.NotFound) -> JSONResponse:
        return _error(404, "not_found", str(exc))

    @app.exception_handler(wfs.AlreadyExists)
    async def _exists(request: Request, exc: wfs.AlreadyExists) -> JSONResponse:
        return _error(409, "already_exists", str(exc))
