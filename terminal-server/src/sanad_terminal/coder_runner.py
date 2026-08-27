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

import asyncio
import re
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger

from sanad_terminal.coder_journal import CoderJournal
from sanad_terminal.git_ops import GitRepo, _checkpoint_ref
from sanad_terminal.wire_runner import TurnState, WireRunner, WireRunnerError, register_registry
from sanad_terminal.workspace_lease import lease_for

# Server-minted only (P0); the shape keeps ids path- and shell-safe.
CONVERSATION_ID_RE = re.compile(r"^c_[a-f0-9]{12}$")

# The diff summary (P5) only needs numstat-derived COUNTS (filesChanged/
# additions/deletions), never the patch text itself — those counts are
# computed from the un-truncated numstat output regardless of `max_bytes`
# (see `GitRepo.checkpoint_diff`), so any value here is correct; this just
# mirrors `TerminalSettings.coder_diff_max_bytes`'s default so the discarded
# patch text this call still builds stays reasonably bounded.
_CHECKPOINT_SUMMARY_MAX_BYTES = 200_000


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

# `cancel()`'s bounded wait for a prompt that hasn't been sent yet (P6a
# review Important 7) — see `CoderRunner.cancel`. Generous relative to the
# window it covers (P5's pre-turn git checkpoint, real seconds against a
# real repo at worst) without risking a genuinely stuck caller: if the
# bound elapses, `cancel()` still falls through to the base's own
# already-safe no-op rather than hanging forever.
_CANCEL_PENDING_PROMPT_TIMEOUT_SECONDS = 5.0
_CANCEL_PENDING_PROMPT_POLL_INTERVAL_SECONDS = 0.02


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
        # Shadow-checkpoint plumbing (P5 Task 2) — bound to the SAME
        # workspace root + agent uid/gid/home the wire subprocess itself
        # runs as (mirrors the `_repo()`/`app.py` boot-time GitRepo wiring:
        # `home` sits beside `workspace/`, so `cwd.parent / "home"`), so
        # checkpoint commits land with the same ownership the agent writes
        # under uid-split. `_checkpoints` is a CoderRunner-only side-map
        # (turn_id -> {"pre": sha|None, "post": sha|None, "summary": {...}|None})
        # — deliberately NOT a TurnState field (TurnState is shared with
        # ArchitectRunner). `_last_checkpoint_sha` is the most recent
        # checkpoint commit (any turn's pre or post) so the NEXT turn's pre
        # checkpoint chains onto it (`parent=`) instead of starting a fresh
        # parentless history each turn.
        home = cwd.parent / "home"
        self._git = GitRepo(cwd, uid=uid, gid=gid, home=home if home.is_dir() else None)
        self._checkpoints: dict[str, dict[str, Any]] = {}
        self._last_checkpoint_sha: str | None = None
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
        the SAME turn like any other event, no new turn started.

        Also requires `self._prompt_id is not None` (P6a) — `self.busy`
        alone goes true the instant `start_turn` sets `self._current`,
        BEFORE the prompt this steer is meant to follow up on has actually
        been transmitted (see the comment in `WireRunner.start_turn` at the
        `_before_prompt_sent` call site). Without this, a steer landing in
        that window would reach the wire ahead of its own prompt and get
        silently dropped by the CLI, which has no turn yet to steer.
        `cancel()` is overridden below with a DIFFERENT fix for the same
        window — it waits rather than rejects, since a cancel that's simply
        dropped there is worse than a steer that's simply dropped there
        (see `cancel`'s own docstring)."""
        if not self.alive or not self.busy or self._prompt_id is None:
            raise WireRunnerError("no_turn", "no turn is in progress")
        await self.call("steer", {"user_input": text})

    async def cancel(self) -> None:
        """Interrupt the active turn. Overrides `WireRunner.cancel` to close
        the SAME pre-prompt-sent window `steer()` closes above, but with a
        different fix (P6a review Important 7): base `cancel()` already
        guards on `self._prompt_id is None` and safely no-ops there — it
        never sends a stray wire message for a prompt that hasn't gone out
        — but a genuine `/cancel` landing in that window is then simply
        FORGOTTEN, and the turn runs to completion as if nothing happened.
        That was already not great; under the write-lease it's worse: the
        un-cancelled turn goes on to hold the workspace write-lease for its
        ENTIRE duration, blocking every OTHER conversation in the
        workspace, not just its own follow-ups — so a cancel silently
        eaten here can wedge the whole workspace for up to the turn's full
        budget.

        Fix: if the turn looks busy but the prompt hasn't been sent yet,
        wait (bounded — `_CANCEL_PENDING_PROMPT_TIMEOUT_SECONDS`) for
        `self._prompt_id` to appear, polling `self.busy` too so a turn that
        ends on its own (finishes, fails, or this runner is stopped) during
        the wait doesn't spin uselessly. Once the prompt is sent (or the
        bound elapses, or the turn stopped looking busy), fall through to
        the base implementation — its existing checks remain the real
        gate, this only widens the window in which they get a fair chance
        to see a sent prompt instead of a stale `None`."""
        if self.busy and self._prompt_id is None:
            deadline = time.monotonic() + _CANCEL_PENDING_PROMPT_TIMEOUT_SECONDS
            while self.busy and self._prompt_id is None and time.monotonic() < deadline:
                await asyncio.sleep(_CANCEL_PENDING_PROMPT_POLL_INTERVAL_SECONDS)
        await super().cancel()

    # -- server-side queue (P4b) -----------------------------------------------

    def enqueue(
        self,
        send_id: str,
        input: str,
        *,
        reason: str | None = None,
        blocked_by: str | None = None,
    ) -> int:
        """Queue a follow-up for after the running turn ends — RAM-only, so
        a crash/restart loses it (re-typable, not a data-loss concern).

        Idempotent on `send_id`, mirroring `start_turn`'s own idempotency
        intent: a resend already sitting in the queue, already the running
        turn, or already the last turn that just finished is never
        double-added. Returns the item's 1-based position in the queue (the
        `"position"` the `/send` route reports), or `0` when nothing was
        queued because the send_id was already handled elsewhere.

        `reason`/`blocked_by` (P6a — this is the room the original P4b
        docstring left for a future `"reason"` key): both optional and
        additive, surfaced as `"reason"`/`"blockedBy"` in the queued item
        (and mirrored into its journal marker) only when given, so an
        ordinary queue item's shape is byte-for-byte unchanged. Task 3's
        `/send` route sets `reason="waiting_for_lease"` plus
        `blocked_by=<holder conversation id>` when `start_turn` raised
        `WireRunnerError("lease_unavailable", ...)`, so the UI can say
        "waiting for conversation X" from `queue_summary()`/`/turn`'s
        `queue` field.

        Journals a `{"kind":"queued", ...}` item into the CURRENT turn's
        journal (`self._current`, if any) so a later replay can see queue
        depth grow — via `_append_sync`/the sink directly rather than
        `_append`: this runs outside the turn's own consume loop, and queue
        depth is read through `/turn` (`queue_summary`), not streamed, so no
        `_journal_cond` notify is needed here.

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
        item: dict[str, Any] = {"sendId": send_id, "input": input}
        if reason is not None:
            item["reason"] = reason
        if blocked_by is not None:
            item["blockedBy"] = blocked_by
        self._queue.append(item)
        if cur is not None:
            self._append_sync(cur, {"kind": "queued", **item})
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

        A single overridable hook — P6a interposes the write-lease check
        below without touching `_consume` itself. Called from `_consume`'s
        `finally` (this runner's OWN turn-end, AFTER the lease release —
        see `_consume`), from `/send`'s idle-drain path in routes_coder.py,
        and — the cross-runner handoff — from `_wake_next_waiter`, called on
        a DIFFERENT runner than the one whose turn just ended, so a
        conversation queued at the lease actually starts once it frees
        rather than waiting for its own (nonexistent, since it never had a
        turn) turn-end.

        Lease gate (P6a): even with an alive, non-busy runner and a
        non-empty queue, this must NOT pop-and-start unless the write-lease
        is actually acquirable by THIS conversation — read-only peek
        (`is_held_by(self) or holder_of() is None`), not `try_acquire`
        itself: mutating here would mean this method's own "did I just
        acquire fresh" bookkeeping and `start_turn`'s (separate) bookkeeping
        would disagree about who needs to release on a subsequent failure,
        which is exactly the leak shape `start_turn` guards against for
        itself. A holder past the lease's own TTL is treated as absent here
        too (review Important 5) — otherwise the ONE population this
        feature creates (conversations parked in the queue specifically
        because the lease was busy) would be exactly the population that
        can never reach `try_acquire`'s real staleness reclaim, since a
        pure drain-only conversation has no other path back into
        `start_turn`. Still read-only: the actual reclaim (and the
        `WriteLease` warning log it emits) only ever happens inside
        `start_turn`'s real `try_acquire` call below, never here.

        If someone else holds it (and isn't stale), `add_waiter` (review
        Critical 4) THEN leave the item queued and return — no spin, no
        busy-wait. Registering the waiter here, not only from `start_turn`'s
        own failure path, matters because this method is also reached
        WITHOUT ever calling `start_turn`: `/send`'s route enqueues directly
        (`body.queue`, or an already-busy runner) and calls this method to
        idle-drain, with no `start_turn` attempt — and therefore no
        `add_waiter` — in between. Without registering here too, that
        queued item would have no FIFO entry at all and `_wake_next_waiter`
        could never find it. `add_waiter` is idempotent, so this and a
        prior/later `start_turn`-driven registration for the same
        conversation never produce two FIFO slots. We'll be tried again
        either by our own next natural drain point or by the current
        holder's eventual release calling directly into us via
        `_wake_next_waiter`.

        Concurrency: the not-busy check, the lease peek, and the
        `start_turn` call below have NO `await` between them. `start_turn`
        flips `busy` True the moment it runs — synchronously, before its
        own first internal `await` (it sets `self._current = state` several
        lines before touching anything async) — and asyncio is
        single-threaded, so no other coroutine can run between this
        method's checks and that flip. A gapless check-then-start here can
        therefore never let two concurrent drains double-pop the same queue
        entry, and can never let a third party grab the lease in the
        instant between this method's peek and `start_turn`'s own (real,
        mutating) acquire.

        `start_turn` CAN still raise after the `popleft()` below. NOT via
        its own `WireRunnerError("not_started"/"busy", ...)` checks — those
        are actually UNREACHABLE from here: no `await` sits between this
        method's own alive/busy gate just above and `start_turn`'s
        identical checks, so nothing can flip `alive`/`busy` in the gap
        (same single-threaded argument as the concurrency note above). The
        REALISTIC failure is a raw `OSError` (`BrokenPipeError` /
        `ConnectionResetError`) out of `_send`'s `proc.stdin.drain()`: the
        subprocess can die in the gap between this method's alive-check and
        `start_turn`'s actual pipe write, and `start_turn`'s own `except
        Exception: state.status = "failed"; ...; raise` (wire_runner.py)
        re-raises whatever it caught UNCHANGED — never wrapped into a
        `WireRunnerError`. `except WireRunnerError` alone does NOT catch an
        `OSError`, so it would leave both hazards live in exactly the
        realistic case. Left unguarded, that would both strand the popped
        item (gone from `self._queue`, never actually started) and
        propagate the raw exception out of this method — which matters
        because this is called from TWO places: `_consume`'s `finally`
        (fire-and-forget; an unhandled exception there just leaks as an
        unretrieved task exception) and `/send`'s idle-drain path in
        routes_coder.py (a live request context with no surrounding
        try/except and no generic exception handler registered — an
        unhandled exception there becomes an opaque 500 instead of the
        sibling `{"error":{"code","message"}}` envelope every other failure
        here uses). Guarding HERE, once, fixes both call sites identically:
        put the item back at the head of the queue (so it retries on the
        next drain — turn-end, or a later idle `/send` — instead of
        vanishing) and swallow the error after logging, so neither caller
        ever sees an exception propagate out of this method. Never retries
        inline (no loop) — the next natural drain (turn-end, or a later
        idle `/send`) picks it up.

        Catches `Exception` broadly rather than enumerating
        `WireRunnerError`/`OSError`/etc. individually: this hook's contract
        is "never crash the turn-end / idle-drain path", and a best-effort
        fire-and-forget drain that only guards against today's known
        failure modes would silently regress the instant `start_turn`
        grows a new one. `Exception` still excludes `asyncio.CancelledError`
        (a `BaseException` subclass, not `Exception`, since Python 3.8) —
        deliberately: genuine task cancellation must propagate, not be
        swallowed. But the popped item must not be LOST to a cancellation
        either (review Critical 2's second half) — re-queuing is therefore
        ownership-based (`finally`, mirroring `start_turn`'s own fix)
        rather than gated on catching `Exception`: whether `start_turn`
        raises an `Exception`, is cancelled, or anything else, the item
        goes back on the queue unless it actually started.
        """
        if not self._queue or not self.alive or self.busy:
            return
        lease = lease_for(self._cwd)
        holder = lease.holder_of()
        if (
            holder is not None
            and holder != self.conversation_id
            and lease.held_seconds() <= lease.stale_after_seconds
        ):
            lease.add_waiter(self.conversation_id)
            return
        item = self._queue.popleft()
        started = False
        try:
            await self.start_turn(item["input"], send_id=item["sendId"])
            started = True
        except Exception as exc:
            logger.warning(
                "coder queue drain failed for conversation {} (sendId={}): {}: {}",
                self.conversation_id,
                item["sendId"],
                type(exc).__name__,
                exc,
            )
        finally:
            if not started:
                self._queue.appendleft(item)

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

    def _journal_entry(self, state: TurnState) -> dict[str, Any]:
        """Instance method (P5 Task 2 — was a `@staticmethod`): merges this
        turn's checkpoint SHAs/summary from the `_checkpoints` side-map, when
        present. `_checkpoints` is populated only by `_checkpoint_pre`
        (called from `start_turn`) — an ArchitectRunner (or a bare WireRunner)
        never touches it, so its journal entries (if it ever grew a durable
        journal) would never carry these keys at all."""
        entry: dict[str, Any] = {
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
        checkpoints = self._checkpoints.get(state.turn_id)
        if checkpoints is not None:
            entry["checkpointPre"] = checkpoints.get("pre")
            entry["checkpointPost"] = checkpoints.get("post")
            entry["checkpointSummary"] = checkpoints.get("summary")
        return entry

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
            # Checkpoint continuity across a restart (P5 Task 2): only a
            # turn journaled with checkpoint code already ran carries these
            # keys at all — an entry from before this feature shipped (or
            # an ArchitectRunner-shaped entry, hypothetically) simply lacks
            # them, and `_checkpoints` stays untouched for it, matching
            # `_journal_entry`'s own "absent unless populated" contract.
            if "checkpointPre" in entry or "checkpointPost" in entry:
                pre = entry.get("checkpointPre")
                post = entry.get("checkpointPost")
                summary = entry.get("checkpointSummary")
                self._checkpoints[turn_id] = {
                    "pre": pre if isinstance(pre, str) else None,
                    "post": post if isinstance(post, str) else None,
                    "summary": summary if isinstance(summary, dict) else None,
                }
                chained = self._checkpoints[turn_id]["post"] or self._checkpoints[turn_id]["pre"]
                if chained is not None:
                    self._last_checkpoint_sha = chained
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

    def _is_idempotent_start_turn_passthrough(self, send_id: str | None) -> bool:
        """Mirrors (read-only, never mutates) `WireRunner.start_turn`'s own
        idempotent-resend detection, so `start_turn` below can decide
        whether to touch the write-lease at all BEFORE delegating. Two
        cases where the base returns an EXISTING `TurnState` instead of
        starting a genuinely new one:

        - the running turn's own `send_id` matches (a resend of the
          in-flight message) — we already hold the lease from when THAT
          turn started, so this call must not attempt a fresh acquire;
        - the LAST TURN's `send_id` matches, and it already finished — the
          lease for that turn was already released at ITS turn-end, so this
          call must NOT attempt to (re)acquire on a resend's behalf: doing
          so would grab a lease no new turn will ever run to release, AND
          would wrongly fail an idempotent resend with `lease_unavailable`
          whenever some other conversation happens to hold the lease right
          now — the resend's contract is to return the old turn regardless
          of current lease ownership, since nothing new is being started.
        """
        # Truthiness, not `is None` (P6a review Critical 1): the base
        # guards both its own checks on `if send_id and ...` — `""` is
        # falsy there, so an empty-string send_id NEVER matches an
        # idempotent resend in the base's eyes, it's always a genuinely new
        # turn attempt. A `send_id is None` check here disagreed for
        # `send_id == ""`: `SendBody.sendId` has no `min_length`, so `""`
        # arrives straight from HTTP, and a caller resending with `""` (or
        # simply never setting sendId) could hit an old `last.send_id ==
        # ""` and have THIS method wrongly call it "idempotent", skipping
        # the acquire entirely while the base went on to start a genuinely
        # new turn — a real second writer with the lease never touched.
        if not send_id:
            return False
        cur = self._current
        if cur is not None and cur.status == "running":
            return cur.send_id == send_id
        if self._turn_order:
            last = self._turns[self._turn_order[-1]]
            return last.send_id == send_id
        return False

    async def start_turn(self, user_input: str, send_id: str | None = None) -> TurnState:
        """Write-lease (P6a): one workspace, one mutating turn at a time.

        Acquired HERE, before delegating to `super().start_turn(...)` —
        `try_acquire` is await-free (see workspace_lease.py) and this is the
        last synchronous statement before `WireRunner.start_turn`'s own
        equally-gapless `self._current = state` busy-flip, so nothing can
        ever run between "we got the lease" and "the turn looks busy".

        Skips the acquire attempt entirely for an idempotent pass-through
        (see `_is_idempotent_start_turn_passthrough`) — those calls start no
        new turn, so they must neither need nor attempt to touch the lease.
        Otherwise: if we don't already hold it (re-entrant — a call landing
        while OUR OWN turn is still running, which only reaches here to hit
        the base class's own "busy" rejection) and can't acquire it fresh,
        the turn does NOT start — the caller (Task 3's `/send` route) is
        expected to catch this and queue instead of starting. `add_waiter`
        registers us in the lease's FIFO so a later release can hand off
        directly to us (see `_wake_next_waiter`) even though our own
        turn-end will never fire to trigger a self-drain.

        If we DID acquire fresh here, release ownership is decided in the
        `finally` below by OWNERSHIP, not by exception class (P6a review
        Critical 2): a plain `except Exception: release(); raise` misses
        `asyncio.CancelledError` (a `BaseException`, not an `Exception`,
        since Python 3.8) — and cancellation lands here for real: the
        cross-runner handoff (`_wake_next_waiter`) runs a WOKEN
        conversation's `start_turn` from inside the RELEASING conversation's
        own consumer task (shielded — see `_wake_next_waiter` — but that's
        belt, this is suspenders), and a client disconnect can cancel a
        plain `/send` request's task mid-`await` too (a well-known
        ASGI/Starlette gotcha). Either can deliver `CancelledError` at
        ANY await point up to and including mid-`_before_prompt_sent` —
        BEFORE `self._consumer` is ever created for this attempt — which is
        exactly the case a bare `except Exception` can't see: nothing would
        ever call `_consume`'s `finally` to release what we just grabbed,
        AND the turn would look permanently `busy` with no consumer to end
        it. `finally` runs regardless of exception type (or none at all),
        so checking OWNERSHIP there — "did a live consumer task actually
        get created for THIS attempt, backing a still-open state" — instead
        of "did something raise" closes that gap without needing to
        enumerate every exception type that can land here (today's or a
        future one).
        """
        lease = lease_for(self._cwd)
        already_held = lease.is_held_by(self.conversation_id)
        acquired_fresh = False
        if not already_held and not self._is_idempotent_start_turn_passthrough(send_id):
            if not lease.try_acquire(self.conversation_id):
                lease.add_waiter(self.conversation_id)
                holder = lease.holder_of()
                raise WireRunnerError(
                    "lease_unavailable",
                    f"workspace write-lease is held by conversation {holder}",
                    holder=holder,
                )
            acquired_fresh = True
        # Captured BEFORE delegating so the `finally` below can tell whether
        # THIS call is the one that actually created a live consumer task —
        # `self._consumer` is only reassigned once `super().start_turn()`
        # gets past `_before_prompt_sent` AND the prompt send succeeds, so a
        # failure/cancellation any earlier than that leaves it unchanged.
        prior_consumer = self._consumer
        state: TurnState | None = None
        try:
            state = await super().start_turn(user_input, send_id)
        finally:
            if acquired_fresh:
                consumer_created_for_this_attempt = self._consumer is not prior_consumer
                live_turn_now_owns_release = (
                    consumer_created_for_this_attempt and state is not None and not state.closed
                )
                if not live_turn_now_owns_release:
                    # Nothing will ever call `_consume`'s `finally` on our
                    # behalf — whether because `super().start_turn()`
                    # raised/was cancelled before creating a consumer, or
                    # (defensive) returned an already-closed state without
                    # raising at all.
                    released = lease.release(self.conversation_id)
                    if released:
                        # Hand off, exactly as every OTHER release site does.
                        # Without this, a conversation queued behind a turn
                        # whose `start_turn` FAILED (a dead child, or a
                        # cancellation during the pre-turn git checkpoint)
                        # sits with a queued item and a FIFO slot but no
                        # turn-end of its own to trigger a drain — stranded
                        # until the user happens to send again. That is the
                        # same stranding class the revert-release handoff
                        # closes; this was the one release site of four that
                        # still didn't hand off.
                        #
                        # Shielded inside `wake_workspace_waiters`, so a
                        # cancellation that brought us here does not also
                        # kill the woken runner's start-up. Terminates: each
                        # pass pops from a finite FIFO.
                        await wake_workspace_waiters(self._cwd, source=self.conversation_id)
        # Reachable only when `super().start_turn()` returned normally (any
        # exception/cancellation propagates past the `finally` above instead
        # of falling through here) — `state` is therefore always set; the
        # assert just narrows the type for the checker.
        assert state is not None
        if self._journal is not None:
            self._journal_note_turn(state)
            # Retention: beyond `turns_keep`, drop the oldest turn files —
            # done at turn start (not on every append) since that's the only
            # point a conversation's turn count can grow.
            self._journal.prune([e["turnId"] for e in self._journal_index])
        return state

    async def _before_prompt_sent(self, state: TurnState) -> None:
        """`WireRunner.start_turn`'s hook — fired once the turn exists but
        before its prompt is sent and before it's registered/discoverable
        anywhere (see the call site's comment there). The ONE race-free
        moment for a PRE checkpoint: nothing has told the agent to do
        anything yet, so nothing could possibly have mutated the workspace,
        and no client could possibly be interacting with a turn it can't
        see yet."""
        await self._checkpoint_pre(state)

    async def _checkpoint_pre(self, state: TurnState) -> None:
        """Snapshot the workspace tree as it stands the instant this turn's
        prompt was accepted, chained onto `_last_checkpoint_sha` (the
        previous turn's post-or-pre) so the checkpoint history reads as one
        continuous line per conversation. Best-effort by design (P5 brief):
        checkpoints are a safety net, never a gate — a missing repo, a git
        failure, anything at all, is caught, logged, and leaves
        `checkpointPre` null; the turn itself is entirely unaffected. A no-op
        if this state already has a `_checkpoints` entry (defense in depth —
        `_before_prompt_sent` only ever runs once per turn in practice, since
        `start_turn`'s idempotent-resend path returns before ever reaching
        it, but re-checkpointing here would both misrepresent the tree at
        THIS instant as "pre-turn" and double-chain `_last_checkpoint_sha`)."""
        if state.turn_id in self._checkpoints:
            return
        entry: dict[str, Any] = {"pre": None, "post": None, "summary": None}
        self._checkpoints[state.turn_id] = entry
        try:
            ref = _checkpoint_ref(self.conversation_id, state.turn_id, "pre")
            sha = await self._git.create_checkpoint(
                ref, f"pre-turn snapshot ({state.turn_id})", parent=self._last_checkpoint_sha
            )
        except Exception as exc:  # noqa: BLE001 - best-effort: must never fail the turn
            logger.warning(
                "coder checkpoint (pre) failed for conversation {} turn {}: {}: {}",
                self.conversation_id,
                state.turn_id,
                type(exc).__name__,
                exc,
            )
            return
        # `create_checkpoint` returns None ONLY for skip-when-clean (a real
        # failure raises, and is handled above). Skipped means the tree is
        # BYTE-IDENTICAL to `parent`, so the parent IS this turn's pre-state
        # — recording None instead threw that away, and everything downstream
        # reads a missing `pre` as "this turn has no checkpoint":
        #   * `/diff` (Review)  -> 404 no_checkpoint
        #   * `/revert`         -> 404 no_checkpoint
        #   * the footer summary-> never computed, so the UI rendered a
        #                          confident "0 files changed +0 −0"
        # Nothing changes between one turn's post-checkpoint and the next
        # turn's pre-checkpoint in the normal case, so the skip fired on
        # essentially EVERY turn and P5's diff/revert were inert in
        # production. Fall back to the parent, which is exactly that tree.
        effective_pre = sha if sha is not None else self._last_checkpoint_sha
        entry["pre"] = effective_pre
        if sha is not None:
            self._last_checkpoint_sha = sha
        await self._append(state, {"kind": "checkpoint", "when": "pre", "sha": effective_pre})

    async def _checkpoint_post(self, state: TurnState) -> None:
        """Snapshot the workspace tree once the turn has finished, chained
        onto this SAME turn's pre checkpoint (so a turn's own diff is always
        `pre..post`, regardless of what any other turn did). `None` when the
        tree is unchanged since `pre` (skip-when-clean — a genuine no-op
        turn, not a failure) or when checkpointing hard-failed (same
        best-effort contract as `_checkpoint_pre`). The diff summary
        (files/additions/deletions) is computed only when both ends exist;
        its patch text is discarded — only the counts are kept."""
        entry = self._checkpoints.setdefault(
            state.turn_id, {"pre": None, "post": None, "summary": None}
        )
        pre = entry.get("pre")
        try:
            ref = _checkpoint_ref(self.conversation_id, state.turn_id, "post")
            sha = await self._git.create_checkpoint(
                ref, f"post-turn snapshot ({state.turn_id})", parent=pre
            )
        except Exception as exc:  # noqa: BLE001 - best-effort: must never fail the turn
            logger.warning(
                "coder checkpoint (post) failed for conversation {} turn {}: {}: {}",
                self.conversation_id,
                state.turn_id,
                type(exc).__name__,
                exc,
            )
            return
        entry["post"] = sha
        if sha is not None:
            self._last_checkpoint_sha = sha
        summary: dict[str, Any] | None = None
        if sha is not None and pre is not None:
            try:
                diff = await self._git.checkpoint_diff(
                    pre, sha, max_bytes=_CHECKPOINT_SUMMARY_MAX_BYTES
                )
                summary = {
                    "filesChanged": diff["filesChanged"],
                    "additions": diff["additions"],
                    "deletions": diff["deletions"],
                }
            except Exception as exc:  # noqa: BLE001 - summary is a bonus, never load-bearing
                logger.warning(
                    "coder checkpoint diff summary failed for conversation {} turn {}: {}: {}",
                    self.conversation_id,
                    state.turn_id,
                    type(exc).__name__,
                    exc,
                )
        elif sha is None and pre is not None:
            # Skip-when-clean on the POST side: the turn genuinely changed
            # nothing. Say so EXPLICITLY rather than omitting the summary —
            # the frontend defaults a missing summary to zeroes, so "absent"
            # and "genuinely zero" rendered identically and an unknown state
            # was indistinguishable from a no-op turn.
            summary = {"filesChanged": 0, "additions": 0, "deletions": 0}
        entry["summary"] = summary
        item: dict[str, Any] = {"kind": "checkpoint", "when": "post", "sha": sha}
        if summary is not None:
            item["summary"] = summary
        await self._append(state, item)

    async def _consume(self, state, queue) -> None:  # noqa: ANN001
        try:
            await super()._consume(state, queue)
        finally:
            # Write-lease (P6a review Important 6): the release below is
            # structurally guaranteed by this INNER `try/finally`, not
            # merely by "the bookkeeping never raises" contracts documented
            # in three other files (`_cancel_pending`/`_checkpoint_post`
            # /journal/`prune_checkpoints`) — any of those is one future
            # edit away from breaking that assumption silently. Whatever
            # happens above, the release always runs.
            try:
                await self._cancel_pending("turn_ended", state)
                # Post-turn checkpoint (P5 Task 2) BEFORE the journal is
                # noted so `checkpointPost`/`checkpointSummary` land in the
                # SAME `turns.json` write as everything else this turn's
                # end updates.
                await self._checkpoint_post(state)
                if self._journal is not None:
                    self._journal_note_turn(state)
                    # Not per-item (EFS latency) — one fsync when the turn closes.
                    self._journal.fsync_turn(state.turn_id)
                    # Retention (P5 Task 2): checkpoint refs are pruned in
                    # lockstep with the durable journal's own kept-turns set —
                    # `_journal_index` already reflects this turn's own entry
                    # (noted just above), so it's never pruned out from under
                    # itself.
                    try:
                        await self._git.prune_checkpoints(
                            self.conversation_id, [e["turnId"] for e in self._journal_index]
                        )
                    except Exception as exc:  # noqa: BLE001 - best-effort: pruning must never fail the turn
                        logger.warning(
                            "coder checkpoint prune failed for conversation {}: {}: {}",
                            self.conversation_id,
                            type(exc).__name__,
                            exc,
                        )
            finally:
                # Release AFTER all the turn-end bookkeeping above —
                # checkpoint_post, journal note, fsync, prune — so those can
                # never race a newly-started turn that grabs the lease the
                # instant it frees. This inner `finally` runs on EVERY
                # terminal path (finished/failed/cancelled — `_consume`'s
                # own status handling above covers those — and
                # interrupted-by-cancellation too: a `CancelledError` from
                # `stop()`'s `self._consumer.cancel()` still unwinds through
                # this `finally`, Python guarantees that) AND even if the
                # bookkeeping above somehow raised despite its own
                # "never fails the turn" contracts. `release` is idempotent
                # (only actually releases for the CURRENT holder), so it's
                # harmless if `start_turn` itself already released on a
                # failure that never got this far.
                lease_for(self._cwd).release(self.conversation_id)
            # Turn-end boundary (P4b): drain the next queued follow-up, if
            # any — AFTER the bookkeeping above so a queued turn's own
            # journal/fsync never races the one just closing out. This may
            # immediately RE-acquire the lease for OUR OWN next queued item
            # (self always drains before any other waiter — see
            # `_wake_next_waiter`'s docstring for why that's safe and why it
            # can't race).
            await self._maybe_drain_queue()
            # Cross-runner handoff (P6a — the crux): if our own drain above
            # didn't reclaim the lease, wake the next conversation queued at
            # it, if any.
            await self._wake_next_waiter()

    async def _wake_next_waiter(self) -> None:
        """Cross-runner handoff (P6a): if the write-lease is free right now
        (nobody — including our OWN queue, via `_maybe_drain_queue` just
        before this is called — has reclaimed it) and another conversation
        is queued at it, invoke THAT runner's `_maybe_drain_queue` directly.

        Why this exists at all: `_maybe_drain_queue` only ever runs on its
        OWN runner's turn-end (or `/send`'s idle-drain path). A conversation
        B that queued while conversation A held the lease never has a
        turn-end of its own to trigger it — without this, B waits forever
        the instant A's turn ends. This is the one call site that closes
        that gap, by reaching into the OTHER runner via the `_conversations`
        registry and calling its drain hook directly.

        Loops rather than popping once (P6a review Critical 3): a popped
        waiter can DECLINE without ever holding the lease — a ghost
        (dropped/stopped since it queued: `get_conversation` returns `None`)
        or one whose own `_maybe_drain_queue` finds an empty queue right
        now. Stopping after one pop in either case would strand every
        waiter BEHIND the declining one forever, since nothing else will
        ever call `_wake_next_waiter` again once the lease is free and
        nobody is separately releasing it. So: keep popping and trying
        until either the lease is actually taken (`holder_of()` becomes
        non-`None` — including by ourselves, transitively, if a woken
        runner's drain starts a turn) or the FIFO is empty. Bounded by the
        FIFO's length at any instant — each iteration permanently removes
        one entry via `pop_waiter()`, and a declining waiter can never be
        re-queued into the SAME lease-freeing pass. `stop()` additionally
        `remove_waiter`s a conversation from the FIFO the moment it's
        dropped, so a ghost is at worst a rare, already-shrinking
        population, never a growing one.

        No lost wake-up / no double-pop: called right after this
        conversation's OWN release + self-drain attempt, with no `await` in
        between `lease.release()` (in `_consume`'s `finally`, just above)
        and here other than `_maybe_drain_queue`'s own synchronous-until-a-
        real-await prefix — so nothing else can have grabbed the lease
        in between. Each loop iteration's `pop_waiter()` removes AT MOST one
        conversation from the FIFO, so this cannot double-pop; the woken
        runner's `_maybe_drain_queue` re-checks the lease itself (the same
        read-only peek every caller uses) before touching anything, so even
        a hypothetical race resolves safely — it just leaves the item
        queued for the next opportunity instead of starting incorrectly.

        Shielded (P6a review Critical 2b): `asyncio.shield` decouples the
        WOKEN runner's `start_turn` from OUR OWN task's cancellation scope.
        Without it, this call runs the woken runner's turn start as a
        literal continuation of OUR coroutine's call stack — so if this
        conversation is `stop()`-ped WHILE that woken turn is still deep in
        `_before_prompt_sent` (P5's git checkpoint — real seconds against a
        real repo), the `CancelledError` delivered to OUR task lands INSIDE
        the woken runner's code before its own consumer task even exists to
        one day release the lease on its behalf. `shield` lets our own
        `await` be cancelled (propagating normally, as `stop()` intends)
        while the woken runner's work keeps running independently to
        completion in the background — its own eventual `_consume`
        `finally` (or `start_turn`'s ownership-based release, if it fails)
        still runs, on its own schedule, unaffected by what happens to us.

        No unbounded recursion/ping-pong: this method does not call itself.
        Each loop iteration calls `_maybe_drain_queue()` on ONE other
        runner, which — being `_maybe_drain_queue`, not `_wake_next_waiter`
        — never chains into a FURTHER handoff itself. The NEXT hop in a
        FIFO chain of several waiters only happens later, from THAT
        runner's own eventual turn-end (its own `_consume` finally, calling
        ITS `_wake_next_waiter` once ITS turn is actually done) — so
        several queued conversations still drain in full, one real turn at
        a time, never all at once from a single release.

        Best-effort and exception-swallowing on purpose: a bug in some
        OTHER conversation's drain must never break OUR OWN turn-end
        teardown (this runs from `_consume`'s `finally` and from `stop()`).
        `Exception` only, same as `_maybe_drain_queue` — a `CancelledError`
        delivered to OUR OWN task (e.g. at the `shield`ed await, per
        `stop()`'s own cancellation) must still propagate, not be
        swallowed.
        """
        await wake_workspace_waiters(self._cwd, source=self.conversation_id)

    async def stop(self) -> None:
        await super().stop()
        state = self._current
        if state is not None:
            await self._cancel_pending("runner_stopped", state)
        else:
            self._pending_requests.clear()
        lease = lease_for(self._cwd)
        # Write-lease (P6a review Critical 3): a stopped/dropped conversation
        # must leave the FIFO too, not just release the lease if it happened
        # to hold it — `drop_conversation` (and `routes_coder.py`'s
        # `_recycling_stream`, which calls it on a failed/dead stream) both
        # route through here, and a waiter left registered after its runner
        # is gone is a ghost `_wake_next_waiter` can only skip over, never
        # actually wake. `remove_waiter` is a no-op if we were never queued.
        lease.remove_waiter(self.conversation_id)
        # Defensive, belt-and-suspenders release for a dropped/stopped
        # runner. In the common case this is a no-op — `stop()`'s
        # `super().stop()` cancels an active `_consumer`, whose
        # `CancelledError` unwinds through `_consume`'s `finally` (above)
        # and already released it — `release()` returning False here proves
        # that. This exists for the cases that path doesn't cover: no
        # `_consumer` was ever running (e.g. stopped between acquiring and
        # the consumer task existing) but the lease is somehow still ours.
        # A runner that's stopped can never release its own lease any other
        # way, so skipping this would let a dropped runner strand the
        # workspace — the single biggest risk this task calls out.
        if lease.release(self.conversation_id):
            await self._wake_next_waiter()

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


async def wake_workspace_waiters(root: Path, *, source: str | None = None) -> None:
    """Hand the now-free workspace write-lease to the next FIFO waiter.

    Module-level on purpose: BOTH release sites must hand off — a turn's
    turn-end (`CoderRunner._consume`) and a REVERT's release (the routes
    layer). Revert is a lease holder that is not a conversation and so has
    no turn-end of its own; without this, a conversation that queued behind
    a revert (202 + a waiter slot) would sit stranded until the user sent
    again, silently breaking the queue-at-the-lease contract for the one
    new holder this phase introduced. One implementation, two callers.

    Loops rather than popping once: a declining waiter (dropped, stopped,
    or with an empty queue) must not consume the wake-up and strand
    everyone behind it. Terminates because a re-queue can only follow an
    observed non-None holder, which the next iteration's own check then
    sees — not because re-queuing is impossible (the `shield` below yields
    to the loop before the woken drain runs, so a third conversation can
    take the lease in that gap).

    Best-effort: an exception in some OTHER conversation's drain must never
    break the caller's teardown. `Exception` only — a `CancelledError`
    delivered to OUR task must still propagate.
    """
    lease = lease_for(root)
    while True:
        if lease.holder_of() is not None:
            return
        next_holder = lease.pop_waiter()
        if next_holder is None:
            return
        waiter = get_conversation(root, next_holder)
        if waiter is None:
            continue  # ghost waiter — dropped/stopped since it queued
        try:
            # `shield` so the woken runner's work is not cancelled along
            # with whatever task happens to be doing the handing off.
            await asyncio.shield(waiter._maybe_drain_queue())  # noqa: SLF001
        except Exception as exc:  # noqa: BLE001 - best-effort: must never break the caller
            logger.warning(
                "coder write-lease handoff from {} to {} failed: {}: {}",
                source or "<revert>",
                next_holder,
                type(exc).__name__,
                exc,
            )


def list_conversations(root: Path) -> list[CoderRunner]:
    prefix = f"{root}::"
    return [r for k, r in _conversations.items() if k.startswith(prefix)]


async def shutdown_conversations() -> None:
    runners = list(_conversations.values())
    _conversations.clear()
    for runner in runners:
        await runner.stop()
