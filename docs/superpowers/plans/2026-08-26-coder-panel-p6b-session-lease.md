# Coder Panel P6b — Session lease ("one brain, two views") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One conversation, one owner. A kimi session (= a coder conversation) may be driven by the browser panel OR a terminal TUI, never both at once — enforced by a heartbeated on-disk lease the CLI itself writes. Opening an owned conversation refuses with an explicit one-click **takeover**; a takeover asks the current holder to stand down rather than killing it.

## Locked decisions (Omar, 2026-08-26)

1. **Cooperative detach.** The taker records a steal request; the HOLDER notices on its next heartbeat, releases cleanly, and tells its user it was taken over. Never a silent kill.
2. **A mid-turn takeover is REFUSED, not queued.** Takeover succeeds immediately when the holder is idle. If the holder has a turn running, the takeover is refused with a distinct, actionable message ("that conversation is mid-turn in the terminal — cancel it there, or wait"). Rationale: every existing external-stop path in both UIs is a hard-cancel, so "finish what you're mid-way through" would be new wait-machinery whose cost is an unbounded spinner for the taker; refusing keeps the no-lost-work promise with none of that. The turn's own cancel button is the escape hatch.
3. **Scope: lease only.** P6b = the lease + takeover UX + the `find_resumable_session` filter, reusing P6a's existing `ConversationSwitcher`. **P6c** = full agent tabs, status badges, "+" popover, dock "Agents" section, and any multi-conversation transcript schema.

**Controller-decided (from grounding — engineering-clear, recorded so reviewers don't re-litigate):**
- **Heartbeat 10s, stale >30s** (3 missed beats), per spec. Unrelated to P6a's `WriteLease` TTL (3900s) — different mechanism, different purpose.
- **Naming must disambiguate.** P6a shipped a per-WORKSPACE in-RAM `write_lease` (mutating-tool serialization). P6b adds a per-CONVERSATION on-disk `session lease`/`owner`. They coexist in the same modules; never call the new one just "lease".
- **The wire `initialize` handshake is the ONLY viable refusal channel** to agentd. The child's stderr is `DEVNULL`, and `WireRunner.start()` currently collapses every initialize error into `init_failed` — so it must be widened to propagate the error's own code before `/open` can distinguish `409 session_owned` from a genuine `503` crash.
- **agentd REIMPLEMENTS the owner.json read** rather than importing `kimi_cli` (following `find_resumable_session`'s precedent and the no-kimi-import policy), with a test pinning parity against the kimi-side shape — reimplementation is the house style but each one is a place the trees can drift.
- **Env gate `SANAD_SESSION_LOCKS=1`** following `sanad/activation.py` exactly: absent → the module no-ops entirely so local CLIs are untouched; present-but-corrupt fails closed. agentd threads it into `build_child_env` so agentd and the CLI it spawns always agree.

**Tech Stack:** Python 3.14 (kimi CLI `src/kimi_cli/`, terminal-server `uv run pytest tests/ -q`), TypeScript/Next.js (sanad-web `pnpm test` + `pnpm exec tsc --noEmit`). Worktree `coder-panel-p6b` off main `23d4c06a` (P0–P6a shipped). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` ("One brain, two views").

## Global Constraints

- **Work entirely in the worktree** `/private/tmp/claude-501/-Users-omar-Development-sammad-cli/661013be-a3ee-44fa-9e27-12151f0aa867/scratchpad/coder-panel-p6b` (branch `coder-panel-p6b`). Never the main checkout.
- **Commits Omar-only** — `sanad: <desc>`; NEVER any AI attribution. Before EVERY commit: `git branch --show-current` MUST print `coder-panel-p6b`.
- **Never `git add -A`** — stage only the files each task names.
- **This phase touches `src/kimi_cli/**` — the first real CLI-side work since P2a.** Keep the fork surface minimal and confined to `src/kimi_cli/sanad/session_lock.py` plus the few call-site hooks named below. Do NOT refactor unrelated CLI code.
- **The gate is off by default.** With `SANAD_SESSION_LOCKS` unset, behaviour must be byte-identical to today — a local `sanad run` must never read, write, or wait on a lease. Every task needs a test proving the no-op path.
- **Fail OPEN on lease errors, not closed.** A corrupt/unreadable `owner.json`, a full disk, or a permissions error must never make a session unusable — log and proceed. (Contrast with the trust store, which fails closed: that guards code execution; this only guards against two UIs colliding, and a lease bug that bricks every session is far worse than the collision it prevents.) The one exception: a VALID lease held by someone else is a genuine refusal.
- **Fast suites only, run ONCE each** (repeated full-suite runs stall the watchdog; ~15 agents died to this in P5/P6a). kimi: `uv run pytest tests/core -q` plus any targeted file — NOT the full kimi suite (it has ~46 pre-existing branding-drift failures and a 10-min tmux e2e suite). terminal-server: `uv run pytest tests/ -q`. sanad-web: `pnpm test` + `pnpm exec tsc --noEmit`. Lint from the worktree REPO ROOT: `uv run ruff check <paths>`, `uv run pyright <paths>`.
- **Commit promptly once green** — the environment has been dropping/sleeping agents mid-run all session.

## Verified facts (grounding — cite before editing)

- **No `KimiApp`** — the class is `KimiCLI` (`src/kimi_cli/app.py`). `run_shell()` and `run_wire_stdio()` are its methods; both wrap `async with self._env()`, which is shared by `run`/`run_print`/`run_acp` too and is therefore NOT a valid lease boundary.
- **Acquire belongs at session resolution, not in the run_* methods**: `src/kimi_cli/cli/__init__.py` resolves `--session`/`--resume` via `Session.find(...)` then `Session.create(...)` (~lines 568-593) BEFORE the expensive `KimiCLI.create()` (LLM setup, Runtime, agents, MCP). A refusal there costs nothing. The heartbeat task + release belong inside `run_shell`/`run_wire_stdio`, where a loop exists and the two shutdown paths diverge.
- **Session dir**: `WorkDirMeta.sessions_dir` (`src/kimi_cli/metadata.py`) = `get_share_dir()/"sessions"/<basename>` where basename is `md5(work_dir)` for local kaos, else `f"{kaos}_{md5}"`. `terminal-server/src/sanad_terminal/workspace.py`'s `find_resumable_session` reimplements only the bare-md5 branch — a latent fidelity gap.
- **Corruption this prevents is real**: `state.json` is atomic-replace, but `Session.save_state()` re-reads and merges ONLY `custom_title`/`title_generated*`/`archived*` — `approval`, `plan_mode`, `todos` are clobbered from a stale in-memory copy. `context.jsonl` is append-only for turns, but `revert_to`/`clear` rotate the file out from under a concurrent appender.
- **Cooperative-detach mechanisms (exist, need plumbing):** `WireServer._root_hub_loop()` forwards ANY `is_event(msg)` from `runtime.root_wire_hub` to the client, and `Notification` is already in the `Event` union — a "taken over" notice needs NO new wire types (but this generic path is only exercised by approvals today: wired, not proven). `WireServer._shutdown()` is complete but is only reachable via a LOCAL `stop_event` → must become instance state. On the TUI, `Shell._watch_root_wire_hub()`/`_handle_root_hub_message()` currently drop everything that isn't an Approval → needs a new case; `toast()` is callable from any task; `self._running_interrupt_handler` is externally callable; the main loop's `idle_events` queue is LOCAL → must become instance state to push a quit event (mirroring the existing `cwd_lost` pattern). `Shell._start_background_task()` is the heartbeat pattern to mirror; `WireServer` has no equivalent (hand-rolled tasks cancelled in `_shutdown`).
- **agentd**: `_spawn` builds `argv = [*spawn_argv, "--wire", "--session", cid]`; child stderr is `DEVNULL`; `WireRunner.start()` raises `WireRunnerError("init_failed", ...)` for BOTH a timeout and any initialize error, and `_spawn` maps any `WireRunnerError` to a flat 503. `TicketBody` has only `ticket`. `GET /conversations` lists the in-RAM `_conversations` registry only (a TUI-created session is invisible); the spec's `kimi_sessions.py` disk scan does not exist.
- **Frontend**: `ensureConversation()` has an open→create fallback for `404`/`invalid_conversation` and ZERO handling of 409/`session_owned`/takeover (grep for "takeover" returns nothing). A takeover branch must NOT fall through to create (that would abandon the owned conversation).

---

### Task 1: `session_lock.py` — the lease primitive (kimi-side, pure)

**Files:** Create `src/kimi_cli/sanad/session_lock.py`; create `tests/core/test_session_lock.py`.

**Interfaces** (no I/O beyond the one owner.json; no asyncio; deterministic via an injectable clock):
- `OwnerInfo` dataclass: `holder` (an opaque id for this process/view), `pid`, `ui_mode` (`"wire"`/`"shell"`), `generation` (int, incremented on each acquire), `heartbeat_at` (float), `steal_requested_by` (str | None), `busy` (bool — set by the heartbeat so a TAKER can see "mid-turn" without guessing; see decision 2).
- `locks_enabled() -> bool` — `os.environ.get("SANAD_SESSION_LOCKS") == "1"`, mirroring `activation.py`'s check. Everything else no-ops when False.
- `read_owner(session_dir) -> OwnerInfo | None` — None when absent/corrupt (fail open, log at debug).
- `is_live(owner, *, now=None) -> bool` — `now - heartbeat_at < STALE_AFTER_SECONDS` (30.0). A stale owner is treated as absent.
- `try_acquire(session_dir, *, holder, ui_mode, now=None) -> AcquireResult` — atomic-replace write when free/stale/self; refuse when a live owner exists. `AcquireResult` carries `ok: bool`, `owner: OwnerInfo | None` (the CURRENT owner on refusal, so the caller can explain who and whether they're busy).
- `request_steal(session_dir, *, by, now=None) -> bool` — sets `steal_requested_by` on a live owner's file (read-modify-atomic-write). Returns False if there is no live owner (nothing to steal — the caller should just acquire).
- `heartbeat(session_dir, *, holder, busy, now=None) -> HeartbeatResult` — refresh `heartbeat_at` and `busy` IF still the holder. Returns `still_ours: bool` and `steal_requested_by: str | None`. **This is the holder's only signal channel** — it must be cheap and never raise.
- `release(session_dir, *, holder) -> None` — remove/blank the file only if still ours (a late release must never delete a successor's lease — same holder-guard discipline P6a's `WriteLease.release` uses).
- Constants: `HEARTBEAT_SECONDS = 10.0`, `STALE_AFTER_SECONDS = 30.0`.
- All writes atomic (tmp + `os.replace`) — reuse the existing `utils/io.py` atomic-write helper that `session_state.py` already uses; do NOT hand-roll.

- [ ] **Step 1: Failing tests (TDD)** — acquire when free/absent; refuse when a live owner exists (and `AcquireResult.owner` carries their `ui_mode`/`busy`); acquire when the owner is STALE (>30s); re-acquire by the SAME holder is idempotent and bumps `generation`; `release` by a non-holder is a no-op that does NOT free it; `heartbeat` returns `still_ours=False` once someone else has taken it; `heartbeat` surfaces `steal_requested_by`; `request_steal` sets the field and returns False when there's no live owner; a CORRUPT owner.json reads as None and does not raise (fail open); **every entry point is a no-op returning the permissive result when `SANAD_SESSION_LOCKS` is unset**; writes are atomic (no partial file observable). Inject `now` — never sleep. **RED.**
- [ ] **Step 2: Implement. Step 3: GREEN** — `uv run pytest tests/core/test_session_lock.py -q` then the targeted core suite once; ruff + pyright on the new files.
- [ ] **Step 4: Commit** — `sanad: session lease — owner.json primitive (acquire/heartbeat/steal/release, env-gated)`.

---

### Task 2: Wire it into the CLI — acquire, heartbeat, cooperative detach

**Files:** Modify `src/kimi_cli/cli/__init__.py` (acquire after session resolution), `src/kimi_cli/app.py` (`run_shell`, `run_wire_stdio`), `src/kimi_cli/wire/server.py` (instance `stop_event` + a "taken over" notice + shutdown hook), `src/kimi_cli/shell/__init__.py` (instance `idle_events` + a root-hub case + toast + quit path); tests under `tests/core/`.

**Interfaces / behaviour:**
- **Acquire** right after the session is resolved in `cli/__init__.py` (before `KimiCLI.create()`): if refused, exit WITHOUT starting the expensive setup. The refusal must be distinguishable by mode:
  - **wire**: the CLI must still speak wire protocol well enough for agentd to learn WHY. Emit a JSON-RPC `initialize` error carrying code `session_owned` plus whether the owner is `busy`, then exit. (Task 3 widens agentd to read this; stderr is `DEVNULL` so there is no other channel.)
  - **shell**: print a clear human message naming the other view (`ui_mode`) and that a takeover is available from the panel, then exit non-zero.
- **Heartbeat**: a ~10s background task started in `run_shell` (via `Shell._start_background_task`) and in `run_wire_stdio` (hand-rolled, cancelled in `_shutdown`). Each beat reports `busy` (is a turn running?) and inspects the result:
  - `still_ours=False` → we lost the lease (someone reclaimed a lease we let go stale): stand down immediately (same path as a granted steal).
  - `steal_requested_by` set AND we are **idle** → **stand down**: release the lease, tell the user, exit cleanly.
  - `steal_requested_by` set AND we are **BUSY** → **refuse**: do NOT detach; clear the steal request so the taker learns it was refused. (Locked decision 2.)
- **Stand-down paths** (the plumbing gaps grounding found):
  - wire: promote `stop_event` to instance state; publish a `Notification` ("this conversation was taken over in the terminal/browser") via `runtime.root_wire_hub` so the panel can render it, then set the stop event → the existing `_shutdown()` runs.
  - shell: promote `idle_events` to instance state; add a `Notification` case to `_handle_root_hub_message`; on stand-down, `toast()` the reason and push a quit event mirroring the existing `cwd_lost` pattern so the main loop breaks and the normal `finally` cleanup runs.
- **Release** on every exit path of both modes (normal exit, error, stand-down). Holder-guarded, so a late release can't free a successor's lease.
- **`busy` determination**: wire = a turn is streaming (`_is_streaming`/`_cancel_event` — read the actual attribute); shell = a running turn is bound (the same state `_running_interrupt_handler` tracks). Find and use the real signal; do not invent one.

- [ ] **Step 1: Failing tests** — with the gate OFF, none of this runs (assert byte-identical behaviour: no owner.json created, no heartbeat task); with it ON: acquire happens before `KimiCLI.create()`; a second process is refused; a wire refusal surfaces `session_owned` through the initialize error; an idle holder receiving a steal request stands down and releases; **a BUSY holder receiving a steal request does NOT detach and clears the request**; the lease is released on a normal exit. Prefer testing the pure decision logic directly (extract a `decide_heartbeat_action(result, busy) -> Action` helper and unit-test the matrix) over driving the full TUI. **RED.**
- [ ] **Step 2: Implement. Step 3: GREEN** — targeted kimi core tests once + ruff/pyright.
- [ ] **Step 4: Commit** — `sanad: session lease — CLI acquire/heartbeat, cooperative stand-down, busy refusal`.

---

### Task 3: agentd — propagate the refusal, takeover flag, listing, resume filter

**Files:** Modify `terminal-server/src/sanad_terminal/wire_runner.py` (propagate the initialize error code), `routes_coder.py` (`takeover` on `/open`, 409 `session_owned`, listing joins owner state), `workspace.py` (`find_resumable_session` lease skip + the kaos-prefix fidelity fix), `settings.py` (thread `SANAD_SESSION_LOCKS` into the child env); create `terminal-server/src/sanad_terminal/session_owner.py` (the reimplemented reader); tests.

**Interfaces:**
- `session_owner.py`: `read_owner(session_dir)` / `is_live(owner)` mirroring the kimi-side shape and staleness math, plus `session_dir_for(kimi_share, workspace, session_id)` implementing the FULL digest rule **including the kaos-prefix branch** `find_resumable_session` currently omits. **Add a test pinning parity with the kimi-side layout** (the reimplementation is house style, but it's a drift point — make the drift loud).
- `WireRunner.start()`: stop collapsing every initialize failure into `init_failed`. Propagate the error's own `code`/`message` (a timeout stays `init_failed`), so `_spawn` can map `session_owned` → **409** with the owner's `ui_mode`/`busy`, everything else → today's 503.
- `TicketBody` gains `takeover: bool = False`. When true, `_spawn` calls `request_steal(...)` before spawning, then retries the acquire with a bounded wait (~one heartbeat + margin) so the holder has a chance to stand down. If the owner is BUSY, do NOT wait — return 409 with a distinct code (`session_busy`) so the UI can say "mid-turn" rather than "owned".
- `GET /conversations`: join owner state onto each entry (`owner: {uiMode, busy, live} | null`). **Naming**: this is the SESSION owner — do not blur it with P6a's `lease` field (the workspace write-lease) already in `/turn`.
- `find_resumable_session`: walk candidates newest-first and skip any with a LIVE owner; return None if all are locked (which already degrades to the existing cold-start-fresh path — no new code needed downstream).

- [ ] **Step 1: Failing tests** — a child that refuses with `session_owned` surfaces as **409** (not 503) with the owner's ui_mode/busy; a genuine crash still 503s; `/open {takeover:true}` requests a steal and succeeds once the holder releases; a takeover against a BUSY owner returns 409 `session_busy` WITHOUT waiting; `find_resumable_session` skips a live-owned session and returns an unlocked one; all-locked → None; the kaos-prefix parity test; with the gate off, none of this changes today's behaviour. **RED.**
- [ ] **Step 2: Implement. Step 3: GREEN** — terminal-server suite once + ruff/pyright.
- [ ] **Step 4: Commit** — `sanad: session lease — agentd propagates session_owned, takeover flag, owner in listing, resume filter`.

---

### Task 4: Frontend — the takeover UX

**Files:** Modify `control-plane/artifacts/sanad-web/lib/coder/client.ts` (`ensureConversation` 409 handling + a `takeoverConversation`), `lib/coder/types.ts`, `app/terminal/coder/CoderPanel.tsx` (the refusal + confirm), possibly `ConversationSwitcher.tsx` (owner badge); tests.

**Interfaces:**
- `ensureConversation()` gains a `session_owned` branch that **must NOT fall through to create** (that would abandon the owned conversation — today's fallback only covers `404`/`invalid_conversation`). It surfaces a typed result the panel can render.
- A **takeover confirm**: "This conversation is open in the terminal. Take it over here?" → re-POST `/open` with `{ticket, takeover: true}`. On success, attach normally.
- A **distinct** message for `session_busy`: "That conversation is mid-turn in the terminal — cancel it there, or wait." with no takeover button (it would just fail). This is locked decision 2 surfacing to the user; getting these two cases confused is the most likely UX bug.
- If the panel is the one taken over, it receives the `Notification` event Task 2 publishes → render a clear "taken over in the terminal" state rather than a generic stream error.
- Extract the message/branch selection into a pure helper and unit-test the matrix (owned-idle / owned-busy / free / error).

- [ ] **Step 1: Implement** (TDD the pure helper; JSX review-gated). Gate: `pnpm exec tsc --noEmit` + `pnpm test` ONCE, commit promptly.
- [ ] **Step 2: Manual-QA note** in the report: open a conversation in a terminal, then open it in the panel → refused with a takeover offer; take over → terminal stands down with a message, panel attaches; repeat while the terminal is mid-turn → refused as busy, no takeover button.
- [ ] **Step 3: Commit** — `sanad: session lease — takeover UX, busy refusal, taken-over notice`.

---

## P6b exit criteria

| Item | Where |
|---|---|
| On-disk heartbeated lease, env-gated, fail-open | Task 1 |
| CLI acquires before expensive setup; heartbeats; releases on every exit | Task 2 |
| Cooperative stand-down when idle; refusal when busy | Task 2 |
| agentd distinguishes `session_owned` from a crash (409 vs 503) | Task 3 |
| `takeover` flag; `session_busy` never waits | Task 3 |
| `find_resumable_session` cannot hijack an owned session | Task 3 |
| Takeover UX + distinct mid-turn message + taken-over notice | Task 4 |
| Gate OFF ⇒ behaviour byte-identical to today | Every task |

**Not in P6b (→ P6c):** agent tabs, status badges, the "+" popover, the dock "Agents" section, multi-conversation transcript persistence. **Also not here:** waiting for a mid-turn holder (locked decision 2 — refuse instead); a disk-scan conversation listing that surfaces TUI-created sessions the panel never opened (the listing joins owner state onto the existing registry view only). Carry-forward still open: `/turn` under-reports `permission_mode` on a fresh-runner resume; the steer `call()` 10s-timeout-vs-deferred-ack; P5's `pre..worktree` cumulative-diff pre-enable follow-up.
