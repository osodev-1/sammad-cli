"""Internal Coder REST — flag-gated conversation lifecycle over CoderRunner.
Mirrors the architect bridge: `conversations` (create) redeems a one-time
ticket agentd-side and spawns `sanad --wire --session <id>`; `send`/`follow`
stream NDJSON from the server-authoritative journal.

P1a posture: ApprovalRequest/QuestionRequest frames are bridged into the
turn journal and a per-runner pending registry (`GET /turn`'s
`pendingRequests`); `POST /respond` resolves them back onto the wire.
ToolCallRequest and any other/unknown request type is still rejected. The
conversation id is a lookup key within this workspace, never an
authorization input: the workspace root always derives from the caller's
credential (`workspace_root`).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger
from pydantic import BaseModel, Field

from sanad_terminal.coder_runner import (
    CONVERSATION_ID_RE,
    CoderRunner,
    drop_conversation,
    get_conversation,
    list_conversations,
    new_conversation_id,
    put_conversation,
)
from sanad_terminal.control_plane import ControlPlaneError
from sanad_terminal.routes_workspace import _settings, workspace_root
from sanad_terminal.wire_runner import WireRunnerError
from sanad_terminal.workspace import build_child_env, verified_trust_hashes

router = APIRouter(prefix="/internal/coder")

Root = Annotated[Path, Depends(workspace_root)]


def _gate(request: Request) -> None:
    if not _settings(request).coder_enabled:
        raise CoderDisabled()


class CoderDisabled(Exception):
    pass


Gated = Annotated[None, Depends(_gate)]


class TicketBody(BaseModel):
    ticket: str = Field(min_length=1, max_length=256)


class SendBody(BaseModel):
    input: str = Field(min_length=1, max_length=32_000)
    sendId: str | None = Field(default=None, max_length=64)


class RespondBody(BaseModel):
    requestId: str = Field(min_length=1, max_length=128)
    response: str | None = Field(default=None, max_length=32)
    feedback: str | None = Field(default=None, max_length=8_000)
    answers: dict[str, str] | None = None


class ModeBody(BaseModel):
    mode: str = Field(min_length=1, max_length=32)


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _bad_cid(cid: str) -> JSONResponse | None:
    if not CONVERSATION_ID_RE.fullmatch(cid):
        return _err(400, "invalid_conversation", "malformed conversation id")
    return None


async def _spawn(
    request: Request, root: Path, cid: str, ticket: str, *, seed_default: bool = False
) -> JSONResponse | CoderRunner:
    settings = _settings(request)
    live = [r for r in list_conversations(root) if r.alive]
    if len(live) >= settings.coder_max_conversations:
        return _err(409, "conversation_limit", "too many live conversations; stop one first")
    cp = request.app.state.control_plane
    try:
        identity = await cp.redeem_ticket(ticket)
    except ControlPlaneError as exc:
        status = 410 if exc.code == "ticket_expired" else 401
        return _err(status, exc.code, exc.message)
    if settings.fixed_user and identity.user_id != settings.fixed_user:
        return _err(401, "invalid_ticket", "user mismatch")

    argv = [*settings.spawn_argv, "--wire", "--session", cid]
    env = build_child_env(
        user_dir=root.parent,
        session_token=identity.session_token,
        api_base_url=settings.child_api_base_url,
        cols=80,
        rows=24,
        trusted_hashes=verified_trust_hashes(root, settings.trust_store_key),
    )
    uid = gid = None
    if settings.agent_user:
        import pwd

        pw = pwd.getpwnam(settings.agent_user)
        uid, gid = pw.pw_uid, pw.pw_gid

    runner = CoderRunner(
        conversation_id=cid,
        argv=argv,
        cwd=root,
        env=env,
        uid=uid,
        gid=gid,
        rlimit_nproc=settings.agent_rlimit_nproc,
        rlimit_fsize=settings.agent_rlimit_fsize,
        max_turn_seconds=settings.coder_max_turn_seconds,
        max_steps_per_turn=settings.coder_max_steps_per_turn,
        # Durable journal (P3): every spawn — CREATE (fresh cid, empty
        # journal) and OPEN alike (existing cid, reconstructs+reconciles
        # from disk in CoderRunner.__init__) — gets the same on-disk root,
        # keyed by conversation under this user's agentd dir. `root` is
        # `<user_dir>/workspace`, so `root.parent` is `<user_dir>`.
        journal_dir=root.parent / "agentd" / "coder" / cid,
        journal_turns_keep=settings.coder_journal_turns_keep,
        journal_max_bytes=settings.coder_journal_max_bytes,
    )
    try:
        await runner.start()
    except WireRunnerError as exc:
        await runner.stop()
        return _err(503, exc.code, exc.message)
    put_conversation(root, runner)
    if seed_default:
        # CREATE only — never on `open`, which resumes a session that may
        # already carry a persisted posture the reattach must not clobber.
        # Non-fatal: an old CLI at wire protocol 1.10 rejects the method, and
        # the conversation still works fine at whatever posture it starts in.
        try:
            await runner.set_permission_mode("default")
        except WireRunnerError as exc:
            logger.warning(
                "default-mode seeding failed for conversation {}: {}", cid, exc.message
            )
    return runner


@router.get("/conversations")
async def conversations(_: Gated, root: Root) -> JSONResponse:
    return JSONResponse(
        {
            "conversations": [
                {
                    "conversationId": r.conversation_id,
                    "alive": r.alive,
                    "busy": r.busy,
                    "turn": r.turn_summary(),
                }
                for r in list_conversations(root)
            ]
        }
    )


@router.post("/conversations")
async def create(_: Gated, root: Root, request: Request, body: TicketBody) -> JSONResponse:
    cid = new_conversation_id()
    result = await _spawn(request, root, cid, body.ticket, seed_default=True)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse({"conversationId": cid})


@router.post("/conversations/{cid}/open")
async def open_conversation(
    _: Gated, root: Root, request: Request, cid: str, body: TicketBody
) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    existing = get_conversation(root, cid)
    if existing is not None and existing.alive:
        return JSONResponse({"ok": True, "started": False})
    result = await _spawn(request, root, cid, body.ticket)
    if isinstance(result, JSONResponse):
        return result
    return JSONResponse({"ok": True, "started": True})


def _recycling_stream(
    root: Path, runner: CoderRunner, items: AsyncIterator[dict[str, Any]]
) -> AsyncIterator[bytes]:
    """Serialize a turn stream, dropping the runner on a failed turn so the
    next open respawns with freshly redeemed auth (same trap as the
    architect: a zombie whose every LLM call 401s)."""

    async def stream() -> AsyncIterator[bytes]:
        failed = False
        try:
            async for item in items:
                if item.get("kind") == "end" and item.get("status") not in (
                    "finished",
                    "cancelled",
                ):
                    failed = True
                yield json.dumps(item).encode("utf-8") + b"\n"
        except WireRunnerError as exc:
            failed = True
            yield (
                json.dumps({"kind": "error", "code": "turn_failed", "message": exc.message}).encode(
                    "utf-8"
                )
                + b"\n"
            )
        if failed or not runner.alive:
            await drop_conversation(root, runner.conversation_id)

    return stream()


@router.post("/conversations/{cid}/send", response_model=None)
async def send(_: Gated, root: Root, cid: str, body: SendBody) -> StreamingResponse | JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None or not runner.alive:
        return _err(409, "not_started", "conversation is not running")
    try:
        state = await runner.start_turn(body.input, body.sendId)
    except WireRunnerError as exc:
        if exc.code == "busy":
            summary = runner.turn_summary() or {}
            return JSONResponse(
                status_code=409,
                content={
                    "error": {
                        "code": "busy",
                        "message": "a turn is already in progress",
                        "turnId": summary.get("turnId"),
                    }
                },
            )
        return _err(409, exc.code, exc.message)
    return StreamingResponse(
        _recycling_stream(root, runner, runner.follow(state.turn_id, 0)),
        media_type="application/x-ndjson",
    )


@router.post("/conversations/{cid}/respond")
async def respond(_: Gated, root: Root, cid: str, body: RespondBody) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None or not runner.alive:
        return _err(409, "not_started", "conversation is not running")
    payload: dict[str, Any] = {}
    if body.response is not None:
        payload["response"] = body.response
    if body.feedback is not None:
        payload["feedback"] = body.feedback
    if body.answers is not None:
        payload["answers"] = body.answers
    try:
        await runner.respond(body.requestId, payload)
    except WireRunnerError as exc:
        status = 410 if exc.code == "request_gone" else 400
        return _err(status, exc.code, exc.message)
    return JSONResponse({"ok": True})


@router.get("/conversations/{cid}/turn")
async def turn(_: Gated, root: Root, cid: str) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None:
        return JSONResponse({"turn": None, "alive": False, "pendingRequests": [], "mode": None})
    return JSONResponse(
        {
            "turn": runner.turn_summary(),
            "alive": runner.alive,
            "pendingRequests": runner.pending_summaries(),
            "mode": runner.permission_mode,
        }
    )


@router.post("/conversations/{cid}/mode")
async def set_mode(_: Gated, root: Root, cid: str, body: ModeBody) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None or not runner.alive:
        return _err(409, "not_started", "conversation is not running")
    try:
        await runner.set_permission_mode(body.mode)
    except WireRunnerError as exc:
        return _err(400, exc.code, exc.message)
    return JSONResponse({"ok": True, "mode": runner.permission_mode})


@router.get("/conversations/{cid}/follow", response_model=None)
async def follow(
    _: Gated, root: Root, cid: str, turnId: str, from_seq: int = 0
) -> StreamingResponse | JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None or runner.get_turn(turnId) is None:
        return _err(404, "unknown_turn", "no such turn")
    return StreamingResponse(
        _recycling_stream(root, runner, runner.follow(turnId, from_seq)),
        media_type="application/x-ndjson",
    )


@router.post("/conversations/{cid}/cancel")
async def cancel(_: Gated, root: Root, cid: str) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is not None and runner.alive:
        await runner.cancel()
    return JSONResponse({"ok": True})


@router.post("/conversations/{cid}/stop")
async def stop(_: Gated, root: Root, cid: str) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    await drop_conversation(root, cid)
    return JSONResponse({"ok": True})
