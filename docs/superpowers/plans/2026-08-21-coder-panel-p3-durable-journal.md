# Coder Panel P3 — Durable Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the coder runner's turn journal survive agentd restarts / idle-stops / deploys. Today it's RAM-only (`TurnState.items` in the `_conversations` dict), so after any restart `follow(turnId)` 404s and a mid-turn conversation shows a stale silent chat. P3: agentd appends every journal item to `agentd/coder/<cid>/`, rebuilds `TurnState`s on boot when a runner is re-created, reconciles crash-interrupted turns to a terminal status, and — resolving the P1a respawn-replay hole — journals each interrupted pending approval/question as `request_cancelled` (reason `interrupted_by_restart`) so it surfaces honestly instead of being silently rejected. Unblocks P6 (multi-conversation).

**Architecture (locked with Omar):** **agentd owns the durable journal** (not the CLI's wire.jsonl) — it preserves the exact NDJSON item schema the frontend already consumes, keeps `follow()` working verbatim, is decoupled from CLI internals, and structurally avoids the CLI-`replay` auto-reject trap (agentd never calls the CLI `replay` method). Durability is a **write sink** on `WireRunner._append` (the single journal-write point) plus a **load-and-reconcile** step when a `CoderRunner` is (re)constructed for a cid that has an on-disk journal. Interrupted pending requests are handled at **reconstruction time**, NOT by changing `on_request` — so P1a's live "reject a request with no running turn" posture (and its test) stays intact; the restart case is a separate reconstruction path.

**Tech Stack:** Python 3.14 / FastAPI / asyncio (terminal-server: `uv run pytest tests/ -q`, fast ~13s). Minor TypeScript touch (sanad-web restart-recovery polish). Spec: `docs/superpowers/specs/2026-08-12-coder-agent-panel-design.md` §Durable journal. Base: main (all P0–P2b merged). Work happens in worktree `coder-panel-p3`.

## Global Constraints

- **Work entirely in the worktree** `/private/tmp/claude-501/-Users-omar-Development-sammad-cli/661013be-a3ee-44fa-9e27-12151f0aa867/scratchpad/coder-panel-p3` (branch `coder-panel-p3`, off current main). All paths below are relative to that worktree root. Run tests and git THERE. The main checkout at /Users/omar/Development/sammad-cli is a different branch with Omar's dirty files — do NOT touch it.
- **Commits are Omar-only** — `sanad: <description>`; NEVER any AI attribution. Before EVERY commit: `git branch --show-current` (in the worktree) must print `coder-panel-p3` — else STOP/BLOCKED. This worktree's git binary works normally (no Xcode-license issue in a fresh checkout — but if `git` fails with exit 69, prefix `PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH`).
- **Never `git add -A`** — the worktree is clean, but stage only the files each task names.
- **Durability is a delivery buffer, not history** — the CLI's `wire.jsonl` remains the CLI's durable record; agentd's journal is for serving `follow()`/`turn` across restarts. Retention caps apply (below).
- **Reconstructed turns are pure data** — the runner does NOT resume/re-drive an interrupted turn (no CLI `replay`, no soul re-invocation — that's a later phase). It reconstructs `TurnState`s for the frontend to read.
- **Status reconciliation invariant:** any turn persisted as `running` at crash MUST be rewritten to a terminal status before it is served, else `follow()` blocks forever on `_journal_cond` for a turn that will never advance. Use a new terminal status `"interrupted"`.
- **Caps:** keep the newest `CODER_JOURNAL_TURNS_KEEP` (default 20) turn files per conversation; per-turn journal file cap `CODER_JOURNAL_MAX_BYTES` (default 20 MB) — on breach, stop appending that turn and journal one `{"kind":"error","code":"journal_overflow",...}`. Env-overridable via settings.
- **Fast-suite discipline:** gate on the full terminal-server suite (`uv run pytest tests/ -q`, ~13s) + `uv run ruff check` + `uv run pyright` on changed files. Frontend task: `pnpm test` + `pnpm exec tsc --noEmit` from `control-plane/artifacts/sanad-web`. Do NOT run kimi `tests/e2e` or the full kimi suite.
- terminal-server commands from `<worktree>/terminal-server`.

## Verified facts the plan builds on (from grounding)

- `WireRunner._append(state, item)` (`wire_runner.py:386-389`) is the single journal-write point; items carry monotonic `seq`. `TurnState` (`wire_runner.py:65-89`): `turn_id, user_input, status, started_at, send_id, items, steps, budget_tripped`. `_turns`/`_turn_order` + `_TURN_KEEP=5` in-memory eviction.
- Item kinds: `turn`, `event`, `end`, `error` (base) + `request`, `request_resolved`, `request_cancelled` (coder). Exact shapes in grounding.
- `CoderRunner` (`coder_runner.py`): `conversation_id`, `permission_mode`, `_pending_requests` (dict of `PendingRequest{request_id, request_type, turn_id, created_at, request}`), `_cancel_pending(reason, state)` journals `request_cancelled`. `_conversations` dict keyed `f"{root}::{cid}"`; runner (re)created on `/open`/`/create`/`/send` in `routes_coder.py`.
- Durable dir: none today; put it at `root.parent / "agentd" / "coder" / <cid>` (root = `<user_dir>/workspace`; agentd runs as root, only agentd reads). Atomic-replace helper precedent: `blueprint_trust.py:179` (tmp + `os.replace`); `atomic_json_write` in `src/kimi_cli/utils/io.py` (do NOT import across trees — replicate the tmp+replace idiom in terminal-server).
- Frontend restart-recovery entry point: `CoderPanel.begin()` calls `ensureConversation` (→ `/open`, which spawns a runner — the reconstruction trigger) then `fetchCoderTurn` (→ `/turn`). After reconstruction, `/turn` reports the interrupted turn + cancelled pendings and `follow(oldTurnId)` replays from disk.

---

### Task 1: `coder_journal.py` — durable write sink + layout + caps

**Files:**
- Create: `terminal-server/src/sanad_terminal/coder_journal.py`
- Modify: `terminal-server/src/sanad_terminal/wire_runner.py` (a `journal_sink` seam on `_append`), `terminal-server/src/sanad_terminal/coder_runner.py` (construct the sink), `terminal-server/src/sanad_terminal/settings.py` (caps)
- Create: `terminal-server/tests/test_coder_journal.py`

**Interfaces:**
- `coder_journal.CoderJournal(dir_path: Path, *, turns_keep: int, max_bytes: int)`:
  - `dir_path` = `<user_dir>/agentd/coder/<cid>`. `__init__` mkdirs `dir_path/turns/`.
  - `append(turn_id: str, item: dict) -> None`: append one JSON line to `turns/<turn_id>.ndjson` (open in `"a"`, write `json.dumps(item)+"\n"`). Track per-file bytes; once `> max_bytes`, stop appending for that turn and (once) append `{"kind":"error","code":"journal_overflow","message":...}` then a sentinel so no more writes. Never raise out of `append` (log + swallow — a journal write must never break a live turn).
  - `write_index(turns: list[dict]) -> None`: atomically (tmp + `os.replace`) write `turns.json` = ordered list of `{turnId, status, sendId, startedAt, lastSeq}`. Called at turn start and turn end.
  - `fsync_turn(turn_id: str) -> None`: fsync the turn file at turn end (not per-item — EFS latency). Best-effort.
  - `prune(keep_turn_ids: list[str]) -> None`: delete `turns/*.ndjson` not in `keep_turn_ids`.
  - `load() -> tuple[list[dict], dict[str, list[dict]]]`: read `turns.json` (ordered index) + each referenced `turns/<id>.ndjson` into `(index, {turnId: items})`. Missing/corrupt index → `([], {})`. A corrupt turn file → skip that turn (log). (Reconstruction logic that turns this into `TurnState`s lives in Task 2.)
- `WireRunner`: add ctor param `journal_sink: Callable[[str, dict], None] | None = None` (stored `self._journal_sink`). In `_append`, after the in-memory append + notify, call `self._journal_sink(state.turn_id, item)` if set (wrapped so a sink error never breaks the turn — but the sink itself already swallows). Architect passes `None` (unchanged). Also expose a hook the runner calls at turn start/end to update the index/prune/fsync — simplest: `CoderRunner` owns the `CoderJournal` and passes `journal.append` as the sink, and overrides `start_turn`/`_consume` (or adds small hooks) to call `write_index`/`prune`/`fsync_turn` at the right boundaries.
- `CoderRunner.__init__`: build `self._journal = CoderJournal(user_dir/"agentd"/"coder"/conversation_id, turns_keep=settings…, max_bytes=settings…)` and pass `journal_sink=self._journal.append` to `super().__init__`. (Load/reconcile is Task 2.) Needs the user_dir — `routes_coder._spawn` already has `root.parent`; thread it into the ctor (new param `journal_dir: Path | None = None`; `None` → no durable journal, keeping architect/tests that construct bare runners working).
- `settings.py`: `coder_journal_turns_keep: int = 20` (env `CODER_JOURNAL_TURNS_KEEP`), `coder_journal_max_bytes: int = 20*1024*1024` (env `CODER_JOURNAL_MAX_BYTES`).

- [ ] **Step 1: Failing tests** — `tests/test_coder_journal.py`: append two turns' items → `load()` returns the index + items verbatim (seq preserved); `write_index` is atomic and `load()` reads it; `prune(keep)` deletes non-kept turn files; a turn exceeding `max_bytes` gets a `journal_overflow` item and stops growing; `append` never raises on a bad dir (simulate by pointing at an unwritable path — log+swallow). Settings test in `tests/test_settings.py` for the two caps.
- [ ] **Step 2: RED** — `uv run pytest tests/test_coder_journal.py tests/test_settings.py -q`.
- [ ] **Step 3: Implement** `coder_journal.py`, the `_append` sink seam + turn-boundary hooks, the `CoderRunner` ctor wiring (journal_dir), settings. Keep `journal_sink=None`/`journal_dir=None` fully behavior-preserving for the architect and bare-runner tests.
- [ ] **Step 4: GREEN + full suite** — `uv run pytest tests/ -q` (architect + existing coder tests unchanged). ruff + pyright on changed files.
- [ ] **Step 5: Commit** — stage `coder_journal.py`, `wire_runner.py`, `coder_runner.py`, `settings.py`, `tests/test_coder_journal.py`, `tests/test_settings.py`; message `sanad: durable coder journal — write sink + turn files + retention caps`.

---

### Task 2: Load + reconcile on runner construction (the restart-recovery core)

**Files:**
- Modify: `terminal-server/src/sanad_terminal/coder_runner.py` (reconstruct on init/open), `terminal-server/src/sanad_terminal/wire_runner.py` (accept reconstructed turns; add `"interrupted"` as a terminal status where relevant)
- Modify: `terminal-server/tests/test_wire_runner.py` (or a new `test_coder_journal_recovery.py`)

**Interfaces:**
- `CoderRunner`: after building `self._journal`, call a reconstruction step that:
  1. `index, items_by_turn = journal.load()`.
  2. For each turn in index order, build a `TurnState(turn_id, user_input=<from the "turn"/first item or index>, status=<index status>, started_at, send_id, items=items_by_turn[turnId], steps=…)` and register it into `_turns`/`_turn_order` (respecting `_TURN_KEEP`/`turns_keep`).
  3. **Reconcile:** for any reconstructed turn whose status is `"running"` (crash mid-turn):
     - For every `request` item with no later matching `request_resolved`/`request_cancelled` for that `requestId`: append (via the journal sink too, so disk matches memory) a `{"kind":"request_cancelled","requestId":rid,"reason":"interrupted_by_restart"}` item.
     - Append `{"kind":"error","code":"interrupted_by_restart","message":"This turn was interrupted by a workspace restart."}` and `{"kind":"end","status":"interrupted"}`.
     - Set the `TurnState.status = "interrupted"`.
     - Do NOT populate `_pending_requests` from reconstructed data (those requests are dead — the CLI process is new; nothing can answer them).
  4. Rewrite the index (`write_index`) so the reconciled terminal statuses persist (a second restart doesn't re-reconcile).
- `WireRunner`: `follow()` already returns once `status != "running"` — `"interrupted"` is terminal, so it works. `_recycling_stream` (routes) treats any non-`finished`/`cancelled` end as a failed turn → drops the runner; an `"interrupted"` reconstructed turn is NOT streamed live (it's already terminal on disk), so this only matters if a NEW turn later fails — unaffected. Confirm `turn_summary()` reports the reconstructed last turn.
- Idempotency: a reconstruction must be safe to run once per runner construction; because step 4 persists terminal statuses, a re-created runner after a clean shutdown sees terminal turns and does nothing further.
- The P1a test `test_request_with_no_running_turn_is_rejected` stays UNCHANGED and green (this task does not touch `on_request`).

- [ ] **Step 1: Failing recovery tests** — construct a `CoderRunner` with a `journal_dir` pre-populated with an on-disk journal representing: (a) a finished turn → reconstructs, `follow(turnId)` replays all items and returns; (b) a turn left `running` with a pending `request` (no resolution) → reconstructs as `"interrupted"`, the pending request appears as `request_cancelled reason=interrupted_by_restart`, a synthetic `end status:interrupted` closes it, `follow` returns (does NOT hang), and `_pending_requests` is empty; (c) reconstruction is idempotent (second construction over the now-reconciled journal adds nothing). Use the real `CoderJournal` to write the fixtures.
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN + full suite** (`uv run pytest tests/ -q`; the interrupted-turn test must prove `follow` does not block — wrap in `asyncio.wait_for(..., timeout=5.0)`). ruff + pyright.
- [ ] **Step 5: Commit** — message `sanad: coder journal recovery — reconstruct turns on boot, interrupted-restart cancels pendings`.

---

### Task 3: Routes durability + end-to-end HTTP crash-recovery test

**Files:**
- Modify: `terminal-server/src/sanad_terminal/routes_coder.py` (only if needed — likely minimal; the reconstructed runner makes `/follow` + `/turn` work verbatim), `terminal-server/src/sanad_terminal/app.py` (ensure the `agentd/` dir is prepared like workspace/home/kimi-share)
- Modify: `terminal-server/tests/test_routes_coder.py`

**Interfaces:**
- Confirm `/open` (`routes_coder._spawn`) passes `journal_dir=root.parent/"agentd"/"coder"/cid` to the new `CoderRunner`. `/create` mints a fresh cid → empty journal (no reconstruction). `/follow` and `/turn` are unchanged: they read the live (reconstructed) runner. Verify no route needs a "no runner but disk journal exists" path — because the frontend always re-`open`s (spawning a runner) before `follow`/`turn` (grounding D9). If a route IS hit with no runner but a disk journal (defensive), decide: return the reconstructed summary from disk directly, or 409 `not_started` (the frontend will open first). Recommendation: keep the current no-runner behavior (409/turn:null) — reconstruction happens on `/open`; document this.
- `app.py`: wherever `prepare_single_user_dirs` / the lifespan prepares dirs, ensure `agentd/coder/` is creatable (mkdir parents on first journal write already handles it — but confirm the parent `agentd/` is writable by root; no extra work likely).

- [ ] **Step 1: End-to-end HTTP crash-recovery test** in `test_routes_coder.py`: create a conversation, send a turn that emits an approval request and leaves it pending (fake wire `ASK_APPROVAL` then simulate no response), then **simulate a restart**: `drop_conversation(root, cid)` (kills the runner, journal persists on disk) and re-`open` the conversation (new runner reconstructs from disk). Assert: `GET /turn` reports the last turn status `"interrupted"` with `pendingRequests: []` (the pending was cancelled, not still pending); `GET /follow?turnId=<old>` replays the journal incl. a `request_cancelled reason=interrupted_by_restart` item and closes (does not 404, does not hang). Also assert a NORMAL finished turn survives drop+reopen and `follow` replays it.
- [ ] **Step 2: RED**, **Step 3: Implement** (likely just the `_spawn` journal_dir wiring + any app.py dir prep), **Step 4: GREEN + full suite**. ruff + pyright.
- [ ] **Step 5: Commit** — message `sanad: coder journal — /open reconstructs, follow/turn survive restart end-to-end`.

---

### Task 4: Frontend restart-recovery polish

**Files:**
- Modify: `control-plane/artifacts/sanad-web/app/terminal/coder/CoderPanel.tsx` (and/or `lib/coder/transcript.ts`/`client.ts` if an `end status:"interrupted"` needs a mapping)
- Possibly Modify: `control-plane/artifacts/sanad-web/tests/unit/coder-transcript.test.ts`

**Interfaces:**
- After a restart, `begin()` → `ensureConversation` (re-opens, triggering reconstruction) → `fetchCoderTurn` now returns the interrupted turn's summary (status `"interrupted"`) and `pendingRequests: []`. The re-attach path in `runTurn`/`consume` already closes on the synthetic `end`. Ensure the transcript renders the interrupted turn HONESTLY: the reconstructed items include a `request_cancelled` (→ existing cancelled-card via the P1b reducer) and an `error` item (→ existing `⚠` text block). Verify the reducer handles `end status:"interrupted"` without crashing (it likely just closes). If `fetchCoderTurn`'s `status` type or `begin()`'s branch (`turn.status === "running"`) needs to NOT re-attach-live for an `"interrupted"` status, add that guard (an interrupted turn is terminal — `begin()` must NOT call `runTurn(resume=…)` for it; it should just let the persisted/replayed transcript stand).
- Add a small honest banner/notice for a freshly-recovered interrupted turn if the existing `⚠` item isn't sufficient — implementer's judgment, minimal.
- Pure-logic changes (any `transcript.ts` reducer branch for `interrupted`) get a unit test; JSX is `tsc`+review-gated.

- [ ] **Step 1:** Read `CoderPanel.begin()` (the `turn.status === "running"` branch), `runTurn`/`consume`'s `end` handling, and `transcript.ts` reduce()'s `end`/`error`/`request_cancelled` handling. Confirm `"interrupted"` flows honestly; add the minimal guard/mapping + any pure-logic test. `pnpm test && pnpm exec tsc --noEmit`.
- [ ] **Step 2:** Write the manual-QA script into the task report: enable the panel (flags), start a turn, kill/restart agentd (or trigger idle-stop) mid-turn, reopen the conversation, confirm the turn shows as interrupted (not a stale silent chat) and any pending approval shows cancelled — not silently dropped.
- [ ] **Step 3: Commit** — message `sanad: coder panel — surface restart-interrupted turns honestly`.

---

## P3 exit criteria (spec traceability)

| Spec P3 item | Where |
|---|---|
| Journal survives agentd restart / idle-stop / deploy | Tasks 1–3 |
| `follow(turnId)` no longer 404s after restart | Tasks 2–3 |
| Respawn-replay hole resolved (interrupted pendings surfaced, not silently rejected) | Task 2 (reconcile) + Task 4 (render) |
| Status reconciliation (no forever-blocking `follow`) | Task 2 (`interrupted` terminal + synthetic end) |
| Per-conversation keying (P6 prerequisite) | Task 1 (`agentd/coder/<cid>`) |
| Retention + size caps | Task 1 |
| P1a live-reject posture unchanged | Tasks 2–3 (on_request untouched; its test stays green) |

Not in P3 (later phases): resuming/re-driving an interrupted turn's blocked tool (soul-level, deferred per Omar's decision); server-side steer/queue (P4); checkpoints (P5); the one-brain session lease + multi-conversation write-lease (P6, which this durable-per-cid journal unblocks). Carry-forward still open: `/turn` under-reports mode on a fresh-runner resume (P2b note — the journal doesn't persist `permission_mode`; a fresh reconstructed runner still defaults `"default"` — consider persisting mode in the index as a small P3 nicety OR defer to the runner-side StatusUpdate-tracking phase; DEFER unless trivial).
