"""One ephemeral worker run = one wire subprocess. Sibling of CoderRunner.

A run is server-minted (`r_<hex12>`), machine-global (the machine is
single-workspace by construction, so the registry keys by bare run id — no
root-scoping needed the way CoderRunner's conversations need), and consumes
exactly one turn: P0 worker runs are afk (no browser attached, no approvals
UI), so a second `start_turn` is a programming error, not a queued follow-up.

Token budget mirrors the wall-clock/step budgets in `wire_runner.py`, but
neither of those knows about token usage — that only exists inside
`StatusUpdate` event payloads, which is why `WireRunner.observe_event` exists
as a seam: the base class journals every event and hands it to this hook
as a no-op, and only RunRunner overrides it to accumulate usage and trip
`_trip_budget` when the run's token ceiling is exceeded.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sanad_terminal.wire_runner import TurnState, WireRunner, WireRunnerError, register_registry

# Server-minted only (P0); the shape keeps ids path- and shell-safe.
RUN_ID_RE = re.compile(r"^r_[a-f0-9]{12}$")


@dataclass(frozen=True, slots=True)
class RunDirs:
    root: Path
    workspace: Path
    home: Path
    share: Path
    bundle: Path
    output_file: Path
    interface_file: Path


def prepare_run_dirs(deployment_root: Path, run_id: str) -> RunDirs:
    """Create (idempotently) the per-run directory layout under
    `<deployment_root>/runs/<run_id>/`, each of workspace/home/kimi-share/
    bundle locked to 0o700 — a run's files are never group- or world-readable.
    """
    root = deployment_root / "runs" / run_id
    sub = {name: root / name for name in ("workspace", "home", "kimi-share", "bundle")}
    for d in sub.values():
        d.mkdir(parents=True, exist_ok=True)
        d.chmod(0o700)
    return RunDirs(
        root=root,
        workspace=sub["workspace"],
        home=sub["home"],
        share=sub["kimi-share"],
        bundle=sub["bundle"],
        output_file=root / "output.json",
        interface_file=sub["bundle"] / "worker.yaml",
    )


class RunRunner(WireRunner):
    """P0 posture: capabilities are false/false, so the base rejects every
    inbound request (any gated tool call resolves DENIED) — a worker run has
    no browser attached to answer an approval or question. Budgets (wall
    clock, steps, tokens) are all mandatory: an afk run must be bounded on
    every axis, not just the ones WireRunner already knows about.
    """

    def __init__(
        self,
        *,
        run_id: str,
        argv: Sequence[str],
        cwd: Path,
        env: dict[str, str],
        uid: int | None = None,
        gid: int | None = None,
        max_turn_seconds: float,
        max_steps_per_turn: int,
        max_tokens_per_run: int,
        on_finished: Callable[[RunRunner], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            client_name="sanad-worker",
            capabilities={"supports_question": False, "supports_plan_mode": False},
            max_turn_seconds=max_turn_seconds,
            max_steps_per_turn=max_steps_per_turn,
        )
        self.run_id = run_id
        self._max_tokens = max_tokens_per_run
        self._tokens_in = 0
        self._tokens_out = 0
        self._model_alias: str | None = None
        self._consumed = False
        self._on_finished = on_finished
        self._finished_fired = False
        self._finish_task: asyncio.Task[None] | None = None
        self._token_trip_task: asyncio.Task[None] | None = None

    async def start_turn(self, user_input: str, send_id: str | None = None) -> TurnState:
        """Exactly one turn per run: a second call is a hard error unless it
        replays the same `send_id` as the turn already in flight/finished
        (the same idempotency the base class gives every runner)."""
        if self._consumed:
            cur = self._current
            if send_id and cur is not None and cur.send_id == send_id:
                return cur
            raise WireRunnerError("run_consumed", "this run already executed its turn")
        state = await super().start_turn(user_input, send_id)
        self._consumed = True
        return state

    def observe_event(self, envelope: dict[str, Any]) -> None:
        """Accumulate token usage from `StatusUpdate` events and trip the
        token budget when the run's ceiling is exceeded. Called synchronously
        from `WireRunner._consume` for every journaled event."""
        if envelope.get("type") != "StatusUpdate":
            return
        payload = envelope.get("payload") or {}
        if not isinstance(payload, dict):
            return
        # `StatusUpdate` (kimi_cli.wire.types) carries no model identifier
        # field today — only context/token usage and plan-mode state — so
        # `_model_alias` stays None here. If a future wire revision adds one
        # (e.g. a `model` or `model_alias` key), capture it the same way
        # `token_usage` is read below.
        usage = payload.get("token_usage") or {}
        if not isinstance(usage, dict):
            return
        self._tokens_in += (
            int(usage.get("input_other", 0) or 0)
            + int(usage.get("input_cache_read", 0) or 0)
            + int(usage.get("input_cache_creation", 0) or 0)
        )
        self._tokens_out += int(usage.get("output", 0) or 0)
        if self._tokens_in + self._tokens_out > self._max_tokens and self._current is not None:
            self._schedule_trip(self._current, "token budget exceeded")

    def _schedule_trip(self, state: TurnState, reason: str) -> None:
        """Task wrapper matching how the wall-clock/step watchers trip the
        budget — `_trip_budget` itself is idempotent, so a burst of events
        past the threshold still yields exactly one journaled breach."""
        if state.budget_tripped:
            return
        if self._token_trip_task is not None and not self._token_trip_task.done():
            return
        self._token_trip_task = asyncio.create_task(self._trip_budget(state, reason))

    def usage_totals(self) -> dict[str, Any]:
        return {
            "tokensIn": self._tokens_in,
            "tokensOut": self._tokens_out,
            "modelAlias": self._model_alias,
        }

    def terminal_item(self) -> dict[str, Any] | None:
        """The consumed turn's final `end`/`error` journal item, if any —
        Task 12 reads this to decide the run's final status for the report."""
        state = self._current
        if state is None or not state.items:
            return None
        for item in reversed(state.items):
            if item.get("kind") in ("end", "error"):
                return item
        return None

    async def wait_finished_hooks(self) -> None:
        """Await the `on_finished` callback task, if one was scheduled — lets
        tests (and callers that need the side effect to have landed) block on
        it deterministically instead of racing the background task."""
        if self._finish_task is not None:
            await self._finish_task

    async def stop(self) -> None:
        """Mirrors the base's own budget-task cleanup for the token-trip
        task, which the base doesn't know about."""
        if self._token_trip_task is not None and not self._token_trip_task.done():
            self._token_trip_task.cancel()
            self._token_trip_task = None
        await super().stop()


# Registry of live runs, keyed by bare run id — the machine is
# single-workspace by construction, unlike CoderRunner's conversations which
# are scoped by workspace root. Registered with wire_runner so an active run
# holds the machine open (IdleStopper probe).
_runs: dict[str, RunRunner] = {}
register_registry(_runs)


def get_run(run_id: str) -> RunRunner | None:
    return _runs.get(run_id)


def put_run(runner: RunRunner) -> None:
    _runs[runner.run_id] = runner


async def drop_run(run_id: str) -> None:
    runner = _runs.pop(run_id, None)
    if runner is not None:
        await runner.stop()


def live_run_count() -> int:
    return len(_runs)
