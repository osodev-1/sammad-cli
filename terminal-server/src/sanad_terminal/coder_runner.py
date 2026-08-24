"""The Coder runner — `sanad --wire --session <conversationId>` on the
WireRunner base. One runner per CONVERSATION (not per workspace): a
conversation IS a kimi session id, which is what makes "one brain, two
views" literal later (the TUI resumes the same id).

P1 posture: capabilities are true/true and inbound ApprovalRequest /
QuestionRequest frames are bridged — journaled into the turn and registered
in a per-runner pending registry so the browser can see and answer them
(`respond`, landing in the next commit, resolves them back onto the wire).
ToolCallRequest and any other/unknown request type is still rejected, as is
any request outside a running turn (the background lane — asking after the
turn already ended — is P3/P4). Budgets are mandatory here (settings-driven),
unlike the architect: a browser-driven turn can run unattended and must be
bounded.
"""

from __future__ import annotations

import re
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger

from sanad_terminal.coder_journal import CoderJournal
from sanad_terminal.wire_runner import TurnState, WireRunner, WireRunnerError, register_registry

# Server-minted only (P0); the shape keeps ids path- and shell-safe.
CONVERSATION_ID_RE = re.compile(r"^c_[a-f0-9]{12}$")


def new_conversation_id() -> str:
    return f"c_{uuid.uuid4().hex[:12]}"


@dataclass
class PendingRequest:
    request_id: str
    request_type: str  # "approval" | "question"
    turn_id: str
    created_at: float
    request: dict[str, Any]


_PERMISSION_MODES = {"default", "accept-edits", "plan"}


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
        rlimit_nproc: int = 0,
        rlimit_fsize: int = 0,
        max_turn_seconds: float,
        max_steps_per_turn: int,
        journal_dir: Path | None = None,
        journal_turns_keep: int = 20,
        journal_max_bytes: int = 20 * 1024 * 1024,
        max_queue_depth: int = 50,
    ) -> None:
        # Built before super().__init__() so its `.append` can be threaded
        # in as the journal_sink. `journal_dir=None` (the architect, and any
        # bare-runner test construction) keeps this None — no durable
        # journal, no behavior change at all.
        self._journal: CoderJournal | None = None
        journal_sink = None
        if journal_dir is not None:
            self._journal = CoderJournal(
                journal_dir, turns_keep=journal_turns_keep, max_bytes=journal_max_bytes
            )
            journal_sink = self._journal.append
        super().__init__(
            argv=argv,
            cwd=cwd,
            env=env,
            uid=uid,
            gid=gid,
            rlimit_nproc=rlimit_nproc,
            rlimit_fsize=rlimit_fsize,
            client_name="sanad-coder-bridge",
            capabilities={"supports_question": True, "supports_plan_mode": True},
            max_turn_seconds=max_turn_seconds,
            max_steps_per_turn=max_steps_per_turn,
            journal_sink=journal_sink,
        )
        self.conversation_id = conversation_id
        self.permission_mode: str = "default"
        self._pending_requests: dict[str, PendingRequest] = {}
        # Server-side follow-up queue (P4b) — RAM-only (lost on crash/restart,
        # re-typable): a `collections.deque` of `{"sendId": str, "input": str}`,
        # drained one-at-a-time by `_maybe_drain_queue` as each turn ends.
        self._queue: deque[dict[str, Any]] = deque()
        # Depth cap (P4 final-review, Important C) — every sibling resource
        # (journal turns kept, steps per turn, live conversations, journal
        # bytes) is capped; an authenticated `POST /send {queue:true}` spam
        # loop must not be the one that grows RAM unbounded.
        self._max_queue_depth = max_queue_depth
        # Durable index bookkeeping (P3) — the base's own `_turns`/`_turn_order`
        # RAM cache evicts terminal turns beyond `_TURN_KEEP` (5); this list is
        # the durable-retention view (bounded by `journal_turns_keep`, default
        # 20) that becomes turns.json.
        self._journal_index: list[dict[str, Any]] = []
        # Restart recovery (P3 Task 2): rebuild TurnStates from whatever is
        # already on disk for this conversation, and reconcile any turn that
        # was left "running" when the process died. A freshly minted
        # conversation (no journal_dir, or an empty one) is a no-op here.
        self._reconstruct_from_journal()

    # -- permission mode (P2a) -------------------------------------------------

    async def set_permission_mode(self, mode: str) -> None:
        """Switch the agent's approval posture. Validates locally (never a
        wire round trip for a bad mode — `yolo` is not a thing), then calls
        the CLI and only adopts the new mode into local tracking on success:
        a failed/rejected call leaves the previously-known posture intact."""
        if mode not in _PERMISSION_MODES:
            raise WireRunnerError("invalid_mode", f"unknown permission mode: {mode!r}")
        await self.call("set_permission_mode", {"mode": mode})
        self.permission_mode = mode

    # -- steering (P4a) --------------------------------------------------------

    async def steer(self, text: str) -> None:
        """Inject a follow-up into the active turn without ending it. Guarded
        locally exactly like the wire layer's own `_handle_steer` (an active
        streaming turn is required) so a stale/finished turn fails closed
        here instead of round-tripping to the CLI only to be rejected there.
        The soul injects `text` as a user message at the next step boundary
        and emits a `SteerInput` event back over the wire — journaled onto
        the SAME turn like any other event, no new turn started."""
        if not self.alive or not self.busy:
            raise WireRunnerError("no_turn", "no turn is in progress")
        await self.call("steer", {"user_input": text})

    # -- server-side queue (P4b) -----------------------------------------------

    def enqueue(self, send_id: str, input: str) -> int:
        """Queue a follow-up for after the running turn ends — RAM-only, so
        a crash/restart loses it (re-typable, not a data-loss concern).

        Idempotent on `send_id`, mirroring `start_turn`'s own idempotency
        intent: a resend already sitting in the queue, already the running
        turn, or already the last turn that just finished is never
        double-added. Returns the item's 1-based position in the queue (the
        `"position"` the `/send` route reports), or `0` when nothing was
        queued because the send_id was already handled elsewhere.

        Journals a `{"kind":"queued", ...}` item into the CURRENT turn's
        journal (`self._current`, if any) so a later replay can see queue
        depth grow — via `_append_sync`/the sink directly rather than
        `_append`: this runs outside the turn's own consume loop, and queue
        depth is read through `/turn` (`queue_summary`), not streamed, so no
        `_journal_cond` notify is needed here. Deliberately leaves room for a
        future `"reason"` key (P6: e.g. `waiting_for_lease`) without adding
        its logic now.

        Depth-capped at `self._max_queue_depth` (P4 final-review, Important
        C): a genuinely NEW item (not an idempotent resend of one already
        queued/running/just-finished) is refused once the queue is already
        at the cap — raises `WireRunnerError("queue_full", ...)` rather than
        silently dropping it, so `/send` can surface a real error instead of
        lying about having queued something it didn't. The cap check runs
        AFTER the idempotency checks above so a resend of an already-queued
        send_id never trips it, and refusal never appends to either
        `self._queue` or the running turn's `state.items`.
        """
        for i, item in enumerate(self._queue):
            if item["sendId"] == send_id:
                return i + 1
        cur = self._current
        if cur is not None and cur.status == "running" and cur.send_id == send_id:
            return 0
        if self._turn_order:
            last = self._turns[self._turn_order[-1]]
            if last.send_id == send_id:
                return 0
        if len(self._queue) >= self._max_queue_depth:
            raise WireRunnerError(
                "queue_full", f"the follow-up queue is full (max {self._max_queue_depth})"
            )
        self._queue.append({"sendId": send_id, "input": input})
        if cur is not None:
            self._append_sync(cur, {"kind": "queued", "sendId": send_id, "input": input})
        return len(self._queue)

    def dequeue(self, send_id: str) -> bool:
        """Remove a not-yet-started queued item by `send_id`. Returns
        whether anything was actually removed."""
        for i, item in enumerate(self._queue):
            if item["sendId"] == send_id:
                del self._queue[i]
                return True
        return False

    def queue_summary(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._queue]

    async def _maybe_drain_queue(self) -> None:
        """Start the next queued follow-up once the current turn has ended.

        A single overridable hook — P6 interposes a write-lease check here
        without touching `_consume` itself. Called from `_consume`'s
        `finally`, AFTER the existing turn-end bookkeeping.

        Concurrency: the not-busy check and the `start_turn` call below have
        NO `await` between them. `start_turn` flips `busy` True the moment
        it runs — synchronously, before its own first internal `await` (it
        sets `self._current = state` several lines before touching anything
        async) — and asyncio is single-threaded, so no other coroutine can
        run between this method's check and that flip. A gapless
        check-then-start here can therefore never let two concurrent drains
        double-pop the same queue entry.

        `start_turn` CAN still raise after the `popleft()` below — most
        plausibly `_send`'s pipe write failing while `self.alive` was still
        True (the subprocess died in the narrow gap between this method's
        alive-check and the write). Left unguarded, that would both strand
        the popped item (gone from `self._queue`, never actually started)
        and propagate a raw `WireRunnerError` out of this method — which
        matters because this is called from TWO places: `_consume`'s
        `finally` (fire-and-forget; an unhandled exception there just leaks
        as an unretrieved task exception) and `/send`'s idle-drain path in
        routes_coder.py (a live request context, where an unhandled
        exception becomes an opaque 500 instead of the sibling
        `{"error":{"code","message"}}` envelope every other failure here
        uses). Guarding HERE, once, fixes both call sites identically: put
        the item back at the head of the queue (so it retries on the next
        drain — turn-end, or a later idle `/send` — instead of vanishing)
        and swallow the error after logging, so neither caller ever sees an
        exception propagate out of this method.
        """
        if not self._queue or not self.alive or self.busy:
            return
        item = self._queue.popleft()
        try:
            await self.start_turn(item["input"], send_id=item["sendId"])
        except WireRunnerError as exc:
            self._queue.appendleft(item)
            logger.warning(
                "coder queue drain failed for conversation {} (sendId={}): {}",
                self.conversation_id,
                item["sendId"],
                exc.message,
            )

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
        self._pending_requests[rid] = PendingRequest(
            request_id=rid,
            request_type=request_type,
            turn_id=state.turn_id,
            created_at=time.time(),
            request=payload,
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
            for p in self._pending_requests.values()
        ]

    _APPROVAL_KINDS = {"approve", "approve_for_session", "reject"}

    async def respond(self, request_id: str, payload: dict[str, Any]) -> None:
        """Answer a pending approval/question. Fail closed: the request must
        be pending on THIS runner (strict check — never rely on the wire
        layer's lenient id match), and the payload must validate for its
        type. A bad payload leaves the request pending."""
        pending = self._pending_requests.get(request_id)
        if pending is None:
            raise WireRunnerError("request_gone", "no such pending request")
        if pending.request_type == "approval":
            response = payload.get("response")
            if response not in self._APPROVAL_KINDS:
                raise WireRunnerError(
                    "invalid_response",
                    "response must be approve|approve_for_session|reject",
                )
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
        self._pending_requests.pop(request_id, None)
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

    # -- durable journal boundaries (P3 Task 1 — write side only) -------------

    @staticmethod
    def _journal_entry(state: TurnState) -> dict[str, Any]:
        return {
            "turnId": state.turn_id,
            "status": state.status,
            "sendId": state.send_id,
            "startedAt": state.started_at,
            "lastSeq": state.last_seq,
            # Carried so reconstruction (P3 Task 2) can rebuild a real
            # TurnState.user_input — the NDJSON "turn" item itself only
            # carries turnId, never the prompt text. Same [:200] clip
            # `TurnState.summary()` already applies for display.
            "userInput": state.user_input[:200],
        }

    def _journal_note_turn(self, state: TurnState) -> None:
        """Insert/update this turn's entry in the durable index and persist
        it — called at both turn start and turn end. No-op when no durable
        journal is configured."""
        if self._journal is None:
            return
        entry = self._journal_entry(state)
        for i, existing in enumerate(self._journal_index):
            if existing.get("turnId") == state.turn_id:
                self._journal_index[i] = entry
                break
        else:
            self._journal_index.append(entry)
        if len(self._journal_index) > self._journal.turns_keep:
            self._journal_index = self._journal_index[-self._journal.turns_keep :]
        self._journal.write_index(list(self._journal_index))

    # -- restart recovery (P3 Task 2 — load + reconcile on construction) ------

    def _reconstruct_from_journal(self) -> None:
        """Rebuild in-memory `TurnState`s from whatever is durably on disk
        for this conversation — the restart-recovery core. Runs once, at
        the tail of `__init__`, before this runner is handed to anyone.

        Any turn whose last-written status is still "running" means the
        process died mid-turn (crash, idle-stop, deploy): reconcile it to
        the terminal "interrupted" status, cancelling any request left
        dangling (nothing can ever answer it — the CLI process that owned
        it is gone). Reconciliation writes through the journal sink too, so
        disk and memory agree, and the terminal status is persisted back to
        the index — a second construction over the same journal finds
        nothing left running and is a no-op (idempotent).
        """
        if self._journal is None:
            return
        index, items_by_turn = self._journal.load()
        if not index:
            return
        dirty = False
        for entry in index:
            turn_id = entry.get("turnId")
            if not isinstance(turn_id, str):
                continue
            items = list(items_by_turn.get(turn_id, []))
            started_at = entry.get("startedAt")
            send_id = entry.get("sendId")
            user_input = entry.get("userInput")
            status = entry.get("status")
            state = TurnState(
                turn_id=turn_id,
                user_input=user_input if isinstance(user_input, str) else "",
                status=status if isinstance(status, str) else "failed",
                started_at=started_at if isinstance(started_at, int | float) else time.time(),
                send_id=send_id if isinstance(send_id, str) else None,
                items=items,
            )
            state.steps = sum(
                1
                for item in items
                if item.get("kind") == "event"
                and isinstance(item.get("event"), dict)
                and item["event"].get("type") == "StepBegin"
            )
            if state.status == "running":
                self._reconcile_interrupted_turn(state)
                dirty = True
            self._turns[turn_id] = state
            self._turn_order.append(turn_id)
            self._journal_index.append(self._journal_entry(state))

        self._evict_old_turns()
        if len(self._journal_index) > self._journal.turns_keep:
            self._journal_index = self._journal_index[-self._journal.turns_keep :]

        if dirty:
            self._journal.write_index(list(self._journal_index))

    def _reconcile_interrupted_turn(self, state: TurnState) -> None:
        """Close out a crash-interrupted turn honestly instead of leaving it
        `"running"` forever (which would hang `follow()` on `_journal_cond`
        for a turn nothing will ever advance again).

        For every `request` item with no later `request_resolved`/
        `request_cancelled` for the same `requestId`, journal a synthetic
        `request_cancelled` (reason `interrupted_by_restart`) — deliberately
        NOT registered into `_pending_requests`: the CLI process that could
        answer it is gone, so there is nothing to keep pending. Then close
        the turn with an explanatory `error` and a terminal `end`.
        """
        resolved_ids: set[str] = set()
        requested_ids: list[str] = []
        for item in state.items:
            rid = item.get("requestId")
            if not isinstance(rid, str):
                continue
            kind = item.get("kind")
            if kind == "request":
                requested_ids.append(rid)
            elif kind in ("request_resolved", "request_cancelled"):
                resolved_ids.add(rid)

        cancelled: set[str] = set()
        for rid in requested_ids:
            if rid in resolved_ids or rid in cancelled:
                continue
            cancelled.add(rid)
            self._append_sync(
                state,
                {
                    "kind": "request_cancelled",
                    "requestId": rid,
                    "reason": "interrupted_by_restart",
                },
            )
        self._append_sync(
            state,
            {
                "kind": "error",
                "code": "interrupted_by_restart",
                "message": "This turn was interrupted by a workspace restart.",
            },
        )
        self._append_sync(state, {"kind": "end", "status": "interrupted"})
        state.status = "interrupted"

    async def start_turn(self, user_input: str, send_id: str | None = None) -> TurnState:
        state = await super().start_turn(user_input, send_id)
        if self._journal is not None:
            self._journal_note_turn(state)
            # Retention: beyond `turns_keep`, drop the oldest turn files —
            # done at turn start (not on every append) since that's the only
            # point a conversation's turn count can grow.
            self._journal.prune([e["turnId"] for e in self._journal_index])
        return state

    async def _consume(self, state, queue) -> None:  # noqa: ANN001
        try:
            await super()._consume(state, queue)
        finally:
            await self._cancel_pending("turn_ended", state)
            if self._journal is not None:
                self._journal_note_turn(state)
                # Not per-item (EFS latency) — one fsync when the turn closes.
                self._journal.fsync_turn(state.turn_id)
            # Turn-end boundary (P4b): drain the next queued follow-up, if
            # any — AFTER the bookkeeping above so a queued turn's own
            # journal/fsync never races the one just closing out.
            await self._maybe_drain_queue()

    async def stop(self) -> None:
        await super().stop()
        state = self._current
        if state is not None:
            await self._cancel_pending("runner_stopped", state)
        else:
            self._pending_requests.clear()

    async def _cancel_pending(self, reason: str, state) -> None:  # noqa: ANN001
        for rid in list(self._pending_requests):
            self._pending_requests.pop(rid, None)
            await self._append(
                state, {"kind": "request_cancelled", "requestId": rid, "reason": reason}
            )


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
