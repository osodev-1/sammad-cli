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
import time
import uuid
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
    wake_workspace_waiters,
)
from sanad_terminal.control_plane import ControlPlaneError
from sanad_terminal.git_ops import GitError, _checkpoint_ref
from sanad_terminal.routes_workspace import _settings, workspace_root
from sanad_terminal.wire_runner import WireRunnerError
from sanad_terminal.workspace import build_child_env, verified_trust_hashes
from sanad_terminal.workspace_lease import (
    is_revert_holder,
    lease_for,
    new_revert_holder,
)
from sanad_terminal.workspace_locks import lock_for

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
    # `min_length=1` (P6a Task 3): without it `""` reaches the runner
    # straight from HTTP (only `max_length` was set before). Belt-and-
    # suspenders — `coder_runner._is_idempotent_start_turn_passthrough`
    # already treats `""` as truthy-false / never-idempotent defensively —
    # this just stops the empty string from arriving at all.
    sendId: str | None = Field(default=None, min_length=1, max_length=64)
    # Force-queue instead of starting immediately, even on an idle runner
    # (P4b) — the ordinary busy case auto-queues regardless of this flag;
    # see `send()` below.
    queue: bool = False


class RespondBody(BaseModel):
    requestId: str = Field(min_length=1, max_length=128)
    response: str | None = Field(default=None, max_length=32)
    feedback: str | None = Field(default=None, max_length=8_000)
    answers: dict[str, str] | None = None


class ModeBody(BaseModel):
    mode: str = Field(min_length=1, max_length=32)


class SteerBody(BaseModel):
    input: str = Field(min_length=1, max_length=32_000)


class RevertBody(BaseModel):
    turnId: str = Field(min_length=1, max_length=64)


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _bad_cid(cid: str) -> JSONResponse | None:
    if not CONVERSATION_ID_RE.fullmatch(cid):
        return _err(400, "invalid_conversation", "malformed conversation id")
    return None


def _lease_summary(root: Path) -> dict[str, Any]:
    """`GET /turn`'s `"lease"` field (P6a Task 3) — workspace-scoped, not
    conversation-scoped: every conversation in this workspace sees the same
    reading, since the write-lease is per-workspace, not per-conversation.

    `holder` is a real conversation id ONLY when a conversation genuinely
    holds the lease. A revert never surfaces as one — a prior review
    flagged that leaking the raw `REVERT_HOLDER` sentinel here would make
    the UI say "waiting for conversation __revert__", as if it were a
    conversation the user could look up. `kind` disambiguates instead:
    `None` (nobody holds it), `"conversation"` (a real conversation does —
    see `holder`), or `"revert"` (a human-triggered revert does — `holder`
    stays `None` in that case)."""
    lease = lease_for(root)
    holder = lease.holder_of()
    # A past-TTL holder is what the drain path already treats as absent
    # (`_maybe_drain_queue`), so report it the same way — otherwise `/turn`
    # says "blocked" for a lease the very next `/send` would reclaim.
    if holder is None or lease.held_seconds() > lease.stale_after_seconds:
        return {"kind": None, "holder": None, "heldSeconds": 0.0}
    if is_revert_holder(holder):
        # Every revert has its own identity; `kind` is what the UI reads, so
        # the sentinel itself never reaches it.
        return {"kind": "revert", "holder": None, "heldSeconds": lease.held_seconds()}
    return {"kind": "conversation", "holder": holder, "heldSeconds": lease.held_seconds()}


# -- checkpoints (P5 Task 3) — human-only diff/revert over the durable
# per-turn checkpoint SHAs Task 2 wrote into the journal (`checkpointPre`/
# `checkpointPost`). No agent-facing path exists for either.


def _journal_dir(root: Path, cid: str) -> Path:
    # Mirrors `_spawn`'s own `journal_dir=root.parent / "agentd" / "coder" / cid`.
    return root.parent / "agentd" / "coder" / cid


def _read_checkpoint_entry(root: Path, cid: str, turn_id: str) -> dict[str, Any] | None:
    """`turnId`'s durable journal index entry (`turns.json`), read straight
    off disk. A live runner's own in-memory index writes through to this
    same file synchronously — at turn start (`CoderRunner.start_turn` calls
    `_journal_note_turn` right after `super().start_turn()`, which itself
    awaits the pre-checkpoint before returning) and again at turn end
    (`_consume`'s finally) — so there is no live/durable divergence to
    reconcile: reading disk unconditionally is correct whether the turn is
    still running, has finished, or its runner has since been dropped
    entirely (`/stop`, or `_recycling_stream` dropping a failed turn)."""
    index_path = _journal_dir(root, cid) / "turns.json"
    try:
        raw = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, list):
        return None
    for entry in raw:
        if isinstance(entry, dict) and entry.get("turnId") == turn_id:
            return entry
    return None


def _record_revert(root: Path, cid: str, marker: dict[str, Any]) -> None:
    """Append one `{"kind":"revert",...}` marker as a durable JSON line
    beside `turns.json` — enough for the UI/dock to later show "reverted to
    turn N, safety <sha>". Best-effort: a write failure here must never
    undo an already-completed revert (the git-level restore is what
    matters; this is bookkeeping)."""
    path = _journal_dir(root, cid) / "reverts.ndjson"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(marker) + "\n")
    except OSError as exc:
        logger.warning("coder revert: could not record marker for {}: {}", cid, exc)


async def _spawn(
    request: Request, root: Path, cid: str, ticket: str, *, seed_default: bool = False
) -> JSONResponse | CoderRunner:
    settings = _settings(request)
    live = [r for r in list_conversations(root) if r.alive]
    if len(live) >= settings.coder_max_conversations:
        return _err(409, "conversation_limit", "too many live conversations; stop one first")
    # Write-lease TTL (P6a Task 3 — a prior review found this was never
    # passed anywhere, so an env override silently did nothing). `_spawn`
    # runs before any turn can possibly touch this workspace's lease, so
    # this is the earliest point the configured TTL can become
    # authoritative. Every call site in this module passes the SAME
    # app-wide `settings.coder_write_lease_ttl_seconds`, so `lease_for`'s
    # "update on get" (see its docstring) is a no-op in practice after the
    # first spawn or revert touches a given root — this is not the only
    # call site that sets it (see `revert` below), just the earliest.
    lease_for(root, stale_after_seconds=settings.coder_write_lease_ttl_seconds)
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
        max_queue_depth=settings.coder_max_queue_depth,
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
    architect: a zombie whose every LLM call 401s).

    "interrupted" is EXCLUDED from that failure check (P3 Task 4 fix): it's
    the restart-recovery terminal status (`CoderRunner.
    _reconcile_interrupted_turn`) a turn gets reconciled to when a FRESH,
    freshly-`start()`ed runner reconstructs it from the journal — i.e. this
    fires on a healthy runner with live, just-redeemed auth, never on a
    zombie whose LLM calls would 401. Treating it as `failed` used to drop
    that healthy runner out from under the very `/follow` call that
    surfaces the interrupted turn to the client, so the next `/send` 409'd
    "not_started" and every subsequent reconnect had to re-`/open` (and, on
    the frontend, re-replay the same turn — see CoderPanel.begin()'s
    `lastInterruptedTurnId` guard)."""

    async def stream() -> AsyncIterator[bytes]:
        failed = False
        try:
            async for item in items:
                if item.get("kind") == "end" and item.get("status") not in (
                    "finished",
                    "cancelled",
                    "interrupted",
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
    if body.queue or runner.busy:
        # A busy send now auto-queues instead of 409ing "busy" for the
        # client to re-queue itself (the old dance) — and an explicit
        # `queue:true` forces the same path even on an idle runner, so a
        # follow-up survives a closed tab. `sendId` is required for the
        # queue's own idempotency key; synthesize one when the caller
        # didn't send one (mirrors `new_conversation_id`'s minting style).
        send_id = body.sendId or f"q_{uuid.uuid4().hex[:12]}"
        try:
            position = runner.enqueue(send_id, body.input)
        except WireRunnerError as exc:
            # queue_full (P4 final-review, Important C) is the only error
            # `enqueue` raises today — 409, mirroring `conversation_limit`'s
            # sibling "at capacity" envelope (this codebase has no
            # established 429 usage to match instead).
            return _err(409, exc.code, exc.message)
        if not runner.busy:
            # Queued onto an idle runner: nothing will ever end a turn to
            # trigger the drain hook, so kick it off directly here — the
            # same "no await between busy-check and start" gap-free path
            # `_maybe_drain_queue` itself relies on.
            await runner._maybe_drain_queue()
        return JSONResponse(
            status_code=202, content={"ok": True, "queued": True, "position": position}
        )
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
        if exc.code == "lease_unavailable":
            # Write-lease (P6a Task 3): a DIFFERENT conversation — or a
            # revert, `exc.holder == REVERT_HOLDER` — holds this
            # workspace's write-lease, and `start_turn` (coder_runner.py)
            # declined to start a turn rather than race it. It already
            # registered us as a FIFO waiter before raising, so all that's
            # left here is to enqueue: the SAME 202 envelope the sibling
            # "own runner busy" branch above returns, so the frontend's
            # `status === 202` short-circuit behaves identically whether
            # the wait is for our own turn or someone else's.
            send_id = body.sendId or f"q_{uuid.uuid4().hex[:12]}"
            try:
                position = runner.enqueue(
                    send_id,
                    body.input,
                    # A revert is not a conversation the user can look up, so it
                    # must never travel as `blockedBy`; the reason carries it.
                    reason=(
                        "waiting_for_revert"
                        if is_revert_holder(exc.holder)
                        else "waiting_for_lease"
                    ),
                    blocked_by=None if is_revert_holder(exc.holder) else exc.holder,
                )
            except WireRunnerError as enqueue_exc:
                # queue_full — same envelope as the sibling busy-queue path
                # above; never a 500.
                return _err(409, enqueue_exc.code, enqueue_exc.message)
            return JSONResponse(
                status_code=202, content={"ok": True, "queued": True, "position": position}
            )
        return _err(409, exc.code, exc.message)
    return StreamingResponse(
        _recycling_stream(root, runner, runner.follow(state.turn_id, 0)),
        media_type="application/x-ndjson",
    )


@router.delete("/conversations/{cid}/queue/{sendId}")
async def dequeue(_: Gated, root: Root, cid: str, sendId: str) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None:
        return _err(409, "not_started", "conversation is not running")
    removed = runner.dequeue(sendId)
    return JSONResponse({"ok": True, "removed": removed})


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
        return JSONResponse(
            {
                "turn": None,
                "alive": False,
                "pendingRequests": [],
                "mode": None,
                "queue": [],
                # Workspace-scoped (P6a Task 3), not conversation-scoped —
                # meaningful even when THIS cid has no runner, since a
                # DIFFERENT conversation (or a revert) may still hold it.
                "lease": _lease_summary(root),
            }
        )
    return JSONResponse(
        {
            "turn": runner.turn_summary(),
            "alive": runner.alive,
            "pendingRequests": runner.pending_summaries(),
            "mode": runner.permission_mode,
            "queue": runner.queue_summary(),
            "lease": _lease_summary(root),
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


@router.post("/conversations/{cid}/steer")
async def steer(_: Gated, root: Root, cid: str, body: SteerBody) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None:
        return _err(409, "no_turn", "no turn is in progress")
    try:
        await runner.steer(body.input)
    except WireRunnerError as exc:
        return _err(409, exc.code, exc.message)
    return JSONResponse({"ok": True})


@router.post("/conversations/{cid}/stop")
async def stop(_: Gated, root: Root, cid: str) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    await drop_conversation(root, cid)
    return JSONResponse({"ok": True})


@router.get("/conversations/{cid}/diff")
async def diff(
    _: Gated, root: Root, request: Request, cid: str, turnId: str, path: str | None = None
) -> JSONResponse:
    """Name-status + unified patch for one turn: `pre..post` once the turn
    has finished with a real post checkpoint, `pre..worktree` while it's
    still running. A null `checkpointPost` has two different causes that
    must NOT be treated alike (final-review fix): the turn may still be
    running (post simply hasn't landed yet — `pre..worktree` is the right
    "diff against whatever the tree looks like now" fallback), or the turn
    may have FINISHED with its post skipped as clean (`create_checkpoint`'s
    own skip-when-clean — a genuine no-op turn). For the latter, falling
    back to `pre..worktree` would show every LATER turn's cumulative delta,
    contradicting this turn's own "0 files changed" footer — so a finished,
    null-post turn returns a stable zero result instead. (The fully-correct
    cumulative `pre..worktree` diff for reverting a non-latest turn is a
    separate, deferred follow-up — not built here.)"""
    if bad := _bad_cid(cid):
        return bad
    entry = _read_checkpoint_entry(root, cid, turnId)
    pre = entry.get("checkpointPre") if entry else None
    if not isinstance(pre, str) or not pre:
        return _err(404, "no_checkpoint", "no checkpoint for this turn")
    post = entry.get("checkpointPost") if entry else None
    target = post if isinstance(post, str) and post else None
    status = entry.get("status") if entry else None
    still_running = status == "running"

    if target is None and not still_running:
        # Finished-but-clean: no post checkpoint because there was nothing
        # to snapshot, not because the turn is still in flight. Zero, not
        # pre..worktree.
        return JSONResponse(
            {
                "nameStatus": [],
                "patch": "",
                "truncated": False,
                "filesChanged": 0,
                "additions": 0,
                "deletions": 0,
            }
        )

    from sanad_terminal.routes_git import _repo

    settings = _settings(request)
    try:
        result = await _repo(request, root).checkpoint_diff(
            pre, target, path=path, max_bytes=settings.coder_diff_max_bytes
        )
    except GitError as exc:
        return _err(500, exc.code, exc.message)
    return JSONResponse(result)


@router.post("/conversations/{cid}/revert")
async def revert(
    _: Gated, root: Root, request: Request, cid: str, body: RevertBody
) -> JSONResponse:
    """Restore the worktree to one turn's PRE-checkpoint state — human-only,
    no agent-facing equivalent.

    P6a Task 3 — THE TOCTOU CLOSURE. Before this, "is it safe to revert?"
    was a two-step snapshot-then-lock: `any(r.busy for r in
    list_conversations(root))`, THEN — as a wholly separate step —
    `async with lock_for(root)`. `POST /send` never took `lock_for` (it
    only guards the blueprint-family routes), so a turn could start in the
    gap between those two steps and race this route's own
    checkpoint/restore: the agent's file writes against `restore_to`'s
    `checkout-index`, and the safety checkpoint's `git add -A` could
    snapshot a half-written file.

    The fix: acquire the SAME workspace write-lease `start_turn`
    (coder_runner.py) now requires before it can start a turn, under the
    reserved `REVERT_HOLDER` identity — ATOMICALLY (`try_acquire` contains
    no `await`; see workspace_lease.py), so there is no separate "check"
    step for a turn to slip in behind. From the instant this call returns
    True, every `start_turn` anywhere in this workspace sees the lease
    already held and fails with `lease_unavailable` (queuing instead — see
    `send()` above) until this route's `finally` releases it. One object
    consulted by both paths closes the window completely.

    On failure, the SAME shipped response as the old busy-check: 409
    `workspace_busy` — the frontend's existing "can't revert while a turn
    is running" handling depends on this exact code/message staying put.

    `lock_for(root)` is STILL taken, INSIDE the lease-held region: it is
    the blueprint apply/rollback/trust mutex, a different actor entirely
    (one that does not take the write-lease), so the two families of
    workspace-tree writers must keep serializing against each other too.
    Order: acquire lease -> read checkpoint entry -> blueprint lock ->
    safety checkpoint -> restore_to -> marker -> (finally) release lease.
    The lease is released on EVERY exit path — success, the 404 checkpoint
    check, a caught `GitError` (500), or any other exception — via the
    outer `try/finally`: a leaked lease here would deadlock the entire
    workspace, since nothing else can ever release on `REVERT_HOLDER`'s
    behalf."""
    if bad := _bad_cid(cid):
        return bad
    settings = _settings(request)
    # Write-lease TTL (P6a Task 3): same app-wide value as `_spawn` passes
    # (see the comment there) — this is the SECOND call site that sets it,
    # deliberately harmless per `lease_for`'s own "update on get" contract.
    lease = lease_for(root, stale_after_seconds=settings.coder_write_lease_ttl_seconds)
    # A UNIQUE identity per revert — NOT the bare sentinel. `try_acquire` is
    # re-entrant on identity, so two concurrent reverts sharing one constant
    # would both be granted and the first to finish would free the lease
    # out from under the second's `checkout-index`.
    holder = new_revert_holder()
    # Liveness gate BEFORE the acquire. `try_acquire`'s stale branch reclaims
    # unconditionally once the TTL elapses, on the assumption that a lease
    # that old means a leaked release — false for a turn that is merely long.
    # Checking only AFTER the acquire is too late: the reclaim has already
    # EVICTED the live turn's lease, so refusing the revert then leaves that
    # turn running with no lease at all and a third conversation free to
    # acquire and write alongside it. Gate first so the theft never happens.
    # This is not a TOCTOU reintroduction: the atomic `try_acquire` below is
    # still the real gate, and a turn that starts in between holds a FRESH
    # (non-stale) lease, so the acquire fails and we 409 anyway.
    if any(r.busy for r in list_conversations(root)):
        return _err(409, "workspace_busy", "a turn is running in this workspace")
    if not lease.try_acquire(holder):
        return _err(409, "workspace_busy", "a turn is running in this workspace")
    try:
        # Re-checked inside the lease region as belt-and-braces. `try_acquire` alone is
        # not sufficient: its stale-reclaim branch grants unconditionally once
        # the TTL elapses, on the assumption that a lease that old means a
        # leaked release — which is exactly the assumption that fails for a
        # long-running turn. P5 gated revert on `any(r.busy)`; keeping that
        # here as well means the TTL stays a leak-RECOVERY mechanism and never
        # becomes a live-turn PREEMPTION mechanism (two writers, one worktree).
        if any(r.busy for r in list_conversations(root)):
            return _err(409, "workspace_busy", "a turn is running in this workspace")
        entry = _read_checkpoint_entry(root, cid, body.turnId)
        pre = entry.get("checkpointPre") if entry else None
        if not isinstance(pre, str) or not pre:
            return _err(404, "no_checkpoint", "no checkpoint for this turn")

        from sanad_terminal.routes_git import _repo

        repo = _repo(request, root)
        async with lock_for(root):
            try:
                # A fresh, monotonically increasing suffix per revert (never
                # reused) — two reverts of the SAME turnId must not clobber
                # each other's safety ref, or the first revert's "undo the
                # undo" net would be silently lost.
                safety_ref = _checkpoint_ref(cid, body.turnId, f"safety-{time.time_ns() // 1000}")
                # `parent=None`: a safety checkpoint is a standalone snapshot of
                # right-now, not chained onto the runner's own checkpoint
                # history — it must never skip-when-clean (create_checkpoint's
                # skip only applies when a `parent` is given).
                safety_sha = await repo.create_checkpoint(
                    safety_ref, f"safety before revert to turn {body.turnId}", parent=None
                )
                await repo.restore_to(pre)
            except GitError as exc:
                return _err(500, exc.code, exc.message)
            _record_revert(
                root,
                cid,
                {"kind": "revert", "turnId": body.turnId, "toPre": pre, "safety": safety_sha},
            )
    finally:
        lease.release(holder)
        # Every OTHER release site hands off to the next FIFO waiter; without
        # this, a conversation that queued behind the revert (202 + a waiter
        # slot, per the queue-at-the-lease contract) has no turn-end of its
        # own to trigger a drain, and would sit stranded until the user sent
        # again.
        await wake_workspace_waiters(root)

    return JSONResponse(
        {"ok": True, "safetyCheckpoint": safety_sha, "reverted": {"turnId": body.turnId}}
    )
