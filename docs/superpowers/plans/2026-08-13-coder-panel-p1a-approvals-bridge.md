# Coder Panel P1a — Approvals Bridge + Respond + Proxies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the coder runner interactive: inbound wire `request` frames (approvals/questions) journal into the turn and register as pending; the browser answers via a hardened `POST /respond`; capabilities flip to `supports_question/plan_mode: true`; conversation caps land; sanad-web gets the gated `/api/coder/*` proxies. (The panel UI itself is P1b.)

**Architecture:** The base `WireRunner._dispatch` request branch becomes an async seam (`ensure_future` → `_handle_request` → `await on_request`, reject on False/raise — architect behavior unchanged). `CoderRunner` overrides `on_request`: classify the `{"type","payload"}` envelope, journal `{"kind":"request",...}` into the current turn, register in a per-runner pending map; `respond()` sends the JSON-RPC result (id == requestId), journals `{"kind":"request_resolved",...}`, fail-closed on unknown ids. Web proxies mirror `app/api/architect/*` with an extra `isCoderPanelAllowed` gate.

**Tech Stack:** Python 3.14 / FastAPI / asyncio (terminal-server; `uv run pytest` from `terminal-server/`); TypeScript/Next.js (sanad-web; `pnpm test` = vitest). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` §Runner, §API surface. Base: main @ 37b5e3ae (P0 merged).

## Global Constraints

- **Commits are Omar-only** — `sanad: <description>` style; NEVER any Co-Authored-By / AI attribution.
- **Architect stays behaviorally unchanged by the async seam** (same reject outcome, one task-hop later); existing architect route tests pass untouched. The ONLY deliberate architect change is Task 6's wall-clock budget (its own tests).
- **Fail closed everywhere:** respond with unknown/resolved/cancelled `requestId` → 410 `request_gone`; malformed body → 400; ToolCallRequest/unknown request types → rejected (-32601); requests arriving with NO running turn → rejected (background lane is P3/P4, documented); flag-off → 404 `coder_disabled` (existing gate covers new routes via the same `Gated` dependency).
- **Wire contract (verified against `src/kimi_cli/wire/`):** request frame `{"jsonrpc":"2.0","method":"request","id":<request.id>,"params":{"type":"ApprovalRequest"|"QuestionRequest"|...,"payload":{...}}}` — the JSON-RPC id EQUALS the request's own id (`wire/server.py:1036`). Respond: `{"jsonrpc":"2.0","id":<requestId>,"result":{"request_id":<requestId>,"response":"approve"|"approve_for_session"|"reject","feedback":str}}` for approvals; `{"request_id","answers":{question:label}}` for questions (`wire/server.py:899-937`, `wire/types.py:293-305,398-405`). An ERROR response resolves as reject server-side — that's how P0's deny-by-default already works; do not break it.
- **Capabilities flip is Task 2's deliberate golden-test flip:** `CoderRunner` initializes `supports_question: true, supports_plan_mode: true`. The BASE-level rejection test (`test_inbound_request_is_rejected_by_default` in `tests/test_wire_runner.py`) MUST remain green and untouched — base `WireRunner`/architect still reject.
- Conversation cap default 3 (`CODER_MAX_CONVERSATIONS`); breach → 409 `conversation_limit`.
- Architect wall-clock budget default 1800s (`ARCHITECT_MAX_TURN_SECONDS`) — closes P0's unbounded-machine-hold regression (probes hold the machine while a turn runs; a hung architect turn must eventually cancel).
- Working tree has unrelated dirty files (sanad-web architect files, `.serena/`, a report md). **Never `git add -A`** — stage only the files each task names.
- terminal-server commands run from `/Users/omar/Development/sammad-cli/terminal-server`; sanad-web from `/Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web`.

---

### Task 1: Async request seam in `WireRunner`

**Files:**
- Modify: `terminal-server/src/sanad_terminal/wire_runner.py` (`_dispatch` request branch, `on_request` becomes async, new `_handle_request`)
- Modify: `terminal-server/tests/test_wire_runner.py` (no test changes expected — this step just proves them green; touch only if an import broke)

**Interfaces:**
- Consumes: P0's `_dispatch` (sync, calls sync `on_request` then `_reject`), `_reject(rid)`.
- Produces (Task 2 consumes): `async def on_request(self, rid: Any, params: dict[str, Any]) -> bool` — base returns False; `_dispatch`'s request branch becomes:

```python
        if method == "request":
            rid = msg.get("id")
            params = msg.get("params")
            if rid is not None:
                asyncio.ensure_future(
                    self._handle_request(rid, params if isinstance(params, dict) else {})
                )
            return
```

and the new coroutine + async hook replace the old sync pair:

```python
    async def _handle_request(self, rid: Any, params: dict[str, Any]) -> None:
        try:
            handled = await self.on_request(rid, params)
        except Exception:
            logger.exception("on_request hook failed; rejecting")
            handled = False
        if not handled:
            await self._reject(rid)

    async def on_request(self, rid: Any, params: dict[str, Any]) -> bool:
        """Handle an inbound JSON-RPC request. Base: unhandled → reject.

        Async so a subclass can journal/register before returning (P1's
        approvals bridge). Returning False keeps the defensive reject so a
        stray request can never wedge the subprocess.
        """
        return False
```

- [ ] **Step 1: Green baseline**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py tests/test_routes_architect.py tests/test_routes_coder.py -q`
Expected: all pass (this is P0's merged state).

- [ ] **Step 2: Apply the seam**

Make exactly the three changes shown in Interfaces (request branch, `_handle_request`, async `on_request`). Delete the old sync `on_request` and the old inline handled/reject logic from `_dispatch`.

- [ ] **Step 3: Verify behavior unchanged**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/ -q`
Expected: full suite passes — in particular `test_inbound_request_is_rejected_by_default` and `test_gated_tool_call_is_denied_by_default` (the reject now happens via one task hop; the fake wire blocks on reading the response before finishing the turn, so ordering is preserved).

- [ ] **Step 4: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/wire_runner.py && git commit -m "sanad: async on_request seam in WireRunner — reject path unchanged"
```

---

### Task 2: CoderRunner inbound bridge — capabilities flip, journal, pending registry

**Files:**
- Modify: `terminal-server/src/sanad_terminal/coder_runner.py`
- Modify: `terminal-server/tests/_fake_coder_wire.py` (add `ASK_QUESTION` mode; keep every existing mode byte-identical)
- Modify: `terminal-server/tests/test_wire_runner.py` (REWRITE `test_coder_runner_speaks_wire_and_denies_requests` into bridge tests; base-level reject test untouched)

**Interfaces:**
- Consumes: Task 1's async `on_request`; P0's `_append(state, item)`, `_current: TurnState | None`, `_consume` finally block, `stop()`.
- Produces (Tasks 3–4 consume):
  - `PendingRequest` dataclass in `coder_runner.py`: `request_id: str, request_type: str  # "approval" | "question", turn_id: str, created_at: float`
  - `CoderRunner._pending: dict[str, PendingRequest]` (per-runner)
  - `CoderRunner.pending_summaries() -> list[dict]` → `[{"requestId", "requestType", "turnId", "createdAt", "request": <payload>}]` (keeps raw payload for `GET /turn` replay)
  - Journal item kinds: `{"kind":"request","requestType","requestId","turnId","request":<payload>}`, `{"kind":"request_cancelled","requestId","reason":"turn_ended"|"runner_stopped"}`
  - Capabilities: `{"supports_question": True, "supports_plan_mode": True}`

- [ ] **Step 1: Extend the fake wire with `ASK_QUESTION`**

In `terminal-server/tests/_fake_coder_wire.py`, add a branch in the `prompt` handler after the `ASK_APPROVAL` branch (same structure — emit request, wait for the response line, echo it as `RequestOutcome`, finish):

```python
            elif "ASK_QUESTION" in user_input:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": "q_1",
                        "method": "request",
                        "params": {
                            "type": "QuestionRequest",
                            "payload": {
                                "id": "q_1",
                                "tool_call_id": "call_q",
                                "questions": [
                                    {
                                        "question": "Which approach?",
                                        "header": "Approach",
                                        "options": [
                                            {"label": "A", "description": "first"},
                                            {"label": "B", "description": "second"},
                                        ],
                                        "multi_select": False,
                                    }
                                ],
                            },
                        },
                    }
                )
                response = _read()
                _event("RequestOutcome", {"response": response})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
```

Also update the module docstring's mode list to include it. Do not alter existing modes.

- [ ] **Step 2: Write the failing bridge tests**

In `terminal-server/tests/test_wire_runner.py`, DELETE `test_coder_runner_speaks_wire_and_denies_requests` (the P0 coder-level deny test — its posture is deliberately flipped this task; the base-level `test_inbound_request_is_rejected_by_default` stays as the deny golden test) and add, plus a small helper:

```python
def _coder(tmp_path, **kwargs):
    return CoderRunner(
        conversation_id=new_conversation_id(),
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=tmp_path,
        env={},
        max_turn_seconds=3600.0,
        max_steps_per_turn=200,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_coder_bridges_approval_requests_into_journal_and_registry(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        # Wait for the request to be journaled (the turn blocks on our answer).
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        pending = runner.pending_summaries()
        assert len(pending) == 1
        p = pending[0]
        assert p["requestType"] == "approval"
        assert p["requestId"] == "req_1"
        assert p["turnId"] == state.turn_id
        assert p["request"]["action"] == "run command"
        kinds = [i.get("kind") for i in state.items]
        assert "request" in kinds
        # Turn is still running — the agent is waiting on us.
        assert state.status == "running"
        await runner.respond("req_1", {"response": "approve"})
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["response"] == "approve"
        assert outcomes[0]["result"]["request_id"] == "req_1"
        assert state.status == "finished"
        assert runner.pending_summaries() == []
        assert any(i.get("kind") == "request_resolved" for i in state.items)
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_coder_bridges_question_requests(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_QUESTION")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        assert runner.pending_summaries()[0]["requestType"] == "question"
        await runner.respond("q_1", {"answers": {"Which approach?": "A"}})
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["answers"] == {"Which approach?": "A"}
        assert state.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_coder_rejects_unknown_request_types(tmp_path):
    """ToolCallRequest (wire-executed tools) is not bridged — reject."""
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_TOOLCALL")
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["error"]["code"] == -32601
        assert runner.pending_summaries() == []
        assert state.status == "finished"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_pending_requests_are_cancelled_on_stop(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        assert runner.pending_summaries()
    finally:
        await runner.stop()
    assert runner.pending_summaries() == []
    assert any(i.get("kind") == "request_cancelled" for i in state.items)
```

The `ASK_TOOLCALL` test needs one more fake-wire branch (add in Step 1's edit, before `ASK_APPROVAL` since `in` matching is substring-based and these keywords are disjoint):

```python
            elif "ASK_TOOLCALL" in user_input:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": "tc_1",
                        "method": "request",
                        "params": {
                            "type": "ToolCallRequest",
                            "payload": {"id": "tc_1", "name": "external", "arguments": "{}"},
                        },
                    }
                )
                response = _read()
                _event("RequestOutcome", {"response": response})
                _write({"jsonrpc": "2.0", "id": mid, "result": {"status": "finished"}})
```

- [ ] **Step 3: Run to verify RED**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: the four new tests FAIL (`pending_summaries`/`respond` don't exist; approval requests are rejected instead of bridged). Pre-existing tests pass.

- [ ] **Step 4: Implement the bridge in `coder_runner.py`**

(a) Imports: add `import time`, `from dataclasses import dataclass`, `from typing import Any`.

(b) Capabilities flip in `CoderRunner.__init__`:

```python
            capabilities={"supports_question": True, "supports_plan_mode": True},
```

and update the module docstring: replace the P0-posture paragraph with one stating the P1 posture (approvals/questions bridged to the browser via journal + respond; ToolCall/unknown requests still rejected; requests outside a running turn rejected until the background lane lands in P3/P4).

(c) The registry types + bridge, inside/below `CoderRunner`:

```python
@dataclass
class PendingRequest:
    request_id: str
    request_type: str  # "approval" | "question"
    turn_id: str
    created_at: float
    request: dict[str, Any]
```

```python
    # -- request bridge (P1) --------------------------------------------------

    _BRIDGED_TYPES = {"ApprovalRequest": "approval", "QuestionRequest": "question"}

    async def on_request(self, rid: Any, params: dict[str, Any]) -> bool:
        request_type = self._BRIDGED_TYPES.get(str(params.get("type")))
        payload = params.get("payload")
        state = self._current
        if (
            request_type is None
            or not isinstance(payload, dict)
            or not isinstance(rid, str)
            or state is None
            or state.status != "running"
        ):
            # ToolCall/hook/unknown types, malformed frames, and requests
            # outside a running turn (background lane = P3/P4) all reject.
            return False
        self._pending[rid] = PendingRequest(
            request_id=rid,
            request_type=request_type,
            turn_id=state.turn_id,
            created_at=time.time(),
            request=payload,
        )
        await self._append(
            state,
            {
                "kind": "request",
                "requestType": request_type,
                "requestId": rid,
                "turnId": state.turn_id,
                "request": payload,
            },
        )
        return True

    def pending_summaries(self) -> list[dict[str, Any]]:
        return [
            {
                "requestId": p.request_id,
                "requestType": p.request_type,
                "turnId": p.turn_id,
                "createdAt": p.created_at,
                "request": p.request,
            }
            for p in self._pending.values()
        ]
```

`self._pending: dict[str, PendingRequest] = {}` is initialized in `__init__` after the `super().__init__(...)` call, alongside `self.conversation_id`.

(d) Cleanup on turn end and runner stop. Override the journal-side teardown by hooking the two paths P0 already owns:

```python
    async def _consume(self, state, queue) -> None:  # noqa: ANN001
        try:
            await super()._consume(state, queue)
        finally:
            await self._cancel_pending("turn_ended", state)

    async def stop(self) -> None:
        await super().stop()
        state = self._current
        if state is not None:
            await self._cancel_pending("runner_stopped", state)
        else:
            self._pending.clear()

    async def _cancel_pending(self, reason: str, state) -> None:  # noqa: ANN001
        for rid in list(self._pending):
            self._pending.pop(rid, None)
            await self._append(
                state, {"kind": "request_cancelled", "requestId": rid, "reason": reason}
            )
```

(Note: `_append` on a finished turn is safe — it appends and notifies; followers of a non-running turn have already drained and returned, so `request_cancelled` items on an ended turn are for the journal record, which is what `test_pending_requests_are_cancelled_on_stop` asserts. The respond path (Task 3) journals `request_resolved` BEFORE the turn can end, because the agent is blocked awaiting the answer.)

- [ ] **Step 5: Run tests — bridge tests still RED on `respond`**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: `test_coder_rejects_unknown_request_types` and `test_pending_requests_are_cancelled_on_stop` PASS; the approval/question round-trip tests still FAIL on `runner.respond` not existing (implemented next task). That's the intended stopping point — commit this task's slice.

- [ ] **Step 6: Temporarily mark the two respond-dependent tests**

Add `@pytest.mark.xfail(reason="respond lands in the next commit", strict=True)` directly above `test_coder_bridges_approval_requests_into_journal_and_registry` and `test_coder_bridges_question_requests`. Run the file again: expected 2 xfail + rest pass; full suite green (`uv run pytest tests/ -q`).

- [ ] **Step 7: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/coder_runner.py terminal-server/tests/_fake_coder_wire.py terminal-server/tests/test_wire_runner.py && git commit -m "sanad: coder request bridge — approvals/questions journal + pending registry, capabilities on"
```

---

### Task 3: `CoderRunner.respond()` — fail-closed resolution

**Files:**
- Modify: `terminal-server/src/sanad_terminal/coder_runner.py`
- Modify: `terminal-server/tests/test_wire_runner.py` (remove the two xfail markers; add stale/duplicate tests)

**Interfaces:**
- Consumes: Task 2's `_pending`, `PendingRequest`, journal kinds; base `_send`, `_append`, `WireRunnerError`.
- Produces (Task 4 consumes): `async def respond(self, request_id: str, payload: dict[str, Any]) -> None` — raises `WireRunnerError("request_gone", ...)` for unknown/resolved ids, `WireRunnerError("invalid_response", ...)` for malformed payloads. Approval payload: `{"response": "approve"|"approve_for_session"|"reject", "feedback"?: str}`. Question payload: `{"answers": {str: str}}`. Journals `{"kind":"request_resolved","requestId","requestType","resolution":<result dict>}`.

- [ ] **Step 1: Un-xfail + add failing tests**

Remove both `@pytest.mark.xfail(...)` lines from Task 2's tests. Add:

```python
@pytest.mark.asyncio
async def test_respond_to_unknown_request_is_request_gone(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        with pytest.raises(WireRunnerError) as exc:
            await runner.respond("req_nope", {"response": "approve"})
        assert exc.value.code == "request_gone"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_respond_twice_is_request_gone(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        state = await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        await runner.respond("req_1", {"response": "reject", "feedback": "not now"})
        with pytest.raises(WireRunnerError) as exc:
            await runner.respond("req_1", {"response": "approve"})
        assert exc.value.code == "request_gone"
        items = await asyncio.wait_for(_drain(runner, state.turn_id), timeout=5.0)
        outcomes = [
            i["event"]["payload"]["response"]
            for i in items
            if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
        ]
        assert outcomes[0]["result"]["response"] == "reject"
        assert outcomes[0]["result"]["feedback"] == "not now"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_respond_with_malformed_payload_is_invalid_response(tmp_path):
    runner = _coder(tmp_path)
    await runner.start()
    try:
        await runner.start_turn("ASK_APPROVAL")
        for _ in range(100):
            if runner.pending_summaries():
                break
            await asyncio.sleep(0.02)
        with pytest.raises(WireRunnerError) as exc:
            await runner.respond("req_1", {"response": "yolo_no_such_kind"})
        assert exc.value.code == "invalid_response"
        # Still pending — a bad payload must not consume the request.
        assert runner.pending_summaries()
        await runner.respond("req_1", {"response": "approve"})
    finally:
        await runner.stop()
```

Add `WireRunnerError` to the file's `sanad_terminal.wire_runner` import line if not already imported.

- [ ] **Step 2: Run to verify RED**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q`
Expected: all respond tests FAIL (`respond` missing).

- [ ] **Step 3: Implement `respond`**

In `coder_runner.py`, below `pending_summaries`:

```python
    _APPROVAL_KINDS = {"approve", "approve_for_session", "reject"}

    async def respond(self, request_id: str, payload: dict[str, Any]) -> None:
        """Answer a pending approval/question. Fail closed: the request must
        be pending on THIS runner (strict check — never rely on the wire
        layer's lenient id match), and the payload must validate for its
        type. A bad payload leaves the request pending."""
        pending = self._pending.get(request_id)
        if pending is None:
            raise WireRunnerError("request_gone", "no such pending request")
        if pending.request_type == "approval":
            response = payload.get("response")
            if response not in self._APPROVAL_KINDS:
                raise WireRunnerError("invalid_response", "response must be approve|approve_for_session|reject")
            feedback = payload.get("feedback", "")
            if not isinstance(feedback, str):
                raise WireRunnerError("invalid_response", "feedback must be a string")
            result: dict[str, Any] = {
                "request_id": request_id,
                "response": response,
                "feedback": feedback,
            }
        else:
            answers = payload.get("answers")
            if not isinstance(answers, dict) or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in answers.items()
            ):
                raise WireRunnerError("invalid_response", "answers must be a str→str map")
            result = {"request_id": request_id, "answers": answers}
        await self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        self._pending.pop(request_id, None)
        state = self.get_turn(pending.turn_id)
        if state is not None:
            await self._append(
                state,
                {
                    "kind": "request_resolved",
                    "requestId": request_id,
                    "requestType": pending.request_type,
                    "resolution": result,
                },
            )
```

Also add `WireRunnerError` to `coder_runner.py`'s import from `sanad_terminal.wire_runner`.

- [ ] **Step 4: GREEN + full suite**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_wire_runner.py -q && uv run pytest tests/ -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/coder_runner.py terminal-server/tests/test_wire_runner.py && git commit -m "sanad: CoderRunner.respond — fail-closed approval/question resolution"
```

---

### Task 4: `/respond` route + pending in `/turn` + HTTP round-trip tests

**Files:**
- Modify: `terminal-server/src/sanad_terminal/routes_coder.py`
- Modify: `terminal-server/tests/test_routes_coder.py` (flip the P0 HTTP golden test; add respond tests)

**Interfaces:**
- Consumes: Task 3's `respond` + error codes; existing `Gated`, `Root`, `_bad_cid`, `_err`, `get_conversation`.
- Produces (P1b frontend consumes):
  - `POST /internal/coder/conversations/{cid}/respond` body `{"requestId": str, "response"?: str, "feedback"?: str, "answers"?: {str:str}}` → 200 `{"ok": true}`; 410 `request_gone`; 400 `invalid_response` / `invalid_conversation`; 409 `not_started`.
  - `GET /internal/coder/conversations/{cid}/turn` response gains `"pendingRequests": [...]` (from `pending_summaries()`; `[]` when runner is None).

- [ ] **Step 1: Flip the golden test + add failing route tests**

In `terminal-server/tests/test_routes_coder.py`: REPLACE `test_gated_tool_call_is_denied_by_default` with the round-trip below, and add the other tests. (The threading pattern: `send` streams the whole turn and blocks until it ends, so the respond POST must run while the stream is open — use the started-turn + follow pattern: POST `send` on a background thread via `client.portal`? No — keep it simple and synchronous: start the turn with `send` in a thread. `starlette.testclient` supports this with a plain `threading.Thread`.)

```python
import threading


def _respond_when_pending(client, cid: str, body: dict, out: dict):
    """Poll /turn until a pending request appears, then respond."""
    for _ in range(200):
        turn = client.get(
            f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
        ).json()
        pending = turn.get("pendingRequests") or []
        if pending:
            out["pending"] = pending
            out["response"] = client.post(
                f"/internal/coder/conversations/{cid}/respond",
                headers=HEADERS,
                json={"requestId": pending[0]["requestId"], **body},
            )
            return
        time.sleep(0.02)
    out["response"] = None


def test_approval_round_trip_over_http(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    out: dict = {}
    t = threading.Thread(
        target=_respond_when_pending, args=(client, cid, {"response": "approve"}, out)
    )
    t.start()
    res = client.post(
        f"/internal/coder/conversations/{cid}/send",
        headers=HEADERS,
        json={"input": "ASK_APPROVAL"},
    )
    t.join(timeout=10)
    assert res.status_code == 200
    assert out["response"] is not None and out["response"].status_code == 200
    assert out["pending"][0]["requestType"] == "approval"
    items = _lines(res.text)
    kinds = [i.get("kind") for i in items]
    assert "request" in kinds and "request_resolved" in kinds
    outcomes = [
        i["event"]["payload"]["response"]
        for i in items
        if i.get("kind") == "event" and i["event"].get("type") == "RequestOutcome"
    ]
    assert outcomes[0]["result"]["response"] == "approve"
    assert items[-1]["kind"] == "end" and items[-1]["status"] == "finished"


def test_respond_unknown_request_is_410(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    res = client.post(
        f"/internal/coder/conversations/{cid}/respond",
        headers=HEADERS,
        json={"requestId": "req_nope", "response": "approve"},
    )
    assert res.status_code == 410
    assert res.json()["error"]["code"] == "request_gone"


def test_respond_without_runner_is_409(client: TestClient):
    res = client.post(
        "/internal/coder/conversations/c_000000000000/respond",
        headers=HEADERS,
        json={"requestId": "r", "response": "approve"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "not_started"


def test_turn_exposes_pending_requests_field(client: TestClient):
    cid = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    ).json()["conversationId"]
    turn = client.get(
        f"/internal/coder/conversations/{cid}/turn", headers=HEADERS
    ).json()
    assert turn["pendingRequests"] == []
```

Add `import time` and `import threading` to the test file's imports if missing.

Thread-safety note: starlette's `TestClient` (an `httpx.Client`) supports concurrent requests from a second thread through its portal. If the poller thread nonetheless hits portal errors, the sanctioned fallback is creating a second `TestClient` inside the thread over the same `app` object (restructure `_make_client` to also return the app) — do NOT serialize the test by answering before `send`, which would race the request registration.

- [ ] **Step 2: RED**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_routes_coder.py -q`
Expected: new tests FAIL (404 no respond route / missing pendingRequests). The DELETED deny test no longer runs.

- [ ] **Step 3: Implement the route + turn field**

In `routes_coder.py`:

```python
class RespondBody(BaseModel):
    requestId: str = Field(min_length=1, max_length=128)
    response: str | None = Field(default=None, max_length=32)
    feedback: str | None = Field(default=None, max_length=8_000)
    answers: dict[str, str] | None = None
```

```python
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
```

And in the existing `turn` route, the runner branch returns:

```python
    return JSONResponse(
        {
            "turn": runner.turn_summary(),
            "alive": runner.alive,
            "pendingRequests": runner.pending_summaries(),
        }
    )
```

with the runner-is-None branch returning `{"turn": None, "alive": False, "pendingRequests": []}`.

- [ ] **Step 4: GREEN + full suite**

Run: `cd /Users/omar/Development/sammad-cli/terminal-server && uv run pytest tests/test_routes_coder.py -q && uv run pytest tests/ -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/routes_coder.py terminal-server/tests/test_routes_coder.py && git commit -m "sanad: /respond sidecar + pending requests in /turn — hardened approval round-trip"
```

---

### Task 5: Conversation cap

**Files:**
- Modify: `terminal-server/src/sanad_terminal/settings.py` (+ `coder_max_conversations: int = 3`, env `CODER_MAX_CONVERSATIONS`)
- Modify: `terminal-server/src/sanad_terminal/routes_coder.py` (`_spawn` gains the cap check)
- Modify: `terminal-server/tests/test_settings.py`, `terminal-server/tests/test_routes_coder.py`

**Interfaces:**
- Produces: creating/opening a conversation when `len([r for r in list_conversations(root) if r.alive]) >= settings.coder_max_conversations` → 409 `{"error":{"code":"conversation_limit","message":...}}`.

- [ ] **Step 1: Failing tests**

`tests/test_settings.py` (mirror the Task-4-P0 style with `base_env`):

```python
def test_coder_conversation_cap_defaults_and_parses(base_env):
    assert TerminalSettings.load(env=base_env).coder_max_conversations == 3
    s = TerminalSettings.load(env={**base_env, "CODER_MAX_CONVERSATIONS": "5"})
    assert s.coder_max_conversations == 5
```

`tests/test_routes_coder.py` (the fixture's settings gains `coder_max_conversations=2` — update `_make_client` to pass it):

```python
def test_conversation_cap_is_enforced(client: TestClient):
    for _ in range(2):
        assert (
            client.post(
                "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
            ).status_code
            == 200
        )
    res = client.post(
        "/internal/coder/conversations", headers=HEADERS, json={"ticket": "tt_good"}
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "conversation_limit"
```

Note: the control-plane mock only knows ticket `tt_good` and tickets are one-time in production but the mock accepts repeats — fine for cap testing.

- [ ] **Step 2: RED** — `uv run pytest tests/test_settings.py tests/test_routes_coder.py -q`; expected: both new tests fail.

- [ ] **Step 3: Implement**

`settings.py`: field `coder_max_conversations: int = 3` (below the budget fields, comment `# Live runner cap per workspace; write-lease arrives in P6.`) + `coder_max_conversations=int(e.get("CODER_MAX_CONVERSATIONS", "3")),` in `load`.

`routes_coder.py` `_spawn`, FIRST thing before ticket redemption (don't burn a one-time ticket on a doomed create):

```python
    live = [r for r in list_conversations(root) if r.alive]
    if len(live) >= settings.coder_max_conversations:
        return _err(409, "conversation_limit", "too many live conversations; stop one first")
```

(`settings = _settings(request)` already exists at the top of `_spawn`; keep the check right after it. `list_conversations` is already imported.)

- [ ] **Step 4: GREEN + full suite** — `uv run pytest tests/ -q`; all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/settings.py terminal-server/src/sanad_terminal/routes_coder.py terminal-server/tests/test_settings.py terminal-server/tests/test_routes_coder.py && git commit -m "sanad: conversation cap — CODER_MAX_CONVERSATIONS, 409 conversation_limit"
```

---

### Task 6: Architect wall-clock budget (closes the P0 machine-hold regression)

**Files:**
- Modify: `terminal-server/src/sanad_terminal/settings.py` (+ `architect_max_turn_seconds: float = 1800.0`, env `ARCHITECT_MAX_TURN_SECONDS`)
- Modify: `terminal-server/src/sanad_terminal/architect_runner.py` (ctor accepts + forwards `max_turn_seconds`)
- Modify: `terminal-server/src/sanad_terminal/routes_architect.py` (`start` passes `max_turn_seconds=settings.architect_max_turn_seconds`)
- Modify: `terminal-server/tests/test_settings.py`, `terminal-server/tests/test_routes_architect.py`

**Interfaces:**
- Produces: `ArchitectRunner(*, argv, cwd, env, uid=None, gid=None, max_turn_seconds: float | None = None)` — step budget stays absent (architect turns are short; the wall clock is the machine-hold bound). Context: P0's IdleStopper probes hold the machine while any runner turn runs — a hung architect turn previously meant an idle-stop (bad UX), now means an unbounded hold (worse: unbounded billing). The budget bounds it; a budget-cancelled turn ends `cancelled`, which `_recycling_stream` treats as a normal end.

- [ ] **Step 1: Failing tests**

`tests/test_settings.py`:

```python
def test_architect_budget_defaults_and_parses(base_env):
    assert TerminalSettings.load(env=base_env).architect_max_turn_seconds == 1800.0
    s = TerminalSettings.load(env={**base_env, "ARCHITECT_MAX_TURN_SECONDS": "60"})
    assert s.architect_max_turn_seconds == 60.0
```

`tests/test_routes_architect.py` — add (uses the architect fake, which finishes instantly; the assertion is wiring-level: the runner carries the budget):

```python
def test_architect_runner_carries_wall_clock_budget(client: TestClient):
    assert (
        client.post(
            "/internal/architect/start", headers=HEADERS, json={"ticket": "tt_good"}
        ).status_code
        == 200
    )
    from sanad_terminal.architect_runner import _runners

    runner = next(iter(_runners.values()))
    assert runner._max_turn_seconds == 1800.0
```

(Reaching into `_runners`/`_max_turn_seconds` is white-box but matches this suite's existing style of asserting internals via the fake; the behavioral budget mechanics are already covered by `test_wall_clock_budget_cancels_a_hung_turn` on the base class.)

- [ ] **Step 2: RED** — `uv run pytest tests/test_settings.py tests/test_routes_architect.py -q`; the two new tests fail (`TypeError` on unexpected kwarg / missing attr / missing setting).

- [ ] **Step 3: Implement**

`settings.py`: field `architect_max_turn_seconds: float = 1800.0` with comment `# Wall-clock bound on one architect turn — with idle probes holding the machine during turns, a hung turn must cancel rather than hold the machine forever.` + `architect_max_turn_seconds=float(e.get("ARCHITECT_MAX_TURN_SECONDS", "1800")),` in `load`.

`architect_runner.py`:

```python
class ArchitectRunner(WireRunner):
    def __init__(self, *, argv, cwd, env, uid=None, gid=None, max_turn_seconds=None) -> None:  # noqa: ANN001
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            client_name="sanad-architect-bridge",
            capabilities={"supports_question": False, "supports_plan_mode": False},
            max_turn_seconds=max_turn_seconds,
        )
```

`routes_architect.py` `start`: the construction becomes

```python
    runner = ArchitectRunner(
        argv=argv, cwd=root, env=env, uid=uid, gid=gid,
        max_turn_seconds=settings.architect_max_turn_seconds,
    )
```

- [ ] **Step 4: GREEN + full suite** — `uv run pytest tests/ -q`; all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add terminal-server/src/sanad_terminal/settings.py terminal-server/src/sanad_terminal/architect_runner.py terminal-server/src/sanad_terminal/routes_architect.py terminal-server/tests/test_settings.py terminal-server/tests/test_routes_architect.py && git commit -m "sanad: architect wall-clock budget — bounded machine hold under idle probes"
```

---

### Task 7: sanad-web `/api/coder/*` proxies + coder gate

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/workspace/proxy.ts` (add `authenticateCoderPanel`)
- Create: `control-plane/artifacts/sanad-web/app/api/coder/conversations/route.ts` (GET list, POST create)
- Create: `control-plane/artifacts/sanad-web/app/api/coder/conversations/[cid]/{open,send,turn,follow,respond,cancel,stop}/route.ts` (7 files)
- Create: `control-plane/artifacts/sanad-web/tests/unit/coder-gate.test.ts`

**Interfaces:**
- Consumes: `authenticateWorkspace`, `workspaceFetch`, `relayJson`, `relayStream` (read `lib/workspace/proxy.ts` exports first — `relayStream` is the NDJSON passthrough the architect `ask` route uses; mirror `app/api/architect/ask/route.ts` and `follow/route.ts` exactly for the streaming pair), `isCoderPanelAllowed` from `@/lib/auth/coder`.
- Produces (P1b consumes): browser-facing routes mapping 1:1 onto `/internal/coder/*`:
  - `GET/POST /api/coder/conversations?session=<id>`
  - `POST /api/coder/conversations/<cid>/{open,send,respond,cancel,stop}?session=<id>`
  - `GET /api/coder/conversations/<cid>/{turn,follow}?session=<id>` (`follow` also takes `turnId`, `from_seq` query params, forwarded)
  - Gate: not signed in → 401; signed in but `!isCoderPanelAllowed(email)` → 403 `coder_not_enabled`; `!isTerminalAllowed` still 403 `terminal_not_enabled` (checked first — coder access presumes workspace access).

- [ ] **Step 1: Failing gate test**

Create `tests/unit/coder-gate.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";

const auth = vi.fn();
const currentUser = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: (...a: unknown[]) => auth(...a),
  currentUser: (...a: unknown[]) => currentUser(...a),
}));

import { authenticateCoderPanel } from "@/lib/workspace/proxy";

describe("authenticateCoderPanel", () => {
  const origTerm = process.env.SANAD_TERMINAL_EMAILS;
  const origCoder = process.env.SANAD_CODER_PANEL_EMAILS;
  afterEach(() => {
    process.env.SANAD_TERMINAL_EMAILS = origTerm ?? "";
    process.env.SANAD_CODER_PANEL_EMAILS = origCoder ?? "";
    if (origTerm === undefined) delete process.env.SANAD_TERMINAL_EMAILS;
    if (origCoder === undefined) delete process.env.SANAD_CODER_PANEL_EMAILS;
    vi.clearAllMocks();
  });

  it("401 when not signed in", async () => {
    auth.mockResolvedValue({ userId: null });
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });

  it("403 terminal_not_enabled when workspace access is missing", async () => {
    auth.mockResolvedValue({ userId: "u1" });
    currentUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "x@y.z" }] });
    process.env.SANAD_TERMINAL_EMAILS = "";
    process.env.SANAD_CODER_PANEL_EMAILS = "x@y.z";
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
  });

  it("403 coder_not_enabled when only the coder allowlist is missing", async () => {
    auth.mockResolvedValue({ userId: "u1" });
    currentUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "x@y.z" }] });
    process.env.SANAD_TERMINAL_EMAILS = "x@y.z";
    process.env.SANAD_CODER_PANEL_EMAILS = "";
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(403);
      const body = await gate.response.json();
      expect(body.error.code).toBe("coder_not_enabled");
    }
  });

  it("ok with both allowlists", async () => {
    auth.mockResolvedValue({ userId: "u1" });
    currentUser.mockResolvedValue({ emailAddresses: [{ emailAddress: "x@y.z" }] });
    process.env.SANAD_TERMINAL_EMAILS = "x@y.z";
    process.env.SANAD_CODER_PANEL_EMAILS = "x@y.z";
    const gate = await authenticateCoderPanel();
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.userId).toBe("u1");
  });
});
```

Before writing the test, check how existing tests mock Clerk (grep `tests/` for `@clerk/nextjs/server` mocks) — if a different established pattern exists, use that pattern with the same four cases.

- [ ] **Step 2: RED** — `cd /Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web && pnpm test tests/unit/coder-gate.test.ts`; expected: fails (no export).

- [ ] **Step 3: Implement `authenticateCoderPanel`**

In `lib/workspace/proxy.ts`, next to `authenticateWorkspace` (reuse its pieces; import `isCoderPanelAllowed` from `@/lib/auth/coder`):

```ts
/**
 * Coder-panel gate: workspace access (Clerk + SANAD_TERMINAL_EMAILS) plus the
 * stricter SANAD_CODER_PANEL_EMAILS allowlist — write-capable agent access is
 * grantable to a subset of workspace users. Both fail closed.
 */
export async function authenticateCoderPanel(): Promise<WorkspaceAuth> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, response: err(401, "unauthorized", "Must be signed in") };
  }
  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses[0]?.emailAddress ?? "";
  if (!isTerminalAllowed(email)) {
    return {
      ok: false,
      response: err(
        403,
        "terminal_not_enabled",
        "The web workspace is not enabled for this account"
      ),
    };
  }
  if (!isCoderPanelAllowed(email)) {
    return {
      ok: false,
      response: err(
        403,
        "coder_not_enabled",
        "The coding agent is not enabled for this account"
      ),
    };
  }
  return { ok: true, userId };
}
```

- [ ] **Step 4: Gate test GREEN** — `pnpm test tests/unit/coder-gate.test.ts`; passes.

- [ ] **Step 5: Create the proxy routes**

First read `app/api/architect/ask/route.ts`, `follow/route.ts`, and `turn/route.ts` — the coder routes are the same three shapes (JSON POST → `relayJson`; NDJSON POST/GET → the streaming relay used by ask/follow; plain GET → `relayJson`), with `authenticateCoderPanel()` in place of `authenticateWorkspace()` and paths under `/internal/coder/...`. Representative file — `app/api/coder/conversations/[cid]/send/route.ts`:

```ts
import { NextRequest } from "next/server";
import { authenticateCoderPanel, workspaceFetch } from "@/lib/workspace/proxy";
import { relayStream } from "@/lib/workspace/proxy"; // match the actual export name used by architect ask

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  const gate = await authenticateCoderPanel();
  if (!gate.ok) return gate.response;
  const { cid } = await params;
  const sessionId = req.nextUrl.searchParams.get("session") ?? undefined;
  const body = await req.text();
  const upstream = await workspaceFetch(
    gate.userId,
    `/internal/coder/conversations/${encodeURIComponent(cid)}/send`,
    {
      sessionId,
      method: "POST",
      body: body || "{}",
      headers: { "content-type": "application/json" },
    }
  );
  return relayStream(upstream);
}
```

Apply the same pattern across all 8 route files: `conversations` (GET → relayJson of upstream GET; POST → relayJson), `open` (POST → relayJson), `send` (POST → stream), `turn` (GET → relayJson), `follow` (GET → stream; forward `turnId` + `from_seq` query params onto the upstream path), `respond` (POST → relayJson), `cancel` (POST → relayJson), `stop` (POST → relayJson). Match the architect routes' exact relay helper names and error handling — if the architect `ask` route wraps the stream differently (e.g. checks upstream.ok first), copy that structure verbatim.

- [ ] **Step 6: Type-check + full web tests**

Run: `cd /Users/omar/Development/sammad-cli/control-plane/artifacts/sanad-web && pnpm exec tsc --noEmit 2>&1 | head -20 && pnpm test`
Expected: no NEW type errors in the files this task created (pre-existing errors in Omar's dirty files are out of scope — note them, don't fix); test suite passes (the pre-existing state of `architect-transcript.test.ts` is whatever Omar left; do not touch it).

- [ ] **Step 7: Commit**

```bash
cd /Users/omar/Development/sammad-cli && git add control-plane/artifacts/sanad-web/lib/workspace/proxy.ts control-plane/artifacts/sanad-web/app/api/coder control-plane/artifacts/sanad-web/tests/unit/coder-gate.test.ts && git commit -m "sanad: /api/coder proxies behind the coder-panel gate"
```

---

## P1a exit criteria (spec traceability)

| Spec item | Where |
|---|---|
| Request bridge: journal + pending registry, envelope classification | Task 2 |
| Fail-closed respond sidecar (`request_gone` 410, strict pending check) | Tasks 3–4 |
| Capabilities flip (question + plan mode) with conscious golden-test flip | Task 2 (base deny test untouched) |
| Requests outside a running turn rejected (background lane deferred to P3/P4) | Task 2 |
| Conversation caps (spec: 3 live) | Task 5 |
| P0 heads-up: async `on_request` seam | Task 1 |
| P0 heads-up: architect unbounded-hold regression | Task 6 |
| Web proxies + separate coder gate (fail closed) | Task 7 |

Not in P1a (do not add): panel UI (P1b), durable journal + `journal_sink` param (P3), queue/steer routes (P4), `set_permission_mode` + mode seeding (P2), checkpoints (P5), session lease (P6), background lane + `out_of_turn_event` param (P4/P7).
