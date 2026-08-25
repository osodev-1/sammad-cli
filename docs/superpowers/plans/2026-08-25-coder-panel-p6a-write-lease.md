# Coder Panel P6a — Cross-conversation write-lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Serialize workspace-mutating work across conversations behind a single per-workspace **write-lease**, and use it to **close the P5 revert TOCTOU** (today a `/send` can start a turn in the gap between revert's busy-check and its lock, so the agent's file writes race `restore_to`'s `checkout-index`). One conversation's turn holds the lease; others **queue at the lease** with a visible reason; a revert acquires the same lease atomically instead of doing a racy snapshot check.

**Locked scope decision (Omar, 2026-08-25):** P6 is split. **This branch is P6a = write-lease + a minimal conversation switcher.** The session lease ("one brain" panel↔TUI takeover, `session_lock.py`/`owner.json`/steal protocol, `find_resumable_session` lease filter, full agent tabs + dock Agents section) is **P6b — OUT OF SCOPE here**, a separate later branch.

**Locked design decisions (controller, from grounding — engineering-clear, recorded so reviewers don't re-litigate):**
- **Per-TURN, agentd-side enforcement.** Per-mutating-tool-call would need a new wire event the CLI emits before each mutating tool — a kimi_cli protocol change well outside the spec's "kept minimal" fork surface, and the CLI has zero concept of sibling sessions. Accepted coarseness: a **read-only turn also holds the lease** (a planning/Grep-only turn blocks another conversation's turn). With `coder_max_conversations=3` at dogfood scale this is acceptable; document it. **No `src/kimi_cli/**` changes in P6a.**
- **A real ownership object, NOT `asyncio.Lock`.** P5's `workspace_locks.lock_for` is a bare `asyncio.Lock`: no holder identity, no "who holds it / since when", and a coroutine that acquires must be the one to release — it cannot be held across a multi-minute turn spanning many separate HTTP requests. P6a adds a **new** `workspace_lease.py` ownership struct (holder, acquired_at, TTL) keyed per workspace root, in RAM (agentd is single-replica per the spec's non-goals — same as the existing `_conversations`/`_locks` registries). `workspace_locks.lock_for` **stays as-is** for the blueprint-family mutex; the lease is a distinct, additional concept.
- **Queue-at-the-lease reuses P4's seam.** `enqueue` grows an optional `reason`; the journaled `{kind:"queued"}` item and `queue_summary()` carry it; it already flows to the UI through `GET /turn`'s existing `queue` field. No new endpoint.
- **Revert wins by acquiring, not by checking.** Revert does an atomic `try_acquire("__revert__")`; on failure → today's 409 `workspace_busy`. This preserves the shipped "refuse while any turn runs" behavior while removing the race.

**Tech Stack:** Python 3.14 / FastAPI / asyncio (terminal-server: `uv run pytest tests/ -q`, ~30s). TypeScript / Next.js / React (sanad-web: `pnpm test` + `pnpm exec tsc --noEmit`). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` (Write lease line 54; P6 row line 90; queue-at-lease line 18). Worktree `coder-panel-p6` off merged main `ec86791a` (P0–P5 shipped).

## Global Constraints

- **Work entirely in the worktree** `/private/tmp/claude-501/-Users-omar-Development-sammad-cli/661013be-a3ee-44fa-9e27-12151f0aa867/scratchpad/coder-panel-p6` (branch `coder-panel-p6`). Never touch the main checkout. SDD briefs/reports go to `.superpowers/sdd/...` inside the worktree.
- **Commits Omar-only** — `sanad: <desc>`; NEVER any AI attribution. Before EVERY commit: `git branch --show-current` MUST print `coder-panel-p6`, else STOP/BLOCKED. (Plain `git` works now — the Xcode-license exit-69 issue is fixed; no PATH prefix needed.)
- **Never `git add -A`** — stage only the files each task names.
- **Do NOT touch `src/kimi_cli/**`** (P6a is agentd+web only). Do NOT build any part of P6b (no `session_lock.py`, no `owner.json`, no `find_resumable_session` change, no takeover UX, no multi-tab mounting).
- **Preserve the gapless-acquire invariant.** `coder_runner.py`'s `_maybe_drain_queue` documents (and a test pins) that there is NO `await` between the not-busy check and `start_turn`'s synchronous `busy` flip, so two drains can't double-pop. The lease check must NOT reopen that race: either keep the whole check-then-acquire-then-start sequence await-free, or re-verify after any await. Same discipline for `start_turn`'s own acquire.
- **A lease must never leak.** Every acquire has a release on EVERY exit path (turn finished/failed/cancelled/interrupted, runner death/`stop()`, revert success/exception). A leaked lease deadlocks the whole workspace — this is the single biggest risk in this branch. Belt-and-braces: a TTL/staleness guard so a lease held by a dead runner can be reclaimed.
- **Fast suites only.** terminal-server: `uv run pytest tests/ -q` + `ruff`/`pyright` on changed files. sanad-web: `pnpm test` + `pnpm exec tsc --noEmit`. NOT the kimi e2e/full suite. **Run each suite ONCE** — repeated full-suite runs stall the stream watchdog (this killed several agents in P5). Commit promptly once green.

## Verified facts (grounding — cite before editing)

- **The TOCTOU, precisely:** `routes_coder.py` revert does `if any(r.busy for r in list_conversations(root)): return _err(409,"workspace_busy")` and only THEN `async with lock_for(root):`. `/send` → `runner.start_turn(...)` never imports/acquires `workspace_locks` at all, so a turn can begin (flipping `busy` synchronously) between those two statements; `create_checkpoint`'s `git add -A` can then snapshot a half-written file and `restore_to`'s `checkout-index -a -f` + delete-absent races the agent's writes.
- `workspace_locks.py` `lock_for(root)` → per-root `asyncio.Lock` from a module dict; used by `routes_blueprint.py` (apply/rollback/trust) and `routes_coder.py` (revert). Single-process, no ownership/steal/TTL, must be released by the acquiring coroutine, only ever used inside one request handler.
- `coder_runner.py`: `_maybe_drain_queue` — the sanctioned P6 interposition point (its docstring says so); gapless check-then-start proven + tested. `enqueue`/`dequeue`/`queue_summary`; the journaled `{"kind":"queued"}` item whose docstring says it "deliberately leaves room for a future `reason` key (P6: e.g. `waiting_for_lease`)". `_conversations` keyed `f"{root}::{cid}"`; `list_conversations(root)`. `_checkpoint_pre` via `_before_prompt_sent`; `_checkpoint_post` + `_journal_note_turn` + `fsync_turn` + `_maybe_drain_queue` in `_consume`'s `finally`.
- `wire_runner.py`: `busy` = `self._current is not None and self._current.status == "running"`; `start_turn` sets `self._current = state` synchronously (before its first await) — the atomicity anchor; `_before_prompt_sent` hook; `TurnState.closed` (P5); `_consume`'s `finally`; `stop()` sets `_alive=False` before cancelling the consumer. **Comment at `start_turn` (~line 330-334) explicitly says: "Gating steer/cancel on 'prompt actually sent' is real, separately-tracked write-lease hardening (P6) — deliberately not done here."**
- `routes_coder.py` routes (prefix `/internal/coder`): conversations GET/POST, `{cid}/` open/send/queue-DELETE/respond/turn/mode/follow/cancel/steer/stop/diff/revert. `_gate`/`Gated`, `Root = Depends(workspace_root)`, `_err`, `_bad_cid`. `/turn` already returns a `queue` field from `queue_summary()`. `_spawn` enforces `coder_max_conversations` (default 3) → 409 `conversation_limit`.
- `settings.py`: `coder_max_conversations=3`, `coder_max_queue_depth=50`, `coder_diff_max_bytes`, `coder_journal_*` — the naming/env-parse convention to mirror.
- **Frontend is single-conversation today**: `SessionWorkspace.tsx` holds `const [coderConvId, setCoderConvId] = useState<string|undefined>()` (a scalar); `CODER_TAB_ID` in `tabs.tsx` is a fixed singleton tab ("the Coder chat is a singleton tab", P1b); `CoderPanel` is mounted once with `conversationId={coderConvId}`. `lib/sessions/state.ts` `uiState.coder` is a single optional object `{conversationId?, transcript?, lastInterruptedTurnId?}`. `GET /conversations` ALREADY returns an array of `{conversationId, alive, busy, turn}` — the backend is conversation-plural; only the UI is singular.
- P4's QueueStrip renders the server queue from `/turn`'s `queue`; `lib/coder/client.ts` has `queueCoder`/`dequeueCoder`/`fetchCoderTurn`.

---

### Task 1: The write-lease primitive (`workspace_lease.py`)

**Files:** Create `terminal-server/src/sanad_terminal/workspace_lease.py`; create `terminal-server/tests/test_workspace_lease.py`.

**Interfaces** (pure, in-RAM, per workspace root — no I/O, no asyncio.Lock semantics):
- `REVERT_HOLDER: Final[str] = "__revert__"` — the sentinel holder for a revert (conversation ids match `CONVERSATION_ID_RE` = `^c_[a-f0-9]{12}$`, so this can never collide).
- `class WriteLease`: per-root state `{holder: str | None, acquired_at: float, waiters: deque[str]}`.
  - `try_acquire(holder: str, *, now: float | None = None) -> bool` — **atomic and await-free**: if unheld (or the current lease is STALE, see TTL) → mark held by `holder`, stamp `acquired_at`, return True. If already held by THIS holder → return True (re-entrant/idempotent, so a retry can't deadlock itself). Else → return False.
  - `release(holder: str) -> bool` — release only if `holder` currently holds it (a non-holder release is a no-op returning False — never let a stale release steal the lease from a live holder). Returns whether it released.
  - `holder_of() -> str | None`, `is_held_by(holder) -> bool`, `held_seconds(now=None) -> float`.
  - `add_waiter(holder)` / `pop_waiter() -> str | None` / `remove_waiter(holder)` / `waiters_snapshot() -> list[str]` — a FIFO of conversation ids queued at the lease, so release can hand off in order and `/turn` can report position. `add_waiter` must be idempotent (don't double-add the same cid).
  - **TTL/staleness**: `stale_after_seconds` (from settings, see below). `try_acquire` treats a lease older than the TTL as reclaimable — a safety net for a runner that died holding it. Log loudly when a stale lease is reclaimed (it means a release leaked; it should never happen in normal operation).
- Module-level registry mirroring `workspace_locks`: `lease_for(root: Path) -> WriteLease` from a module dict keyed by `str(root)`.
- `settings.py`: add `coder_write_lease_ttl_seconds: int = 3900` (+ `CODER_WRITE_LEASE_TTL_SECONDS` parse, mirroring the other `coder_*` settings). Default is deliberately just above `coder_max_turn_seconds` (3600) so the TTL can only fire for a genuinely dead holder, never a long legitimate turn — confirm the actual turn-budget setting name/value and set the TTL above it.

- [ ] **Step 1: Failing tests (TDD)** — acquire when free; second holder refused; same holder re-acquire returns True; release by holder frees it; release by a NON-holder is a no-op and does NOT free it; waiters FIFO order + idempotent add + remove; `holder_of`/`is_held_by`/`held_seconds`; a stale (past-TTL) lease IS reclaimable by a new holder and the reclaim is logged; `lease_for` returns the same instance per root and different instances for different roots. **RED.**
- [ ] **Step 2: Implement.** Keep it small, synchronous, and await-free (that's what makes acquire atomic under asyncio).
- [ ] **Step 3: GREEN** — full terminal-server suite once + ruff + pyright on the new files.
- [ ] **Step 4: Commit** — `sanad: coder write-lease — per-workspace ownership primitive (acquire/release/waiters/TTL)`.

---

### Task 2: Runner integration — turns acquire/release, queue-at-the-lease, cross-runner handoff

**Files:** Modify `terminal-server/src/sanad_terminal/coder_runner.py`, `terminal-server/src/sanad_terminal/wire_runner.py` (minimally — see the steer/cancel item); create/extend `terminal-server/tests/test_coder_write_lease.py` (or extend `test_coder_checkpoints.py`'s sibling style) and `terminal-server/tests/test_wire_runner.py`.

**Interfaces:**
- `CoderRunner` holds its workspace `root` (it already does — it builds a `GitRepo` from it) and reaches its lease via `lease_for(root)`.
- **Acquire on turn start:** in `CoderRunner.start_turn`, BEFORE delegating to `super().start_turn(...)`, `try_acquire(self.conversation_id)`. If it fails (another conversation or a revert holds it) → **do NOT start the turn**; instead `add_waiter(cid)` and raise/return a distinguishable outcome the `/send` route turns into a queued response (Task 3). Preserve the gapless invariant: the acquire is await-free and immediately precedes the synchronous `busy` flip inside `start_turn`.
- **Release on turn end:** in `CoderRunner._consume`'s `finally`, release AFTER the existing post-turn bookkeeping (checkpoint_post → `_journal_note_turn` → `fsync_turn`) and BEFORE/around `_maybe_drain_queue`. **Release must happen on every terminal path** — finished, failed, cancelled, interrupted. Also release in `stop()`/runner-death paths so a dropped runner can't strand the workspace.
- **`_maybe_drain_queue` gates on the lease** (the P4-sanctioned interposition): only pop-and-start when the runner is alive, not busy, AND the lease is acquirable by this cid. If the lease is held elsewhere, leave the item queued (with its `waiting_for_lease` reason) and return — do NOT spin.
- **Cross-runner handoff (the crux):** releasing the lease must wake OTHER conversations that are queued at it — `_maybe_drain_queue` only ever fires on its own runner's turn-end, so conversation B (which never had a turn) would otherwise wait forever. On release, pop the next waiter from the FIFO and invoke that runner's `_maybe_drain_queue` (look up via `list_conversations(root)` / the `_conversations` registry). Do this **without** letting an exception in one runner's drain break the releasing turn's teardown (wrap best-effort, log), and without reintroducing a double-pop race (the woken runner re-checks the lease itself).
- **`enqueue` grows `reason: str | None = None`** — threaded into the journaled `{"kind":"queued", ..., "reason": ...}` item and into `queue_summary()`'s dicts (so it flows out through the existing `/turn` `queue` field). When a send is queued because the lease is held elsewhere, reason = `"waiting_for_lease"`, and include WHICH conversation holds it so the UI can say "waiting for conversation X" (e.g. `reason="waiting_for_lease"` + `blockedBy=<holder cid>`; keep the shape additive and optional).
- **Steer/cancel prompt-sent gate** (deferred to P6 by an explicit `wire_runner.py` comment, and by P5's final review): today `self._current` is set (making the turn look busy to `/steer` and `/cancel`) BEFORE the prompt actually reaches the CLI — and P5's pre-turn checkpoint added an `await` in that window, widening it. A `/steer` landing there is dropped (409) and a `/cancel` is silently ignored. **Fix:** gate steer/cancel on the prompt having actually been sent (`self._prompt_id is not None`, or an equivalent explicit flag), so a control message can't precede an unsent prompt. Keep the change tight and update the now-stale comment. Add a test for steer-before-prompt-sent.

- [ ] **Step 1: Failing tests** — a turn acquires the lease (`holder_of() == cid`) and releases it at turn end; the lease is released on a FAILED/cancelled turn too; conversation B's `/send` while A holds → B's item is queued with `reason="waiting_for_lease"` and does NOT start; when A's turn ends, **B's queued turn actually starts** (the cross-runner handoff — assert a real turn begins for B); a stale/dead-holder lease doesn't wedge the workspace; `stop()` releases; steer-before-prompt-sent is rejected/deferred rather than dropped. **RED.**
- [ ] **Step 2: Implement.** **Step 3: GREEN** — full terminal-server suite once + ruff + pyright.
- [ ] **Step 4: Commit** — `sanad: coder write-lease — turns acquire/release, queue-at-lease, cross-runner handoff, steer/cancel prompt gate`.

---

### Task 3: Routes — revert acquires the lease (closes the TOCTOU), `/send` queue-at-lease, lease visible in `/turn`

**Files:** Modify `terminal-server/src/sanad_terminal/routes_coder.py`; extend `terminal-server/tests/test_routes_coder.py`.

**Interfaces:**
- **`POST /revert`** — replace the racy two-step (`any(r.busy ...)` snapshot, then `async with lock_for(root)`) with an **atomic** `lease_for(root).try_acquire(REVERT_HOLDER)`. On failure → the SAME shipped response: 409 `workspace_busy` (preserve the code/message so the frontend's existing "Can't revert while a turn is running" handling is unchanged). On success → `try/finally` so the lease is ALWAYS released, and keep the existing `async with lock_for(root)` INSIDE it (the blueprint mutex is still needed — a blueprint apply is a different actor that doesn't take the write-lease). Order: acquire lease → blueprint lock → safety checkpoint → `restore_to` → marker → release lease. **This is the TOCTOU closure — a turn can no longer start mid-revert, because `start_turn` now needs the same lease.**
- **`POST /send`** — when `start_turn` reports the lease is unavailable, return the SAME 202 queued envelope P4 already returns (`{"ok":true,"queued":true,"position":n}`), with the reason/blockedBy carried in the queue (visible via `/turn`), rather than an error. A busy-own-runner send still queues exactly as today. Keep the 202 contract intact (P4's proxy short-circuit depends on it).
- **`GET /turn`** — the `queue` array now carries `reason`/`blockedBy` (from `queue_summary()`); additionally surface the workspace lease state so the UI can explain the wait, e.g. `"lease": {"holder": <cid|"__revert__"|null>, "heldSeconds": n}`. Keep it additive.
- No new routes.

- [ ] **Step 1: Failing tests** — revert while conversation A runs a turn → 409 `workspace_busy` (unchanged); **the TOCTOU regression test**: a `/send` issued after the revert has acquired the lease does NOT start a turn (it queues) — i.e. no turn can begin during a revert; revert releases the lease on success AND on exception (assert a later turn can start); `/send` from B while A holds → 202 queued with the reason surfaced in `/turn`; `/turn` reports lease holder. **RED.**
- [ ] **Step 2: Implement.** **Step 3: GREEN** — full terminal-server suite once + ruff + pyright; sanad-web untouched in this task.
- [ ] **Step 4: Commit** — `sanad: coder write-lease — revert acquires the lease (closes P5 TOCTOU), queue-at-lease in /send, lease in /turn`.

---

### Task 4: Frontend — minimal conversation switcher + "waiting for conversation X"

**Files:** Modify `control-plane/artifacts/sanad-web/app/terminal/SessionWorkspace.tsx`, `app/terminal/coder/CoderPanel.tsx`, `lib/coder/types.ts`, `lib/coder/client.ts` (if a conversations fetch/type is needed); extend `tests/unit/coder-client.test.ts` / `coder-transcript.test.ts` as applicable. Possibly a small new `app/terminal/coder/ConversationSwitcher.tsx`.

**Scope discipline (P6a is the MINIMAL cut — do NOT build P6b):** keep the SINGLE mounted `CoderPanel` and swap its `conversationId` prop. **No** multi-tab mounting, **no** `MAX_TERMINALS`-style ≤3 hidden panes, **no** per-tab badges, **no** dock Agents section, **no** takeover/session-lease UX. Those are P6b.

**Interfaces (UI):**
- **Conversation switcher**: a small control in the coder panel header listing the workspace's conversations from the existing `GET /api/coder/conversations` (already returns `{conversationId, alive, busy, turn}[]`), plus a "New conversation" action using the existing create endpoint (respecting the `coder_max_conversations` 409 `conversation_limit` — surface it as a clear message, don't fail silently). Selecting one sets `coderConvId`. Persist the selection in the existing `uiState.coder.conversationId` (already a field — no schema change).
  - **Transcript hygiene when switching:** the persisted `uiState.coder.transcript` is single-conversation today. Switching must not show conversation A's transcript under B. Simplest correct behavior: on switch, clear the in-memory transcript and rebuild from the journal for the newly selected conversation (the panel already rebuilds on mount/attach). State what you chose; do NOT invent a multi-conversation persistence schema (that's P6b).
- **Queue reason in the QueueStrip**: when a queued item carries `reason="waiting_for_lease"`, render it as "waiting for conversation `<short id>`" (use `blockedBy`; fall back to a generic "waiting for another conversation" when absent) instead of a plain queued bubble. Extract the label logic into a pure helper and unit-test it.
- Keep P1b/P3/P4/P5 behavior intact (re-attach, interrupted-once, mode switcher, steer/queue, checkpoint footers/dock).

- [ ] **Step 1: Implement** the switcher + queue-reason label (TDD the pure helper(s): the queue-reason label mapping, and any conversation-list formatting). Gate: `pnpm exec tsc --noEmit` + `pnpm test` ONCE, then commit promptly.
- [ ] **Step 2: Manual-QA note** in the report: with two conversations, start a long turn in A, send in B → B's message shows "waiting for conversation A" and runs automatically when A finishes; revert is refused while A runs; switching conversations shows the right transcript.
- [ ] **Step 3: Commit** — `sanad: coder write-lease — conversation switcher + waiting-for-lease queue reason`.

---

## P6a exit criteria

| Item | Where |
|---|---|
| Per-workspace write-lease with holder identity + TTL | Task 1 |
| One conversation mutates at a time; others queue at the lease | Task 2 |
| Cross-runner handoff (a queued conversation starts when the lease frees) | Task 2 |
| **P5 revert TOCTOU closed** (revert acquires the lease atomically) | Task 3 |
| Queue reason surfaced (`waiting_for_lease` + blockedBy) through `/turn` | Tasks 2+3+4 |
| steer/cancel gated on prompt-sent (deferred from P5) | Task 2 |
| Minimal conversation switcher | Task 4 |

**Explicitly NOT in P6a (→ P6b):** `session_lock.py` / `owner.json` / heartbeat / steal protocol; `find_resumable_session` lease filter; 409 `session_owned` + takeover UX; full agent tabs + switcher badges + dock Agents section; multi-conversation transcript persistence. **Also not here:** per-mutating-tool-call lease granularity (needs a kimi wire change); a read-only turn still holds the lease (accepted, documented). Carry-forward still open: `/turn` under-reports `permission_mode` on a fresh-runner resume; `steer()` 10s `call()` timeout vs a deferred CLI ack; the P5 `pre..worktree` cumulative-diff pre-enable follow-up.
