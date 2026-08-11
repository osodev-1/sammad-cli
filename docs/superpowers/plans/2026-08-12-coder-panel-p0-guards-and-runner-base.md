# Coder Panel P0 — Guards + Runner Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the platform guards and the generalized wire-runner base that every later coder-panel phase builds on: `WireRunner` extraction (Architect byte-compatible), a flag-gated `CoderRunner` that spawns the default agent per conversation with deny-by-default approvals, turn budgets, IdleStopper activity probes, and the fail-closed web allowlist.

**Architecture:** Extract everything in `ArchitectRunner` into a parametrized `WireRunner` base (capabilities, request hook, budgets); `ArchitectRunner` becomes a thin subclass with byte-identical behavior. A new `CoderRunner` (one per conversation, `sanad --wire --session <id>`) reuses the base with the P0 posture: capabilities `false/false` so every inbound request is rejected → every gated tool call is denied (the approvals bridge that answers them is P1). IdleStopper gains probes so a running runner turn holds the machine (also fixes the Architect's latent idle-kill bug).

**Tech Stack:** Python 3.14 / FastAPI / asyncio subprocess (terminal-server, tests: `uv run pytest`); TypeScript/Next.js (sanad-web, tests: `pnpm test` = vitest). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md`.

## Global Constraints

- **Architect byte-compatibility:** `routes_architect.py` and all existing architect tests must pass UNCHANGED. `ArchitectRunner` defaults must reproduce today's behavior exactly (capabilities `supports_question: false, supports_plan_mode: false`, reject inbound requests, no budgets).
- **Commits are Omar-only** — repo convention `sanad: <lowercase description>`. NEVER add `Co-Authored-By`, `Generated with`, or any Claude/AI attribution to any commit.
- **Fail closed:** `CODER_ENABLED` unset/anything-but-`"1"` → all `/internal/coder/*` routes 404. `SANAD_CODER_PANEL_EMAILS` empty/unset → `isCoderPanelAllowed` returns false for everyone.
- **Budget defaults (spec):** `CODER_MAX_TURN_SECONDS=3600`, `CODER_MAX_STEPS_PER_TURN=200`. `None`/unset budget params on `WireRunner` = unlimited (architect posture).
- **P0 approval posture:** most-restrictive — CoderRunner initializes `supports_question: false, supports_plan_mode: false` and rejects every inbound JSON-RPC `request` (deny-by-default). P1 flips capabilities to true/true when the respond bridge lands. Do not "helpfully" enable them now.
- Working tree has unrelated dirty files (`ArchitectPanel.tsx`, `GraphPanel.tsx`, `transcript.ts`, `architect-transcript.test.ts`, `.serena/`, a report md). **Never `git add -A`** — stage only the files each task names.
- terminal-server test commands run from `/Users/omar/Development/sammad-cli/terminal-server`; sanad-web from `/Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web`.

---

### Task 1: `WireRunner` base extraction (Architect byte-compatible)

**Files:**
- Create: `terminal-server/src/sanad_terminal/wire_runner.py`
- Modify: `terminal-server/src/sanad_terminal/architect_runner.py` (shrinks to a subclass + registry + re-exports)
- Test: existing `terminal-server/tests/test_routes_architect.py` (must pass unchanged — that IS the byte-compatibility gate)

**Interfaces:**
- Consumes: current `architect_runner.py` (477 lines — read it first; every mechanic moves).
- Produces (later tasks rely on these exact names):
  - `wire_runner.WireRunnerError(code: str, message: str)` (exception; `.code`, `.message`)
  - `wire_runner.TurnState` (dataclass: `turn_id, user_input, status, started_at, send_id, items, last_seq, summary()` — unchanged shape, plus `steps: int = 0` added in Task 2)
  - `wire_runner.WireRunner(*, argv, cwd, env, uid=None, gid=None, client_name: str, capabilities: dict[str, bool], max_turn_seconds: float | None = None, max_steps_per_turn: int | None = None)` with the full existing surface: `alive, busy, idle_seconds, start(), stop(), start_turn(user_input, send_id=None), turn_summary(), get_turn(turn_id), follow(turn_id, from_seq=0), ask(...), cancel()`
  - Overridable hook: `def on_request(self, rid: Any, params: dict[str, Any]) -> bool` — return True if handled; base returns False → `_reject(rid)` (today's behavior)
  - Registry helpers for the idle probe: `wire_runner.register_registry(reg: dict) -> None`, `wire_runner.runners_hold_machine(grace_seconds: float) -> bool`
  - `architect_runner` keeps exporting: `ArchitectError` (alias of `WireRunnerError`), `ArchitectRunner`, `get_runner`, `put_runner`, `drop_runner`, `shutdown_runners` — so `routes_architect.py` needs zero changes.

- [ ] **Step 1: Green baseline**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_routes_architect.py -q`
Expected: all pass. If not, STOP — fix nothing, report.

- [ ] **Step 2: Create `wire_runner.py`**

Move the whole of `architect_runner.py` into `wire_runner.py`, then apply exactly these deltas (everything not named below moves verbatim — `_preexec`, `_TURN_KEEP`, `stop()`, `_consume`, `_append`, `turn_summary`, `get_turn`, `follow`, `ask`, `cancel`, `_next_id`, `_new_pending`, `_touch`, `_send`, `_read_loop`, `_reject`):

```python
"""Generalized wire-subprocess runner — the server-side bridge for any
`sanad --wire` agent (Architect today, Coder from P0 on).

Owns one JSON-RPC-over-stdio subprocess, serializes turns against it, and
keeps a server-authoritative per-turn journal so a dropped browser never
orphans a turn. Subclasses choose the handshake capabilities and how inbound
`request` frames are handled (the base rejects them — a pure one-way stream).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from collections.abc import AsyncIterator, Callable, Sequence
from pathlib import Path
from typing import Any

from loguru import logger

_WIRE_PROTOCOL_VERSION = "1.10"
_INIT_TIMEOUT_SECONDS = 30.0
_TURN_KEEP = 5


class WireRunnerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
```

`TurnState` moves verbatim (the `steps` field arrives in Task 2). Class header + `__init__` + `start()` + `_dispatch` become:

```python
class WireRunner:
    """Owns one wire subprocess and serializes turns against it."""

    def __init__(
        self,
        *,
        argv: Sequence[str],
        cwd: Path,
        env: dict[str, str],
        uid: int | None = None,
        gid: int | None = None,
        client_name: str,
        capabilities: dict[str, bool],
        max_turn_seconds: float | None = None,
        max_steps_per_turn: int | None = None,
    ) -> None:
        self._argv = list(argv)
        self._cwd = cwd
        self._env = env
        self._uid = uid
        self._gid = gid
        self._client_name = client_name
        self._capabilities = dict(capabilities)
        self._max_turn_seconds = max_turn_seconds
        self._max_steps_per_turn = max_steps_per_turn
        # ... every remaining attribute from today's __init__ verbatim ...
```

In `start()`, the initialize frame's hardcoded values become the params:

```python
                    "params": {
                        "protocol_version": _WIRE_PROTOCOL_VERSION,
                        "client": {"name": self._client_name, "version": "1"},
                        "capabilities": self._capabilities,
                    },
```

and both `raise ArchitectError(...)` sites in `start()` become `raise WireRunnerError(...)` (same codes/messages). Every other `ArchitectError` raise in the file is renamed the same way; `"architect read loop error"` → `"wire runner read loop error"`; `"architect exited"` / `"architect is not running"` / `"architect did not initialize"` keep their message TEXT but it's fine to generalize to `"agent ..."` — routes only match on `.code`, never message. In `_dispatch`, the `request` branch becomes the hook:

```python
        if method == "request":
            rid = msg.get("id")
            params = msg.get("params")
            handled = False
            if rid is not None:
                try:
                    handled = self.on_request(rid, params if isinstance(params, dict) else {})
                except Exception:
                    logger.exception("on_request hook failed; rejecting")
                    handled = False
            if rid is not None and not handled:
                asyncio.ensure_future(self._reject(rid))
            return
```

with the base hook right below `_dispatch`:

```python
    def on_request(self, rid: Any, params: dict[str, Any]) -> bool:
        """Handle an inbound JSON-RPC request. Base: unhandled → caller rejects.

        Subclasses that negotiate supports_question/plan_mode override this
        (P1's approvals bridge). Returning False keeps today's defensive
        reject so a stray request can never wedge the subprocess.
        """
        return False
```

At module bottom, ADD the probe registry (used by Task 3; budgets land in Task 2):

```python
# Registries of live runners, one dict per runner module (architect, coder).
# The IdleStopper polls these so an active runner holds the machine open —
# without this, a panel-driven turn with no PTY and no attached browser
# would let the machine idle-stop itself mid-task.
_registries: list[dict[str, Any]] = []


def register_registry(reg: dict[str, Any]) -> None:
    _registries.append(reg)


def runners_hold_machine(grace_seconds: float) -> bool:
    """True if any live runner should keep the machine up: a running turn,
    or recent activity (post-turn grace so a fast follow-up can't race the
    stopper)."""
    for reg in _registries:
        for runner in reg.values():
            if runner.alive and (runner.busy or runner.idle_seconds < grace_seconds):
                return True
    return False
```

- [ ] **Step 3: Rewrite `architect_runner.py` as the thin subclass**

Replace the entire file with:

```python
"""The Architect runner — `sanad --wire --agent architect` on the WireRunner
base with the read-only posture: questions and plan mode OFF, every inbound
request rejected. Governance holds by construction: the agent it runs cannot
mutate the blueprint; applying a drafted change is a separate, user-driven
POST to the transaction endpoint (M2).
"""

from __future__ import annotations

from pathlib import Path

from sanad_terminal.wire_runner import (
    TurnState,
    WireRunner,
    WireRunnerError,
    register_registry,
)

# routes_architect.py catches these names — keep them exported here.
ArchitectError = WireRunnerError

__all__ = [
    "ArchitectError",
    "ArchitectRunner",
    "TurnState",
    "drop_runner",
    "get_runner",
    "put_runner",
    "shutdown_runners",
]


class ArchitectRunner(WireRunner):
    def __init__(self, *, argv, cwd, env, uid=None, gid=None) -> None:  # noqa: ANN001
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            client_name="sanad-architect-bridge",
            capabilities={"supports_question": False, "supports_plan_mode": False},
        )


# One runner per workspace root — mirrors the per-workspace lock in
# routes_blueprint. On a one-project-per-machine host there is exactly one.
_runners: dict[str, ArchitectRunner] = {}
register_registry(_runners)


def get_runner(root: Path) -> ArchitectRunner | None:
    return _runners.get(str(root))


def put_runner(root: Path, runner: ArchitectRunner) -> None:
    _runners[str(root)] = runner


async def drop_runner(root: Path) -> None:
    runner = _runners.pop(str(root), None)
    if runner is not None:
        await runner.stop()


async def shutdown_runners() -> None:
    runners = list(_runners.values())
    _runners.clear()
    for runner in runners:
        await runner.stop()
```

- [ ] **Step 4: Verify byte-compatibility**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/ -q`
Expected: entire suite passes with ZERO test-file changes. Any architect test failure = the extraction changed behavior — fix `wire_runner.py`, not the test.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/wire_runner.py terminal-server/src/sanad_terminal/architect_runner.py && git commit -m "sanad: extract WireRunner base from ArchitectRunner (byte-compatible)"
```

---

### Task 2: Turn budgets (wall-clock + step) in `WireRunner`

**Files:**
- Modify: `terminal-server/src/sanad_terminal/wire_runner.py`
- Create: `terminal-server/tests/_fake_coder_wire.py`
- Create: `terminal-server/tests/test_wire_runner.py`

**Interfaces:**
- Consumes: Task 1's `WireRunner` (`max_turn_seconds`, `max_steps_per_turn` ctor params already exist, currently inert).
- Produces: budget enforcement — journal item `{"kind": "error", "code": "turn_budget_exceeded", "message": "..."}` followed by turn cancellation; `TurnState.steps: int` counter. Fake wire modes (Tasks 5–6 reuse): plain prompt → TurnBegin/TextPart/finish; input containing `HANG` → turn stays open until `cancel`; `STEPHANG:<n>` → n StepBegin events then hang; `ASK_APPROVAL` → emits a `request` frame, echoes the client's response as a `RequestOutcome` event, then finishes.

- [ ] **Step 1: Write the fake coder wire**

Create `terminal-server/tests/_fake_coder_wire.py`:

```python
"""A minimal stand-in for `sanad --wire --session <id>` used in tests.

Modes are keyed on the prompt text:
- default:        TurnBegin + TextPart, then finish.
- "HANG":         TurnBegin, then the turn stays open until a cancel arrives
                  (the wall-clock-budget and cancel paths).
- "STEPHANG:<n>": n StepBegin events, then hang until cancel (step budget).
- "ASK_APPROVAL": emits a JSON-RPC `request` (ApprovalRequest shape), waits
                  for the client's response line, echoes it back as a
                  RequestOutcome event, then finishes — the deny-by-default
                  round-trip proof.
"""

import json
import sys


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _event(type_name: str, payload: dict) -> None:
    _write({"jsonrpc": "2.0", "method": "event", "params": {"type": type_name, "payload": payload}})


def _read() -> dict | None:
    raw = sys.stdin.readline()
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return {}
    try:
        msg = json.loads(raw)
        return msg if isinstance(msg, dict) else {}
    except ValueError:
        return {}


def _hang_until_cancel(prompt_id) -> None:
    """Keep the turn open; resolve it as cancelled when the bridge says so."""
    while True:
        msg = _read()
        if msg is None:
            return
        if msg.get("method") == "cancel":
            _write({"jsonrpc": "2.0", "id": msg.get("id"), "result": {}})
            _write({"jsonrpc": "2.0", "id": prompt_id, "result": {"status": "cancelled"}})
            return


def main() -> None:
    while True:
        msg = _read()
        if msg is None:
            return
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            caps = msg.get("params", {}).get("capabilities", {})
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {
                        "protocol_version": "1.10",
                        "server": {"name": "fake-coder", "version": "0"},
                        "capabilities": caps,
                    },
                }
            )
        elif method == "prompt":
            user_input = msg.get("params", {}).get("user_input", "")
            _event("TurnBegin", {"user_input": user_input})
            if user_input.startswith("STEPHANG:"):
                for i in range(int(user_input.split(":", 1)[1])):
                    _event("StepBegin", {"step": i})
                _hang_until_cancel(mid)
            elif "HANG" in user_input:
                _hang_until_cancel(mid)
            elif "ASK_APPROVAL" in user_input:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": "req_1",
                        "method": "request",
                        "params": {
                            "type": "ApprovalRequest",
                            "payload": {
                                "id": "req_1",
                                "tool_call_id": "call_1",
                                "sender": "shell",
                                "action": "run command",
                                "description": "ls -la",
                                "display": [],
                            },
                        },
                    }
                )
                response = _read()
                _event("RequestOutcome", {"response": response})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
            else:
                _event("TextPart", {"type": "text", "text": "hello from coder"})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
        elif method == "cancel":
            _write({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write the failing budget tests**

Create `terminal-server/tests/test_wire_runner.py`:

```python
"""WireRunner unit tests driven by the fake coder wire — budgets, the
deny-by-default request hook, and the probe registry. No LLM, no FastAPI."""

import asyncio
import sys
from pathlib import Path

import pytest
from sanad_terminal.wire_runner import (
    WireRunner,
    register_registry,
    runners_hold_machine,
)

FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"


def _runner(**kwargs) -> WireRunner:
    return WireRunner(
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=Path.cwd(),
        env={},
        client_name="test-bridge",
        capabilities={"supports_question": False, "supports_plan_mode": False},
        **kwargs,
    )


async def _drain(runner: WireRunner, turn_id: str) -> list[dict]:
    return [item async for item in runner.follow(turn_id, 0)]


@pytest.mark.asyncio
async def test_wall_clock_budget_cancels_a_hung_turn():
    runner = _runner(max_turn_seconds=0.3)
    await runner.start()
    try:
        state = await runner.start_turn("HANG please")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        codes = [i.get("code") for i in items if i.get("kind") == "error"]
        assert "turn_budget_exceeded" in codes
        assert state.status == "cancelled"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_step_budget_cancels_a_looping_turn():
    runner = _runner(max_steps_per_turn=2)
    await runner.start()
    try:
        state = await runner.start_turn("STEPHANG:5")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        codes = [i.get("code") for i in items if i.get("kind") == "error"]
        assert "turn_budget_exceeded" in codes
        assert state.status == "cancelled"
        assert state.steps >= 2
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_no_budget_means_unlimited():
    runner = _runner()  # architect posture: both budgets None
    await runner.start()
    try:
        state = await runner.start_turn("STEPHANG:3")
        # Give any (buggy) budget machinery a beat to misfire, then cancel.
        await asyncio.sleep(0.3)
        assert state.status == "running"
        await runner.cancel()
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        assert all(i.get("code") != "turn_budget_exceeded" for i in items)
        assert state.status == "cancelled"
    finally:
        await runner.stop()
```

- [ ] **Step 3: Run to verify the budget tests fail**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: `test_wall_clock_budget_cancels_a_hung_turn` and `test_step_budget_cancels_a_looping_turn` FAIL (no `turn_budget_exceeded` ever journaled); `test_no_budget_means_unlimited` PASSES (proves the fake + drain harness works).

- [ ] **Step 4: Implement budgets in `wire_runner.py`**

(a) `TurnState` gains a counter — add after `items`:

```python
    steps: int = 0
```

(b) `WireRunner.__init__` gains `self._budget_task: asyncio.Task[None] | None = None`.

(c) In `start_turn`, right after `self._consumer = asyncio.create_task(self._consume(state, queue))`, add:

```python
        if self._max_turn_seconds is not None:
            self._budget_task = asyncio.create_task(
                self._budget_watch(state, self._max_turn_seconds)
            )
```

(d) Add the watchdog + a shared trip helper (place after `_consume`):

```python
    async def _budget_watch(self, state: TurnState, limit: float) -> None:
        await asyncio.sleep(limit)
        if state.status == "running":
            await self._trip_budget(state, f"turn exceeded {limit:.0f}s wall clock")

    async def _trip_budget(self, state: TurnState, reason: str) -> None:
        """Journal the breach, then cancel — the turn ends `cancelled` with a
        `turn_budget_exceeded` error item explaining why."""
        await self._append(
            state,
            {"kind": "error", "code": "turn_budget_exceeded", "message": reason},
        )
        await self.cancel()
```

(e) In `_consume`, count steps and trip the step budget. Inside the `while True` loop, after `kind = item.get("kind")`, add:

```python
                if kind == "event":
                    event = item.get("event") or {}
                    if isinstance(event, dict) and event.get("type") == "StepBegin":
                        state.steps += 1
                        if (
                            self._max_steps_per_turn is not None
                            and state.steps > self._max_steps_per_turn
                        ):
                            asyncio.create_task(
                                self._trip_budget(
                                    state,
                                    f"turn exceeded {self._max_steps_per_turn} steps",
                                )
                            )
```

(`asyncio.create_task`, not `await` — `_trip_budget` appends to the journal, and `_append` is safe from another task, but awaiting `cancel()` inside the consume loop would deadlock the drain while the fake waits to answer.)

(f) In `_consume`'s `finally` block and in `stop()`, cancel the watchdog — add to both:

```python
            if self._budget_task is not None and not self._budget_task.done():
                self._budget_task.cancel()
                self._budget_task = None
```

(In `stop()` place it next to the `_consumer` cancellation; in `_consume`'s `finally`, before the notify.)

- [ ] **Step 5: Run the new tests + the full suite**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py tests/test_routes_architect.py -q`
Expected: ALL pass (architect stays green — its budgets are `None`).

- [ ] **Step 6: Add the deny-by-default request round-trip test (should already pass)**

Append to `terminal-server/tests/test_wire_runner.py`:

```python
@pytest.mark.asyncio
async def test_inbound_request_is_rejected_by_default():
    """P0 posture: no bridge, so every request is refused with -32601 and the
    turn still completes — a gated tool call becomes a denial, never a hang."""
    runner = _runner()
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert len(outcomes) == 1
        assert outcomes[0]["error"]["code"] == -32601
        assert state.status == "finished"
    finally:
        await runner.stop()
```

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: PASS (this is the golden regression that P1 will consciously flip).

- [ ] **Step 7: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/wire_runner.py terminal-server/tests/_fake_coder_wire.py terminal-server/tests/test_wire_runner.py && git commit -m "sanad: turn budgets (wall clock + steps) and request-reject golden test on WireRunner"
```

---

### Task 3: IdleStopper activity probes

**Files:**
- Modify: `terminal-server/src/sanad_terminal/idle.py`
- Modify: `terminal-server/src/sanad_terminal/app.py:67-75` (probe registration)
- Create: `terminal-server/tests/test_idle.py`

**Interfaces:**
- Consumes: `wire_runner.runners_hold_machine(grace_seconds)` (Task 1).
- Produces: `IdleStopper.add_probe(probe: Callable[[], bool])`; `IdleStopper._stop_machine()` (extracted seam tests monkeypatch — behavior unchanged in prod). Any truthy probe counts as activity exactly like `manager.count > 0`.

- [ ] **Step 1: Write the failing tests**

Create `terminal-server/tests/test_idle.py`:

```python
"""IdleStopper probe semantics: a truthy probe holds the machine exactly like
a live PTY session; a crashing probe fails SAFE (machine stays up)."""

import asyncio

import pytest
from sanad_terminal.idle import IdleStopper


class _FakeManager:
    def __init__(self, count: int = 0) -> None:
        self.count = count


def _stopper(manager: _FakeManager) -> tuple[IdleStopper, asyncio.Event]:
    stopper = IdleStopper(manager, idle_stop_seconds=0.05, tick_seconds=0.01)
    stopped = asyncio.Event()
    stopper._stop_machine = stopped.set  # type: ignore[method-assign]
    return stopper, stopped


@pytest.mark.asyncio
async def test_stops_when_nothing_holds():
    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.start()
    try:
        await asyncio.wait_for(stopped.wait(), timeout=2.0)
    finally:
        await stopper.stop()


@pytest.mark.asyncio
async def test_truthy_probe_holds_the_machine():
    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.add_probe(lambda: True)
    stopper.start()
    try:
        await asyncio.sleep(0.3)  # several idle windows
        assert not stopped.is_set()
    finally:
        await stopper.stop()


@pytest.mark.asyncio
async def test_probe_release_lets_it_stop():
    holding = {"on": True}
    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.add_probe(lambda: holding["on"])
    stopper.start()
    try:
        await asyncio.sleep(0.2)
        assert not stopped.is_set()
        holding["on"] = False
        await asyncio.wait_for(stopped.wait(), timeout=2.0)
    finally:
        await stopper.stop()


@pytest.mark.asyncio
async def test_crashing_probe_fails_safe():
    def boom() -> bool:
        raise RuntimeError("probe bug")

    stopper, stopped = _stopper(_FakeManager(count=0))
    stopper.add_probe(boom)
    stopper.start()
    try:
        await asyncio.sleep(0.3)
        assert not stopped.is_set()  # never kill a machine because a probe broke
    finally:
        await stopper.stop()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_idle.py -q`
Expected: FAIL — `AttributeError: 'IdleStopper' object has no attribute 'add_probe'` (and `_stop_machine` missing).

- [ ] **Step 3: Implement probes in `idle.py`**

Modify `IdleStopper` (docstring: append the sentence `Runner activity (architect/coder turns) registers as probes — a machine mid-turn is needed even with zero PTY sessions and zero HTTP traffic.`):

```python
class IdleStopper:
    def __init__(
        self,
        manager: SessionManager,
        *,
        idle_stop_seconds: float,
        tick_seconds: float = 15.0,
    ) -> None:
        self._manager = manager
        self._idle_stop = idle_stop_seconds
        self._tick = tick_seconds
        self._last_activity = time.monotonic()
        self._task: asyncio.Task[None] | None = None
        self._probes: list[Callable[[], bool]] = []

    def add_probe(self, probe: Callable[[], bool]) -> None:
        """A zero-arg callable; truthy = the machine is needed."""
        self._probes.append(probe)

    def touch(self) -> None:
        self._last_activity = time.monotonic()

    def _needed(self) -> bool:
        if self._manager.count > 0:
            return True
        for probe in self._probes:
            try:
                if probe():
                    return True
            except Exception:
                logger.exception("idle probe failed — treating machine as needed")
                return True
        return False

    def _stop_machine(self) -> None:
        # SIGTERM → uvicorn graceful shutdown → clean exit → task stops.
        os.kill(os.getpid(), signal.SIGTERM)

    # start()/stop() unchanged.

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._tick)
            if self._needed():
                self._last_activity = time.monotonic()
                continue
            quiet = time.monotonic() - self._last_activity
            if quiet >= self._idle_stop:
                logger.info("idle for {:.0f}s with zero sessions — stopping the machine", quiet)
                self._stop_machine()
                return
```

Add `from collections.abc import Callable` to the imports.

- [ ] **Step 4: Run the tests**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_idle.py -q`
Expected: 4 passed.

- [ ] **Step 5: Register the runner probe in `app.py`**

In `create_app`, immediately after the `idle_stopper = (...)` block (`app.py:67-75`), add:

```python
    if idle_stopper is not None:
        from sanad_terminal.wire_runner import runners_hold_machine

        # A running architect/coder turn (or one that just finished, within the
        # idle window) holds the machine even with zero PTYs and no HTTP.
        idle_stopper.add_probe(
            lambda: runners_hold_machine(resolved.idle_stop_seconds)
        )
```

- [ ] **Step 6: Full suite**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/ -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/idle.py terminal-server/src/sanad_terminal/app.py terminal-server/tests/test_idle.py && git commit -m "sanad: IdleStopper probes — a running wire turn holds the machine"
```

---

### Task 4: Settings — coder flags + budgets

**Files:**
- Modify: `terminal-server/src/sanad_terminal/settings.py`
- Modify: `terminal-server/tests/test_settings.py` (append tests)

**Interfaces:**
- Produces: `TerminalSettings.coder_enabled: bool` (env `CODER_ENABLED`, truthy only when exactly `"1"`), `coder_max_turn_seconds: float` (env `CODER_MAX_TURN_SECONDS`, default 3600), `coder_max_steps_per_turn: int` (env `CODER_MAX_STEPS_PER_TURN`, default 200). Tasks 5–6 consume all three.

- [ ] **Step 1: Write the failing tests**

Append to `terminal-server/tests/test_settings.py` (match the file's existing style — it constructs `TerminalSettings.load(env={...})` with dict envs; reuse whatever minimal base env existing tests pass for railway mode, e.g. `{"TERMINAL_SHARED_SECRET": "s", "TERMINAL_SPAWN_ARGV": "echo run"}` — read the file's first test and copy its base dict):

```python
def test_coder_flags_default_off_and_budgets_default(base_env):
    s = TerminalSettings.load(env=base_env)
    assert s.coder_enabled is False
    assert s.coder_max_turn_seconds == 3600.0
    assert s.coder_max_steps_per_turn == 200


def test_coder_flags_parse_from_env(base_env):
    s = TerminalSettings.load(
        env={
            **base_env,
            "CODER_ENABLED": "1",
            "CODER_MAX_TURN_SECONDS": "120",
            "CODER_MAX_STEPS_PER_TURN": "7",
        }
    )
    assert s.coder_enabled is True
    assert s.coder_max_turn_seconds == 120.0
    assert s.coder_max_steps_per_turn == 7


def test_coder_enabled_requires_exactly_one(base_env):
    assert TerminalSettings.load(env={**base_env, "CODER_ENABLED": "true"}).coder_enabled is False
    assert TerminalSettings.load(env={**base_env, "CODER_ENABLED": "0"}).coder_enabled is False
```

If `test_settings.py` has no `base_env` fixture, define one at module top mirroring the env its first passing test uses.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_settings.py -q`
Expected: new tests FAIL (`coder_enabled` attribute missing); old tests pass.

- [ ] **Step 3: Implement**

In `settings.py`, add to the dataclass after `shell_argv` (line 50):

```python
    # -- coder panel (P0) -----------------------------------------------------
    # Default-off master switch for /internal/coder/*; "1" is the only truthy.
    coder_enabled: bool = False
    # Panel-turn budgets — deliberately far below the CLI's raw 1000-step /
    # 24h-token ceilings; a runaway browser-driven turn burns quota unattended.
    coder_max_turn_seconds: float = 3600.0
    coder_max_steps_per_turn: int = 200
```

and to the `cls(...)` call in `load` (after `shell_argv=...`):

```python
            coder_enabled=e.get("CODER_ENABLED", "") == "1",
            coder_max_turn_seconds=float(e.get("CODER_MAX_TURN_SECONDS", "3600")),
            coder_max_steps_per_turn=int(e.get("CODER_MAX_STEPS_PER_TURN", "200")),
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_settings.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/settings.py terminal-server/tests/test_settings.py && git commit -m "sanad: coder panel settings — CODER_ENABLED flag and turn budgets"
```

---

### Task 5: `CoderRunner` + per-conversation registry

**Files:**
- Create: `terminal-server/src/sanad_terminal/coder_runner.py`
- Test: extend `terminal-server/tests/test_wire_runner.py`

**Interfaces:**
- Consumes: `WireRunner`, `register_registry` (Task 1); budgets (Task 2).
- Produces (Task 6 consumes exactly these):
  - `coder_runner.CONVERSATION_ID_RE` — compiled regex `^c_[a-f0-9]{12}$`
  - `coder_runner.new_conversation_id() -> str`
  - `coder_runner.CoderRunner(WireRunner)` — ctor `(*, conversation_id: str, argv, cwd, env, uid=None, gid=None, max_turn_seconds: float, max_steps_per_turn: int)`; attribute `conversation_id`
  - `coder_runner.get_conversation(root: Path, conversation_id: str) -> CoderRunner | None`
  - `coder_runner.put_conversation(root: Path, runner: CoderRunner) -> None`
  - `coder_runner.drop_conversation(root: Path, conversation_id: str) -> None` (async)
  - `coder_runner.list_conversations(root: Path) -> list[CoderRunner]`
  - `coder_runner.shutdown_conversations() -> None` (async)

- [ ] **Step 1: Write the failing tests**

Append to `terminal-server/tests/test_wire_runner.py`:

```python
from sanad_terminal.coder_runner import (
    CONVERSATION_ID_RE,
    CoderRunner,
    get_conversation,
    list_conversations,
    new_conversation_id,
    put_conversation,
    drop_conversation,
    shutdown_conversations,
)


def test_conversation_ids_are_minted_and_validated():
    cid = new_conversation_id()
    assert CONVERSATION_ID_RE.fullmatch(cid)
    assert not CONVERSATION_ID_RE.fullmatch("../../etc/passwd")
    assert not CONVERSATION_ID_RE.fullmatch("c_UPPER_NOPE_00")


@pytest.mark.asyncio
async def test_conversation_registry_roundtrip(tmp_path):
    cid = new_conversation_id()
    runner = CoderRunner(
        conversation_id=cid,
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
    )
    assert get_conversation(tmp_path, cid) is None
    put_conversation(tmp_path, runner)
    assert get_conversation(tmp_path, cid) is runner
    assert [r.conversation_id for r in list_conversations(tmp_path)] == [cid]
    await drop_conversation(tmp_path, cid)
    assert get_conversation(tmp_path, cid) is None
    await shutdown_conversations()


@pytest.mark.asyncio
async def test_coder_runner_speaks_wire_and_denies_requests(tmp_path):
    """The P0 posture end to end on the coder class itself: turn streams,
    inbound approval request is rejected (-32601), budgets are honored."""
    runner = CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
    )
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes and outcomes[0]["error"]["code"] == -32601
        assert state.status == "finished"
    finally:
        await runner.stop()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'sanad_terminal.coder_runner'`.

- [ ] **Step 3: Implement `coder_runner.py`**

```python
"""The Coder runner — `sanad --wire --session <conversationId>` on the
WireRunner base. One runner per CONVERSATION (not per workspace): a
conversation IS a kimi session id, which is what makes "one brain, two
views" literal later (the TUI resumes the same id).

P0 posture: capabilities are false/false and the base rejects every inbound
request, so any gated tool call resolves as DENIED — the most-restrictive
stance. P1's approvals bridge flips the capabilities and overrides
`on_request`. Budgets are mandatory here (settings-driven), unlike the
architect: a browser-driven turn can run unattended and must be bounded.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from sanad_terminal.wire_runner import WireRunner, register_registry

# Server-minted only (P0); the shape keeps ids path- and shell-safe.
CONVERSATION_ID_RE = re.compile(r"^c_[a-f0-9]{12}$")


def new_conversation_id() -> str:
    return f"c_{uuid.uuid4().hex[:12]}"


class CoderRunner(WireRunner):
    def __init__(
        self,
        *,
        conversation_id: str,
        argv,  # noqa: ANN001
        cwd: Path,
        env: dict[str, str],
        uid: int | None = None,
        gid: int | None = None,
        max_turn_seconds: float,
        max_steps_per_turn: int,
    ) -> None:
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            client_name="sanad-coder-bridge",
            capabilities={"supports_question": False, "supports_plan_mode": False},
            max_turn_seconds=max_turn_seconds,
            max_steps_per_turn=max_steps_per_turn,
        )
        self.conversation_id = conversation_id


def _key(root: Path, conversation_id: str) -> str:
    return f"{root}::{conversation_id}"


# Keyed by (workspace root, conversation) — one machine serves one workspace
# in task mode, but railway mode shares a host, and the blueprint locks key by
# root for the same reason. Registered with wire_runner so an active coder
# turn holds the machine open (IdleStopper probe).
_conversations: dict[str, CoderRunner] = {}
register_registry(_conversations)


def get_conversation(root: Path, conversation_id: str) -> CoderRunner | None:
    return _conversations.get(_key(root, conversation_id))


def put_conversation(root: Path, runner: CoderRunner) -> None:
    _conversations[_key(root, runner.conversation_id)] = runner


async def drop_conversation(root: Path, conversation_id: str) -> None:
    runner = _conversations.pop(_key(root, conversation_id), None)
    if runner is not None:
        await runner.stop()


def list_conversations(root: Path) -> list[CoderRunner]:
    prefix = f"{root}::"
    return [r for k, r in _conversations.items() if k.startswith(prefix)]


async def shutdown_conversations() -> None:
    runners = list(_conversations.values())
    _conversations.clear()
    for runner in runners:
        await runner.stop()
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/coder_runner.py terminal-server/tests/test_wire_runner.py && git commit -m "sanad: CoderRunner — per-conversation wire runner, deny-by-default"
```

---

### Task 6: `/internal/coder` routes (P0 subset) + app wiring

**Files:**
- Create: `terminal-server/src/sanad_terminal/routes_coder.py`
- Modify: `terminal-server/src/sanad_terminal/app.py` (include router at line ~135; shutdown hook at line ~111)
- Create: `terminal-server/tests/test_routes_coder.py`

**Interfaces:**
- Consumes: Task 5's registry API; `workspace_root`/`_settings` from `routes_workspace` (same dependency the architect routes use); `build_child_env` from `workspace.py`; `ControlPlaneError` + `redeem_ticket` (see `routes_architect.py:68-104` — mirror it); `_recycling_stream` PATTERN from `routes_architect.py:107-153` (reimplement locally with `drop_conversation`).
- Produces (P1's web proxies will call these):
  - `GET  /internal/coder/conversations` → `{"conversations": [{"conversationId", "alive", "busy", "turn": <summary|null>}]}`
  - `POST /internal/coder/conversations` `{ticket}` → `{"conversationId": "c_..."}` (mints id, redeems, spawns)
  - `POST /internal/coder/conversations/{cid}/open` `{ticket}` → `{"ok": true, "started": bool}` (idempotent respawn of an existing id)
  - `POST /internal/coder/conversations/{cid}/send` `{input, sendId?}` → NDJSON turn stream (409 `busy` / `not_started` like the architect)
  - `GET  /internal/coder/conversations/{cid}/turn` → `{"turn": <summary|null>, "alive": bool}`
  - `GET  /internal/coder/conversations/{cid}/follow?turnId&from_seq` → NDJSON
  - `POST /internal/coder/conversations/{cid}/cancel` → `{"ok": true}`
  - `POST /internal/coder/conversations/{cid}/stop` → `{"ok": true}` (drops the runner)
  - Flag off → every route above returns 404 `{"error":{"code":"coder_disabled",...}}`; malformed `{cid}` → 400 `invalid_conversation`.

- [ ] **Step 1: Write the failing route tests**

Create `terminal-server/tests/test_routes_coder.py`:

```python
"""Coder bridge P0: flag-gated conversation lifecycle, NDJSON turn streaming,
and the deny-by-default approval round-trip through the HTTP surface."""

import json
import sys
from pathlib import Path

import httpx
import pytest
from sanad_terminal.app import create_app
from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.settings import TerminalSettings
from starlette.testclient import TestClient

SECRET = "s3cret"
USER = "user_1"
HEADERS = {"x-terminal-secret": SECRET, "x-workspace-user": USER}
FAKE_WIRE = Path(__file__).parent / "_fake_coder_wire.py"

IDENTITY = {
    "sessionToken": "sess_abc",
    "userId": USER,
    "orgId": "personal_user_1",
    "email": "a@b.test",
    "displayName": "A",
}


def _control_plane(tickets: dict[str, dict]) -> ControlPlaneClient:
    def handler(request: httpx.Request) -> httpx.Response:
        ticket = str(json.loads(request.content)["ticket"])
        if ticket not in tickets:
            return httpx.Response(
                404, json={"error": {"code": "not_found", "message": "nope", "requestId": "r"}}
            )
        return httpx.Response(200, json={"data": tickets[ticket], "meta": {"requestId": "r"}})

    return ControlPlaneClient("https://cp.test", SECRET, transport=httpx.MockTransport(handler))


def _make_client(tmp_path: Path, *, enabled: bool) -> TestClient:
    settings = TerminalSettings(
        shared_secret=SECRET,
        users_dir=tmp_path / "users",
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
        coder_enabled=enabled,
        coder_max_turn_seconds=3600.0,
        coder_max_steps_per_turn=200,
    )
    app = create_app(settings, _control_plane({"tt_good": IDENTITY}))
    return TestClient(app)


@pytest.fixture
def client(tmp_path: Path):
    with _make_client(tmp_path, enabled=True) as c:
        yield c


def _lines(text: str) -> list[dict]:
    return [json.loads(ln) for ln in text.splitlines() if ln.strip()]


def test_flag_off_hides_every_route(tmp_path: Path):
    with _make_client(tmp_path, enabled=False) as c:
        res = c.post(
            "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
        )
        assert res.status_code == 404
        assert res.json()["error"]["code"] == "coder_disabled"
        assert c.get("/internal/coder/conversations", headers=HEADERS).status_code == 404


def test_create_requires_credentials(client: TestClient):
    assert client.post("/internal/coder/conversations", json={"ticket": "tt_good"}).status_code == 401


def test_create_rejects_bad_ticket(client: TestClient):
    res = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_nope"}
    )
    assert res.status_code == 401


def test_create_send_and_stream_a_turn(client: TestClient):
    created = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert created.status_code == 200, created.text
    cid = created.json()["conversationId"]

    listed = client.get("/internal/coder/conversations", headers=HEADERS).json()
    assert [c["conversationId"] for c in listed["conversations"]] == [cid]

    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "hello"},
    )
    assert res.status_code == 200
    items = _lines(res.text)
    assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"
    types = [i["event"]["type"] for i in items if i["kind"] == "event"]
    assert "TurnBegin" in types and "TextPart" in types


def test_send_to_unknown_conversation_is_409(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/c_000000000000/send",
        headers=HEADERS,
        json={"input": "hi"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_malformed_conversation_id_is_400(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/..%2Fetc/send", headers=HEADERS, json={"input": "x"}
    )
    assert res.status_code in (400, 404)  # 400 from our guard; 404 if routing rejects first


def test_gated_tool_call_is_denied_by_default(client: TestClient):
    """P0 HTTP-level golden test: an ApprovalRequest surfaced by the agent is
    rejected (-32601) with no respond endpoint in sight, and the turn ends."""
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "ASK_APPROVAL"},
    )
    assert res.status_code == 200
    items = _lines(res.text)
    outcomes = [
        i["event"]["payload"]["response"]
        for i in items
        if i["kind"] == "event" and i["event"]["type"] == "RequestOutcome"
    ]
    assert outcomes and outcomes[0]["error"]["code"] == -32601
    assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"


def test_follow_replays_a_finished_turn(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    first = _lines(
        client.post(
            f"/internal/coder/conversations/{cid}/send",
            headers=HEADERS,
            json={"input": "hello", "sendId": "m1"},
        ).text
    )
    turn_id = first[0]["turnId"]
    replay = client.get(
        f"/internal/coder/conversations/{cid}/follow",
        headers=HEADERS,
        params={"turnId": turn_id, "from_seq": 0},
    )
    assert replay.status_code == 200
    assert _lines(replay.text) == first


def test_stop_drops_the_runner(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    assert (
        client.post(
            f"/internal/coder/conversations/{cid}/stop", headers=HEADERS
        ).status_code
        == 200
    )
    res = client.post(
        f"/internal/coder/conversations/{cid}/send", headers=HEADERS, json={"input": "hi"}
    )
    assert res.status_code == 409 and res.json()["error"]["code"] == "not_started"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_routes_coder.py -q`
Expected: FAIL — 404s everywhere (router not registered / module missing).

- [ ] **Step 3: Implement `routes_coder.py`**

```python
"""Internal Coder REST (P0 subset) — flag-gated conversation lifecycle over
CoderRunner. Mirrors the architect bridge: `conversations` (create) redeems a
one-time ticket agentd-side and spawns `sanad --wire --session <id>`;
`send`/`follow` stream NDJSON from the server-authoritative journal.

P0 posture: the runner rejects every inbound request, so gated tools are
DENIED — there is deliberately no respond endpoint yet (P1). The
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
from sanad_terminal.workspace import build_child_env

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


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _bad_cid(cid: str) -> JSONResponse | None:
    if not CONVERSATION_ID_RE.fullmatch(cid):
        return _err(400, "invalid_conversation", "malformed conversation id")
    return None


async def _spawn(request: Request, root: Path, cid: str, ticket: str) -> JSONResponse | CoderRunner:
    settings = _settings(request)
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
        max_turn_seconds=settings.coder_max_turn_seconds,
        max_steps_per_turn=settings.coder_max_steps_per_turn,
    )
    try:
        await runner.start()
    except WireRunnerError as exc:
        await runner.stop()
        return _err(503, exc.code, exc.message)
    put_conversation(root, runner)
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
    result = await _spawn(request, root, cid, body.ticket)
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
            yield json.dumps(
                {"kind": "error", "code": "turn_failed", "message": exc.message}
            ).encode("utf-8") + b"\n"
        if failed or not runner.alive:
            await drop_conversation(root, runner.conversation_id)

    return stream()


@router.post("/conversations/{cid}/send", response_model=None)
async def send(
    _: Gated, root: Root, cid: str, body: SendBody
) -> StreamingResponse | JSONResponse:
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


@router.get("/conversations/{cid}/turn")
async def turn(_: Gated, root: Root, cid: str) -> JSONResponse:
    if bad := _bad_cid(cid):
        return bad
    runner = get_conversation(root, cid)
    if runner is None:
        return JSONResponse({"turn": None, "alive": False})
    return JSONResponse({"turn": runner.turn_summary(), "alive": runner.alive})


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
```

- [ ] **Step 4: Wire into `app.py`**

(a) After the terminal router include (`app.py:133-135`), add:

```python
    from sanad_terminal.routes_coder import CoderDisabled, router as coder_router

    app.include_router(coder_router)

    @app.exception_handler(CoderDisabled)
    async def _coder_disabled(request, exc):  # noqa: ANN001, ANN202
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "coder_disabled", "message": "coder panel is not enabled"}},
        )
```

(`JSONResponse` is imported from `fastapi.responses` — check app.py's existing imports and add if absent.)

(b) In the lifespan shutdown block, after `await shutdown_runners()` (`app.py:109-111`), add:

```python
        from sanad_terminal.coder_runner import shutdown_conversations

        await shutdown_conversations()
```

- [ ] **Step 5: Run the route tests + full suite**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_routes_coder.py -q && uv run pytest tests/ -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/routes_coder.py terminal-server/src/sanad_terminal/app.py terminal-server/tests/test_routes_coder.py && git commit -m "sanad: /internal/coder P0 routes — flag-gated conversations, NDJSON turns, deny-by-default"
```

---

### Task 7: sanad-web coder-panel allowlist (dark in P0)

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/auth/coder.ts`
- Create: `control-plane/artifacts/sanad-web/tests/unit/coder-allowlist.test.ts`

**Interfaces:**
- Produces: `coderPanelEmails(): string[]`, `isCoderPanelAllowed(email: string | null | undefined): boolean` — env `SANAD_CODER_PANEL_EMAILS`, fails closed. P1's `/api/coder/*` proxies will call `isCoderPanelAllowed` exactly where the terminal routes call `isTerminalAllowed`. No route consumes it in P0 (ships dark).

- [ ] **Step 1: Write the failing test**

Create `control-plane/artifacts/sanad-web/tests/unit/coder-allowlist.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { coderPanelEmails, isCoderPanelAllowed } from "@/lib/auth/coder";

describe("coder panel allowlist", () => {
  const original = process.env.SANAD_CODER_PANEL_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.SANAD_CODER_PANEL_EMAILS;
    else process.env.SANAD_CODER_PANEL_EMAILS = original;
  });

  it("parses, trims, lowercases and drops empty entries", () => {
    process.env.SANAD_CODER_PANEL_EMAILS = " Foo@Example.com , bar@x.io ,,";
    expect(coderPanelEmails()).toEqual(["foo@example.com", "bar@x.io"]);
  });

  it("FAILS CLOSED: empty or unset allowlist denies everyone", () => {
    delete process.env.SANAD_CODER_PANEL_EMAILS;
    expect(isCoderPanelAllowed("anyone@example.com")).toBe(false);
    process.env.SANAD_CODER_PANEL_EMAILS = "";
    expect(isCoderPanelAllowed("anyone@example.com")).toBe(false);
  });

  it("matches case-insensitively and denies null/undefined", () => {
    process.env.SANAD_CODER_PANEL_EMAILS = "omar@example.com";
    expect(isCoderPanelAllowed("OMAR@example.com")).toBe(true);
    expect(isCoderPanelAllowed("other@example.com")).toBe(false);
    expect(isCoderPanelAllowed(null)).toBe(false);
    expect(isCoderPanelAllowed(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web && pnpm test tests/unit/coder-allowlist.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/coder`.

- [ ] **Step 3: Implement `lib/auth/coder.ts`**

```ts
/**
 * Coder-panel access gate (P0 — ships dark; P1's /api/coder/* proxies enforce it).
 *
 * `SANAD_CODER_PANEL_EMAILS` is a comma-separated allowlist, SEPARATE from
 * `SANAD_TERMINAL_EMAILS` so write-capable coder access is grantable to a
 * strict subset of workspace users. Like the terminal gate it FAILS CLOSED:
 * empty or unset means nobody — the coder agent runs shell and file writes
 * server-side, so access is opt-in per person.
 */
export function coderPanelEmails(): string[] {
  return (process.env.SANAD_CODER_PANEL_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True if this email may use the coder panel. Empty allowlist denies all. */
export function isCoderPanelAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  return coderPanelEmails().includes(email.trim().toLowerCase());
}
```

- [ ] **Step 4: Run the web unit tests**

Run: `cd /Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web && pnpm test tests/unit/coder-allowlist.test.ts && pnpm test`
Expected: new file passes; full suite unaffected (the pre-existing dirty test file `architect-transcript.test.ts` is whatever state Omar left it — do NOT touch it; if it was already failing before this task, that failure is out of scope, note it and move on).

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add control-plane/artifacts/sanad-web/lib/auth/coder.ts control-plane/artifacts/sanad-web/tests/unit/coder-allowlist.test.ts && git commit -m "sanad: coder panel email allowlist — fail-closed, separate from terminal gate"
```

---

## P0 exit criteria (spec traceability)

| Spec P0 item | Where |
|---|---|
| WireRunner extraction, architect byte-compatible | Task 1 (gate: untouched architect suite green) |
| CoderRunner smoke, default agent, most-restrictive posture | Tasks 5–6 (deny-by-default golden tests at runner AND HTTP level) |
| IdleStopper probes (idle fix precedes long turns) | Task 3 |
| Turn budgets (3600s / 200 steps) | Tasks 2 + 4 (settings) + 6 (routes pass them) |
| `CODER_ENABLED` flag, fail closed | Tasks 4 + 6 (`test_flag_off_hides_every_route`) |
| `SANAD_CODER_PANEL_EMAILS` flag, fail closed | Task 7 |

Not in P0 (per spec, do not add): respond endpoint / approvals bridge (P1), durable journal (P3), queue/steer (P4), checkpoints (P5), session lease / TUI handoff / disk-scan conversation listing (P6), any sanad-web proxy routes or UI (P1+).
