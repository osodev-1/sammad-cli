"""Internal Worker REST (P0) — flag-gated, ephemeral, single-turn agent
runs invoked by the control plane (`POST /v1/agents/{name}/invoke`).

Unlike the coder/architect bridges, a worker run is server-minted, machine-
global (this machine serves one workspace), and afk: there is no browser
attached to answer approvals or drive a second turn, so `RunRunner` rejects
every inbound request and consumes exactly one `start_turn`. The bundle
(agent.yaml/prompt/worker.yaml/...) arrives inline in the request body and is
written under the run's own sandboxed `bundle/` directory — every relative
path in it must resolve inside that directory, or the run never starts.
"""

from __future__ import annotations

import json
import pwd
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from kimi_cli.exception import AgentSpecError
from kimi_cli.worker import (
    WorkerInputError,
    WorkerSpecError,
    derive_agent_spec,
    load_worker_spec,
    render_input_prompt,
)
from sanad_terminal.routes_workspace import _settings, workspace_root
from sanad_terminal.run_runner import (
    RUN_ID_RE,
    RunRunner,
    drop_run,
    get_run,
    prepare_run_dirs,
    put_run,
)
from sanad_terminal.wire_runner import WireRunnerError
from sanad_terminal.workspace import build_child_env

router = APIRouter(prefix="/internal/worker")

# Depended on purely for its side effect (the same task-mode bearer check
# every other /internal/* route uses) — a worker run's own directories are
# rooted at <data_dir>/runs/<run_id>/, never at the returned workspace path.
Authed = Annotated[Path, Depends(workspace_root)]


class WorkerDisabled(Exception):
    pass


def _gate(request: Request) -> None:
    if not _settings(request).worker_enabled:
        raise WorkerDisabled()


Gated = Annotated[None, Depends(_gate)]


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


class BundleBody(BaseModel):
    files: dict[str, str] = Field(default_factory=dict)


class BudgetsBody(BaseModel):
    max_turn_seconds: float = Field(alias="maxTurnSeconds")
    max_steps_per_turn: int = Field(alias="maxStepsPerTurn")
    max_tokens_per_run: int = Field(alias="maxTokensPerRun")

    model_config = {"populate_by_name": True}


class RunStartBody(BaseModel):
    run_id: str = Field(alias="runId")
    send_id: str = Field(alias="sendId")
    input: dict[str, Any] = Field(default_factory=dict)
    bundle: BundleBody
    budgets: BudgetsBody
    session_token: str = Field(alias="sessionToken")
    trace_upload_url: str = Field(default="", alias="traceUploadUrl")

    model_config = {"populate_by_name": True}


def make_on_finished(request: Request) -> Callable[[RunRunner], Awaitable[None]] | None:
    """P0 placeholder: nothing observes a run's completion yet, so `RunRunner`
    is handed no callback and its terminal-status hook stays dormant. Task 12
    swaps this factory's body for one that uploads the trace and reports the
    run's outcome to the control plane — the call site (`on_finished=
    make_on_finished(request)`) doesn't change.
    """
    del request
    return None


def _turn_id(runner: RunRunner) -> str | None:
    summary = runner.turn_summary()
    return summary["turnId"] if summary else None


async def _ndjson(items: AsyncIterator[dict[str, Any]]) -> AsyncIterator[bytes]:
    try:
        async for item in items:
            yield json.dumps(item).encode("utf-8") + b"\n"
    except WireRunnerError as exc:
        yield (
            json.dumps({"kind": "error", "code": exc.code, "message": exc.message}).encode(
                "utf-8"
            )
            + b"\n"
        )


def _stream(runner: RunRunner, turn_id: str, from_seq: int = 0) -> StreamingResponse:
    return StreamingResponse(
        _ndjson(runner.follow(turn_id, from_seq)), media_type="application/x-ndjson"
    )


@router.post("/runs", response_model=None)
async def start_run(
    _: Gated, __: Authed, request: Request, body: RunStartBody
) -> StreamingResponse | JSONResponse:
    if not RUN_ID_RE.fullmatch(body.run_id):
        return _err(400, "bad_run_id", "malformed run id")

    existing = get_run(body.run_id)
    if existing is not None:
        turn_id = _turn_id(existing)
        state = existing.get_turn(turn_id) if turn_id else None
        if turn_id is not None and state is not None and state.send_id == body.send_id:
            return _stream(existing, turn_id)
        return _err(409, "busy_run", "a different run is already using this id")

    settings = _settings(request)
    dirs = prepare_run_dirs(settings.data_dir, body.run_id)

    files = body.bundle.files
    if not files:
        return _err(400, "bad_bundle", "bundle must contain at least one file")

    bundle_root = dirs.bundle.resolve()
    for rel, content in files.items():
        rel_path = Path(rel)
        if rel_path.is_absolute():
            return _err(400, "bad_bundle", f"absolute path not allowed: {rel}")
        resolved = (dirs.bundle / rel_path).resolve()
        # `resolved == bundle_root` catches "." / "" / "sub/.." — every key
        # that normalizes back to the bundle directory itself, which
        # `is_relative_to` alone would happily accept (a path is relative to
        # itself) and then blow up `write_text` with IsADirectoryError.
        if resolved == bundle_root or not resolved.is_relative_to(bundle_root):
            return _err(400, "bad_bundle_path", rel)
        try:
            resolved.parent.mkdir(parents=True, exist_ok=True)
            resolved.write_text(content, encoding="utf-8")
        except OSError as exc:
            # A key that conflicts with another (e.g. "a" and "a/b.txt" both
            # present — one wants "a" as a file, the other as a directory)
            # raises FileExistsError/IsADirectoryError/NotADirectoryError
            # here rather than at the containment check above; surface it
            # the same way instead of a bare 500.
            return _err(400, "bad_bundle_path", f"{rel}: {exc}")

    try:
        spec = load_worker_spec(dirs.interface_file)
    except WorkerSpecError as exc:
        return _err(400, "bad_bundle", str(exc))

    try:
        prompt = render_input_prompt(spec, body.input)
    except WorkerInputError as exc:
        return _err(400, "bad_input", str(exc))

    try:
        derived = derive_agent_spec(dirs.bundle / "agent.yaml", dirs.bundle)
    except (AgentSpecError, OSError) as exc:
        return _err(400, "bad_bundle", str(exc))

    argv = [
        *settings.spawn_argv,
        "--wire",
        "--session",
        body.run_id,
        "--agent-file",
        str(derived),
        "--work-dir",
        str(dirs.workspace),
    ]
    env = build_child_env(
        user_dir=dirs.root,
        session_token=body.session_token,
        api_base_url=settings.child_api_base_url,
        cols=80,
        rows=24,
    )
    env = {
        **env,
        "KIMI_WORKER_INTERFACE_FILE": str(dirs.interface_file),
        "KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file),
        "KIMI_SHARE_DIR": str(dirs.share),
    }

    uid = gid = None
    if settings.agent_user:
        pw = pwd.getpwnam(settings.agent_user)
        uid, gid = pw.pw_uid, pw.pw_gid

    runner = RunRunner(
        run_id=body.run_id,
        argv=argv,
        cwd=dirs.workspace,
        env=env,
        uid=uid,
        gid=gid,
        max_turn_seconds=min(body.budgets.max_turn_seconds, settings.worker_max_turn_seconds),
        max_steps_per_turn=min(body.budgets.max_steps_per_turn, settings.worker_max_steps_per_turn),
        max_tokens_per_run=min(body.budgets.max_tokens_per_run, settings.worker_max_tokens_per_run),
        on_finished=make_on_finished(request),
    )
    try:
        await runner.start()
    except WireRunnerError as exc:
        await runner.stop()
        return _err(503, exc.code, exc.message)

    put_run(runner)

    try:
        state = await runner.start_turn(prompt, body.send_id)
    except WireRunnerError as exc:
        # Symmetric with the start() failure above: a runner that never got
        # a turn must not linger in the registry — it would keep
        # `runners_hold_machine` reporting the machine as busy, and every
        # retry of this runId would 409 `busy_run` forever since `get_run`
        # would keep finding a dead, turn-less entry. `drop_run` both stops
        # the runner and removes it, freeing the id for a fresh attempt.
        await drop_run(body.run_id)
        return _err(409, exc.code, exc.message)

    return _stream(runner, state.turn_id)


@router.get("/runs/{rid}/follow", response_model=None)
async def follow_run(
    _: Gated, __: Authed, rid: str, from_seq: int = 0
) -> StreamingResponse | JSONResponse:
    if not RUN_ID_RE.fullmatch(rid):
        return _err(400, "bad_run_id", "malformed run id")
    runner = get_run(rid)
    turn_id = _turn_id(runner) if runner is not None else None
    if runner is None or turn_id is None:
        return _err(404, "unknown_run", "no such run")
    return _stream(runner, turn_id, from_seq)


@router.post("/runs/{rid}/cancel")
async def cancel_run(_: Gated, __: Authed, rid: str) -> JSONResponse:
    if not RUN_ID_RE.fullmatch(rid):
        return _err(400, "bad_run_id", "malformed run id")
    runner = get_run(rid)
    if runner is None:
        return _err(404, "unknown_run", "no such run")
    if runner.alive:
        await runner.cancel()
    return JSONResponse({"ok": True})
