# Coder Panel P4 — Steering + Server-Side Queue + Plan Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coder panel three things the CLI already half-supports: (1) **mid-turn steering** — redirect a running turn without cancel/restart; (2) a **server-side per-conversation message queue** replacing the client-side outbox so a queued follow-up drains even with the tab closed; (3) a **plan card** — surface the plan-mode markdown the panel currently drops on the floor, merged with the already-working approve/refine QuestionCard.

**Architecture:** Steering and plan mode need almost no new plumbing — the CLI wire layer fully supports `steer` (soul injects the follow-up at the next step boundary) and `ExitPlanMode` already emits `PlanDisplay` (markdown) + a bridged `QuestionRequest` (approve/reject/reject-exit/revise). P4 adds: a `CoderRunner.steer()` over the existing `WireRunner.call`; a `/steer` route + proxy + `steerCoder` client; a per-conversation `deque` on `CoderRunner` drained by an **overridable hook** off `_consume`'s turn-end `finally` (kept overridable so P6's cross-conversation write-lease can interpose); `send {queue?}` + `DELETE /queue/{sendId}` + queue in `/turn`; and a frontend `PlanDisplay` reducer branch + composer steer-now/queue split + QueueStrip that retire the client outbox. **The queue is RAM-only** (lost on crash, re-typable — matching the client outbox's existing ephemeral optimism; durable queue is deferred).

**Tech Stack:** Python 3.14 / FastAPI / asyncio (terminal-server: `uv run pytest tests/ -q`, ~16s). TypeScript / Next.js / React (sanad-web: `pnpm test` + `pnpm exec tsc --noEmit`). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` §Steer/queue, §Plan card. Work happens in worktree `coder-panel-p4` (off current main; P0–P3 merged).

## Global Constraints

- **Work entirely in the worktree** `/private/tmp/claude-501/-Users-omar-Development-sammad-cli/661013be-a3ee-44fa-9e27-12151f0aa867/scratchpad/coder-panel-p4` (branch `coder-panel-p4`). Read/edit/test/commit THERE. The main checkout at /Users/omar/Development/sammad-cli is a different branch with Omar's dirty files — do NOT touch it. SDD briefs/reports go to the main-checkout shared `.superpowers/sdd/...` path (the scripts resolve there) — read/write reports there, code in the worktree.
- **Commits are Omar-only** — `sanad: <description>`; NEVER any AI attribution. Before EVERY commit: `git branch --show-current` (in the worktree) must print `coder-panel-p4` — else STOP/BLOCKED. If `git` fails exit 69, prefix `PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH`.
- **Never `git add -A`** — the worktree is clean; stage only the files each task names.
- **Steer is only valid mid-turn** — `_handle_steer` on the CLI rejects when no turn is streaming (INVALID_STATE). The composer must route input to `/steer` only while a turn runs, and to `/send` (or the queue) when idle.
- **The queue is per-conversation and RAM-only** (on `CoderRunner`). The drain hook MUST be a single overridable method (e.g. `_maybe_drain_queue`) called from `_consume`'s `finally`, NOT inlined — P6's write-lease interposes there. Leave room in the journaled queue item for a future `reason` (e.g. `waiting_for_lease`) so P6 needs no schema change.
- **Plan card is a rendering upgrade, not new plumbing** — the approve/refine round-trip already works via the bridged `QuestionRequest`; P4 only renders the dropped `PlanDisplay` markdown and merges it visually with the correlated question card. Do NOT re-implement plan approval.
- **Fast-suite discipline:** terminal-server `uv run pytest tests/ -q` + `ruff`/`pyright` on changed files; sanad-web `pnpm test` + `pnpm exec tsc --noEmit`. Do NOT run kimi `tests/e2e` or the full kimi suite.
- terminal-server commands from `<worktree>/terminal-server`; sanad-web from `<worktree>/control-plane/artifacts/sanad-web`.

## Verified facts (grounding)

- Wire `steer`: `JSONRPCSteerMessage` (jsonrpc.py) params `{user_input}`; `_handle_steer` (wire/server.py) requires `_is_streaming`, calls `soul.steer()`, returns `{"status":"steered"}`; soul injects at the next step boundary and emits a `SteerInput` event `{"type":"SteerInput","payload":{"user_input":...}}`. `WireRunner.call(method, params, timeout=10.0)` is the generic JSON-RPC round-trip (used by `set_permission_mode`) — steer returns an id-keyed success, routed to the pending future.
- `ExitPlanMode` (kimi tools/plan/__init__.py): `wire_send(PlanDisplay(content=<markdown>, file_path=...))` THEN a `QuestionRequest` (header "Plan", "Approve this plan", options Approve/Reject/"Reject and Exit", `other_label="Revise"`), then blocks on the answer. `PlanDisplay` type (wire/types.py): `{content: str, file_path: str}`. This QuestionRequest is ALREADY bridged (`CoderRunner.on_request` → journaled `request`/`request_resolved`, rendered by `RequestCards.QuestionCard`, resolved via `/respond`). `PlanDisplay` is journaled as an `event` but `transcript.ts reduce()` has NO branch for it → dropped.
- Client outbox lives in `CoderPanel.tsx`: `outbox` state, `submit` enqueues, a drain effect runs `runTurn` when `phase==="ready"`, 409 busy re-queues at front, editable/removable queued bubbles (`editingQueued`/`commitQueuedEdit`/`removeQueued`).
- `start_turn` busy: refuses a 2nd running turn with `WireRunnerError("busy")`; `send_id` idempotent. `/send` returns 409 `busy` with turnId. Drain hook = `CoderRunner._consume` `finally` (after `super()._consume` sets terminal status + clears `_turn_queue`, so the runner is un-busy).
- Routes (`/internal/coder`): conversations GET/POST, `{cid}/` open/send/respond/turn/mode/follow/cancel/stop. `SendBody{input, sendId?}`. `_recycling_stream` drops the runner on a non-terminal end (excludes finished/cancelled/interrupted). Proxies at `app/api/coder/conversations/[cid]/{...}/route.ts`. `lib/coder/client.ts`: `sendCoder/followCoder/fetchCoderTurn/respondCoder/setCoderMode/cancelCoder/stopCoder`.
- Fake wire `_fake_coder_wire.py` modes: HANG / STEPHANG:n / ASK_APPROVAL / ASK_TOOLCALL / ASK_QUESTION + `set_permission_mode`. No `steer` branch, no PLAN mode.

---

### Task 1: Steering — runner method + `/steer` route + proxy + client

**Files:**
- Modify: `terminal-server/src/sanad_terminal/coder_runner.py` (`steer` method), `terminal-server/src/sanad_terminal/routes_coder.py` (`POST /steer`), `terminal-server/tests/_fake_coder_wire.py` (steer branch), `terminal-server/tests/test_routes_coder.py`, `terminal-server/tests/test_wire_runner.py`
- Create: `control-plane/artifacts/sanad-web/app/api/coder/conversations/[cid]/steer/route.ts`
- Modify: `control-plane/artifacts/sanad-web/lib/coder/client.ts` (`steerCoder`), `control-plane/artifacts/sanad-web/tests/unit/coder-client.test.ts`

**Interfaces:**
- `CoderRunner.steer(text: str) -> None`: `if not self.alive or not self.busy: raise WireRunnerError("no_turn", "no turn is in progress")`; else `await self.call("steer", {"user_input": text})`. (`busy` is the existing `WireRunner.busy` = a running turn exists.) The `SteerInput` event flows back through the normal event stream → journaled → follow replays it (Task 3 renders it; here it just must not break).
- Route `POST /internal/coder/conversations/{cid}/steer` body `{input: str}` → 200 `{"ok": true}`; 409 `no_turn` (no runner / not busy); 400 `invalid_conversation` (via `_bad_cid`). Mirror `/cancel`'s shape (look up runner, call, return) + a body (`SteerBody{input: str Field(min_length=1, max_length=32_000)}`).
- Proxy `app/api/coder/conversations/[cid]/steer/route.ts`: body-forwarding POST mirroring `respond/route.ts` (auth `authenticateCoderPanel`, session passthrough, `workspaceFetch` → `/internal/coder/conversations/${cid}/steer`, `relayJson`).
- `steerCoder(cid: string, input: string, sessionId?: string): Promise<{ok: boolean; code?: string; message?: string}>` — modeled on `respondCoder` (POST JSON `{input}`, parse `{ok}`/error envelope).
- Fake wire: add a top-level `steer` method branch — reply `{"jsonrpc":"2.0","id":<id>,"result":{"status":"steered"}}` AND emit a `SteerInput` event `{"type":"SteerInput","payload":{"user_input":<input>}}` so tests can assert the round-trip. Add a `STEERABLE` prompt mode: a turn that stays open (like HANG) until it receives a steer, then emits SteerInput and finishes — so a route test can start a turn, steer it, and see the SteerInput in the stream.

- [ ] **Step 1: Failing tests** — `test_wire_runner.py`: `runner.steer("go left")` while a turn runs → the fake emits `SteerInput`; steering with no turn raises `WireRunnerError("no_turn")`. `test_routes_coder.py`: `POST /steer` while a turn streams → 200 and a subsequent `/follow` shows the `SteerInput` event; `/steer` with no live turn → 409 `no_turn`; bad cid → 400. `coder-client.test.ts`: `steerCoder` POSTs to `/api/coder/conversations/<cid>/steer` with `{input}`, maps `{ok}`/409.
- [ ] **Step 2: RED** — `cd <worktree>/terminal-server && uv run pytest tests/test_wire_runner.py tests/test_routes_coder.py -q`; sanad-web `pnpm test tests/unit/coder-client.test.ts`.
- [ ] **Step 3: Implement** the fake-wire steer branch + STEERABLE mode, `CoderRunner.steer`, the `/steer` route + `SteerBody`, the proxy route, `steerCoder`.
- [ ] **Step 4: GREEN** — terminal-server `uv run pytest tests/ -q`; sanad-web `pnpm test && pnpm exec tsc --noEmit`. ruff + pyright on changed py files.
- [ ] **Step 5: Commit** — stage the 5 terminal-server files + 2 web files; message `sanad: coder steering — /steer route + runner.steer + steerCoder client`.

---

### Task 2: Server-side per-conversation queue

**Files:**
- Modify: `terminal-server/src/sanad_terminal/coder_runner.py` (deque + overridable drain hook + queue accessors), `terminal-server/src/sanad_terminal/routes_coder.py` (`SendBody.queue?`, drain-on-enqueue vs busy, `DELETE /queue/{sendId}`, queue in `/turn`), `terminal-server/tests/test_wire_runner.py`, `terminal-server/tests/test_routes_coder.py`
- Create: `control-plane/artifacts/sanad-web/app/api/coder/conversations/[cid]/queue/[sendId]/route.ts` (DELETE)
- Modify: `control-plane/artifacts/sanad-web/lib/coder/client.ts` (`queueCoder`, `dequeueCoder`, `fetchCoderTurn` surfaces `queue`), `control-plane/artifacts/sanad-web/lib/coder/types.ts` (`CoderTurnState.queue?`), `control-plane/artifacts/sanad-web/tests/unit/coder-client.test.ts`

**Interfaces:**
- `CoderRunner`: `self._queue: collections.deque[dict] = deque()` where each item is `{"sendId": str, "input": str}` (RAM-only). Methods:
  - `enqueue(send_id: str, input: str) -> int` — append (idempotent on send_id: if already queued or the running/last turn's send_id matches, no-op), return queue length (position). Journal a `{"kind":"queued","sendId":...,"input":...}` item into the CURRENT turn's journal (so followers see queue depth) — reuse the `_append_sync`/sink; leave room for a future `"reason"` key.
  - `dequeue(send_id: str) -> bool` — remove by send_id if present (and not yet started); return removed.
  - `queue_summary() -> list[dict]` — `[{"sendId","input"}]` for `/turn`.
  - `async def _maybe_drain_queue(self) -> None` — **overridable hook** (P6 interposes the write-lease here): if `self._queue` and the runner is alive and not busy, pop the head and `await self.start_turn(input, send_id)` for it (journal a `{"kind":"queue_drained","sendId":...}` marker or rely on the new turn's opening item). Call it from `_consume`'s `finally` AFTER the existing turn-end bookkeeping.
- `routes_coder.py`:
  - `SendBody` gains `queue: bool = False`. In `/send`, when `queue is True` OR the runner is busy: `runner.enqueue(sendId, input)` → 202 `{"ok": true, "queued": true, "position": <n>}` (do NOT stream). When not queued and not busy: today's start-turn-and-stream. (This replaces the 409-busy-then-client-requeue dance — a busy send now auto-queues.)
  - `DELETE /conversations/{cid}/queue/{sendId}` → `runner.dequeue(sendId)` → 200 `{"ok": true, "removed": bool}`; 409 `not_started` if no runner; 400 bad cid.
  - `/turn` response gains `"queue": runner.queue_summary()` (`[]` when runner None).
- Proxy `app/api/coder/conversations/[cid]/queue/[sendId]/route.ts`: DELETE mirroring the proxy pattern → `DELETE /internal/coder/conversations/${cid}/queue/${sendId}`.
- `lib/coder/client.ts`: `queueCoder(cid, input, sendId, sessionId?)` → POST `/send` with `{input, sendId, queue:true}`, returns `{ok, queued?, position?, code?}`; `dequeueCoder(cid, sendId, sessionId?)` → DELETE, returns `{ok, removed?}`; `fetchCoderTurn` surfaces `queue` on `CoderTurnState`.
- `lib/coder/types.ts`: `CoderTurnState.queue?: {sendId: string; input: string}[]`.

- [ ] **Step 1: Failing tests** — `test_wire_runner.py`/`test_routes_coder.py`: enqueue while a turn runs → 202 queued + `/turn` shows it; the queue drains automatically when the running turn ends (the next turn starts from the queued input — assert via follow/turn); `DELETE /queue/{sendId}` removes a queued (un-started) item; enqueue idempotent on sendId; a NEW crash test not needed (RAM-only). `coder-client.test.ts`: `queueCoder`/`dequeueCoder` URL/method/body + `{ok,queued,position}`/`{ok,removed}` mapping; `fetchCoderTurn` surfaces `queue`.
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN + full suites + ruff/pyright/tsc**.
- [ ] **Step 5: Commit** — message `sanad: server-side coder queue — enqueue/drain on turn end, DELETE /queue, /turn queue`.

---

### Task 3: Plan card — render the dropped `PlanDisplay` + merge with the question card

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/coder/types.ts` (PlanDisplay payload type), `lib/coder/transcript.ts` (`reduce()` branch for `PlanDisplay` → a `{kind:"plan"}` CoderBlock; toStored/fromStored lean), `lib/coder/client.ts` (a `planFromEvent` extractor if the reducer needs it), `app/terminal/coder/CoderPanel.tsx` (render the plan block; visually associate it with the ExitPlanMode QuestionCard), and possibly `app/terminal/coder/RequestCards.tsx` (the QuestionCard for a plan question can show a "Plan" affordance)
- Modify: `terminal-server/tests/_fake_coder_wire.py` (a `PLAN` prompt mode: emit `PlanDisplay` then a `QuestionRequest` shaped like ExitPlanMode, wait for the answer), `control-plane/artifacts/sanad-web/tests/unit/coder-transcript.test.ts`

**Interfaces:**
- `lib/coder/types.ts`: `PlanDisplayPayload {content: string; file_path: string}`; the `CoderBlock` union gains `{kind:"plan"; content: string; filePath: string}`.
- `transcript.ts reduce()`: add a branch — `event.type === "PlanDisplay"` → append `{kind:"plan", content: payload.content, filePath: payload.file_path}`. The subsequent `QuestionRequest` (the plan approval) already folds into a `{kind:"request", requestType:"question"}` block via the existing path — the plan block sits just before it in the same turn, so rendering them adjacently gives the merged "PlanCard" experience without correlation plumbing. (Optional nicety: tag the plan block so CoderPanel can render it inside/above the question card.)
- `toStored`/`fromStored`: persist the plan block lean — `{kind:"plan", content: clip(content, <cap>)}` (choose a cap consistent with the other stored caps, e.g. 6000; add `filePath` only if small). If persisting `content` risks the zod caps, persist a truncated summary + a note; keep the schema change optional-and-back-compat (mirror the tool-block lean approach — a NEW optional variant in `coderBlockState` if you persist it, or drop it from persistence entirely and rebuild from journal on reload). PREFER: drop the plan block from `toStored` (rebuild from journal, like tool detail) → NO `coderBlockState` change. State which you chose.
- CoderPanel: render a `{kind:"plan"}` block as a plan card (markdown content — reuse the sanitized-markdown renderer the panel/architect uses; check what CoderPanel already uses for text/markdown). Visually merge with the immediately-following plan QuestionCard (Approve & build / Refine=the "Revise" other-text / Keep planning=Reject). Do NOT reimplement the approval — the QuestionCard already answers it via `/respond`.
- Fake wire `PLAN` mode: on a prompt containing `PLAN`, emit a `PlanDisplay` event, then a `QuestionRequest` (header "Plan", options Approve/Reject, `other_label="Revise"`), then wait for the response and finish. Lets a transcript/e2e test assert the plan block + question card both render.

- [ ] **Step 1: Failing tests** — `coder-transcript.test.ts`: a `PlanDisplay` event folds into a `{kind:"plan"}` block with content+filePath; a full sequence (PlanDisplay → QuestionRequest) yields a plan block followed by a request block; toStored handling (per your persistence choice — if dropped, assert the stored form omits plan; if kept, assert lean + `coderBlockState` still validates). RED.
- [ ] **Step 2: Implement** the type + reducer branch + CoderPanel render + fake-wire PLAN mode. **Step 3: GREEN** — `pnpm test && pnpm exec tsc --noEmit`; terminal-server suite stays green (fake-wire addition).
- [ ] **Step 4: Commit** — message `sanad: coder plan card — render PlanDisplay markdown, merge with approve/refine question`.

---

### Task 4: Composer — steer-now vs queue split + QueueStrip, retire the client outbox

**Files:**
- Modify: `control-plane/artifacts/sanad-web/app/terminal/coder/CoderPanel.tsx` (the big one)
- Possibly Modify: `control-plane/artifacts/sanad-web/lib/sessions/state.ts` (if the client-outbox uiState field is removed — check whether the outbox was persisted; if not, no schema change)

**Interfaces (UI, no exported API):**
- Retire the client-side `outbox` state + its drain effect + 409-busy-requeue dance (Task 2 made a busy send auto-queue server-side). Replace with:
  - **Composer send button behavior**: when a turn is streaming → the primary action is **Steer now** (`steerCoder(cid, input)`); a secondary **Queue** (`queueCoder(cid, input, sendId)`). When idle (`phase==="ready"`) → **Send** (`sendCoder`). Composer never disabled (except `phase==="error"`, as today).
  - **QueueStrip**: render the server queue (from `fetchCoderTurn`'s `queue`, refreshed after enqueue/dequeue and on `/turn` polls) as editable/removable bubbles between the last turn and the composer — reuse the existing queued-bubble interaction design (edit-in-place, Enter commit, ✕ remove) but back it with `queueCoder` (re-enqueue on edit = dequeue old + queue new) / `dequeueCoder`. The server queue is the source of truth.
  - **Steer rendering**: a `SteerInput` event now flows in the stream (from Task 1) — add a `transcript.ts reduce()` branch (or a CoderPanel render) so a steered follow-up renders as a small "steered: <text>" marker row in the running turn (honest, minimal). (If not already covered — grounding: `SteerInput` is currently unrendered.)
  - Optimistic UX: a steer/queue action shows immediately; reconcile against the next `/turn` queue read (server authoritative). On a steer failure (e.g. the turn ended between click and call → `no_turn`), fall back to `sendCoder`/queue.
- Keep the P1b/P3 resilience (re-attach loop, interrupted handling, `lastInterruptedTurnId`) intact — only the outbox/queue path changes.

- [ ] **Step 1: Implement** the composer split, QueueStrip backed by the server queue, SteerInput rendering, and remove the client outbox. Gate: `pnpm exec tsc --noEmit && pnpm test` (green; JSX review-gated; add a pure-logic test only where logic is extractable — e.g. a `SteerInput` reducer branch test).
- [ ] **Step 2: Manual QA note** in the report: with the panel enabled, start a long turn, hit Steer-now with a redirect and confirm the agent picks it up mid-turn; Queue a second message and confirm it drains when the turn ends (incl. with the tab closed → reopen and see it ran); edit/remove a queued item; confirm plan mode shows the plan card + approve/refine.
- [ ] **Step 3: Commit** — message `sanad: coder composer — steer-now vs queue, server-backed QueueStrip, retire client outbox`.

---

## P4 exit criteria (spec traceability)

| Spec P4 item | Where |
|---|---|
| Mid-turn steering (steer-now) | Task 1 (backend/client) + Task 4 (composer) |
| Server-side queue (client outbox dies) | Task 2 (backend/client) + Task 4 (QueueStrip) |
| QueueStrip editable/removable | Task 4 |
| PlanCard (render PlanDisplay, merge with approve/refine) | Task 3 |
| QuestionCard for plan approval | already shipped (P1b) — Task 3 renders the plan alongside it |
| Queue folded into idle-hold / drains with tab closed | Task 2 (drain hook off turn-end; RAM-only) |
| P6 forward-compat: overridable drain hook + reason room | Task 2 (`_maybe_drain_queue`, journaled `queued` item) |

Not in P4: durable queue across restart (RAM-only, re-typable — deferred); the cross-conversation write-lease (P6 interposes on `_maybe_drain_queue`); checkpoints (P5); subagent/bg-task cards (P7). Carry-forward still open: `/turn` under-reports `permission_mode` on a fresh-runner resume (runner-side phase).
