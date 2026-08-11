# Coder Agent Panel — Claude Code scope in the sanad workspace

## Context

sanad's browser workspace already ships a full Claude Code-class coding agent — but only as a TUI in the terminal tabs (`sanad run`, the Kimi CLI fork's `default` agent: Shell, file edit tools, subagents, plan mode, MCP, hooks, compaction, approval runtime). The browser-native AI surface (Architect panel) is deliberately fenced to read-only blueprint drafting. Omar wants a **sanad-native full coding agent UI**: chat panel with tool cards, approvals, plan mode, steering, subagent/background-task visibility, whole-workspace checkpoints with diff review, and multiple conversations — the same scope as Claude Code, in sanad's own product surface.

The work is therefore **not building an agent** — it's building a UI + policy layer over an engine already in-tree, by generalizing the existing `ArchitectRunner` bridge ("Approach A: Harvest", chosen over adopting the unused upstream `kimi_cli/web` client or a new WebSocket channel).

## Decisions (settled with Omar)

| Decision | Choice |
|---|---|
| Product shape | Full coding agent in sanad's own UI (panel), terminal stays as power-user view |
| Architect | Unchanged — remains the read-only drafter of `.sanad` skills/agents/MCPs that coding sessions consume. User-scoped blueprint library = separate follow-up effort |
| Session identity | **One brain, two views**: conversation = kimi session id; panel and TUI share the same on-disk session store with exclusive-ownership handoff |
| Agent spec | Same `default` agent spec as the TUI — no fork. Panel behavior lives in permission modes + runner, not the prompt |
| Permission modes v1 | `plan` / `default` (edits auto, shell asks) / `accept-edits`. **Yolo deferred** (open egress + session token in agent env ⇒ injection-exfil risk unattended) |
| Concurrency | Multiple conversations, **single write-lease**: one conversation may run mutating tools at a time; others stream/read/queue. Worktree isolation = v2 |
| Transport | NDJSON-down streaming + `POST /respond` sidecar keyed on `request_id` (no WebSocket) |
| V1 scope | Plan mode + steering + queue, subagents + background tasks, checkpoints + diff review + revert, multi-conversation |

## Architecture

### Runner (terminal-server)
- Extract `WireRunner` base from [architect_runner.py](terminal-server/src/sanad_terminal/architect_runner.py) (subprocess lifecycle, JSON-RPC framing, `TurnState` journal, `_consume`, `follow`, idempotent `start_turn`, read loop). Parametrize: handshake `capabilities`, `on_request` hook (base default = today's `_reject`), `journal_sink`, `out_of_turn_event` hook. `ArchitectRunner` becomes a thin subclass with byte-identical defaults; `routes_architect.py` untouched.
- New `CoderRunner`: one per **conversation**, spawns `sanad --wire --session <conversationId>` (default agent; `--session` legally combines with `--wire` and creates-or-resumes). Handshake: `supports_question: true`, `supports_plan_mode: true` — both load-bearing (plan-mode confirmations flow as `QuestionRequest`; initialize replays pending approvals on respawn for free).
- **Request bridge** (the core): inbound JSON-RPC `request` frames (classify by shape: approval / question / hook→auto-allow) are journaled as `{kind:"request", requestType, requestId, request}` and registered in a conversation-scoped pending map (background-agent approvals arrive between turns via the root hub). `respond(request_id, payload)` sends the JSON-RPC result (`ApprovalResponse`: approve / approve_for_session / reject+feedback; `QuestionResponse`: answers map) and journals `{kind:"request_resolved"}`. **Fail closed**: unknown/resolved/cancelled id → 410; the bridge enforces strict pending-check (never rely on the wire layer's lenient id match at `wire/server.py:926`).
- Cancel/death semantics: turn cancel rejects stale pending requests (existing wire path); runner death fails registry entries and journals `request_cancelled`; unhealthy turn end drops the runner (mirror `_recycling_stream`).

### Durable journal
- Flat NDJSON under `<user_dir>/agentd/coder/<conversationId>/` (sibling of `workspace/` — outside file-API root): `turns/<turnId>.ndjson` + atomically-rewritten `turns.json` index (turnId, status, sendId, checkpoint SHAs) + `background.ndjson` for out-of-turn events. Line-buffered appends, fsync at turn end only (EFS latency).
- Cursor contract: **turn-scoped** `(turnId, from_seq)` — matches existing `follow()`; conversation ordering via `turns.json`. Frontend hydrates newest turns first, pages older turns on demand.
- Lazy load on boot; any `running` turn whose runner isn't alive → rewritten `failed (agentd_restarted)`. Retention: last 20 turn files, 20 MB/turn cap. Full pre-retention history via wire `replay` endpoint.

### One brain, two views
- On-disk lease `sessions/<digest>/<id>/owner.json` (holder, pid, ui_mode, generation, steal_requested_by), heartbeated 10s / live <30s, written by the CLI itself (new `sanad/session_lock.py`, env-gated `SANAD_SESSION_LOCKS=1` so local CLIs are untouched). Symmetric disk-mediated steal protocol; graceful detach on both sides.
- Handoff UX: refuse + one-click takeover (409 `session_owned` → `{takeover:true}`), never silent kill. `find_resumable_session` skips locked sessions so PTY cold-start can't hijack a panel conversation.
- Conversation listing: agentd-side disk scan of the kimi session layout (`kimi_sessions.py`) merged with `turns.json` + lease state — no subprocess needed.

### Permission modes
- Stored in the kimi session's own `state.json` → TUI honors the same mode automatically. Default mode seeds `auto_approve_actions = {"edit file"}` at conversation create — **zero CLI change** for the default posture.
- New wire method `set_permission_mode` (protocol 1.10→1.11, additive) mutating `Approval`/`SessionState` + emitting a status event carrying full `mode` (not just `plan_mode`) so all views converge. `plan` delegates to existing `set_plan_mode`.
- **Per-pattern shell approvals** (CLI change): action string becomes `run command (<normalized head>)` via a small pure `tools/shell/approval_pattern.py`; existing `approve_for_session` cache then gives per-pattern memory in panel *and* TUI. Legacy `"run command"` cache entries = wildcard back-compat.
- **`.sanad/**` write carve-out**: distinct approval action, never auto-approvable, never cached — closes the "agent self-trusts a skill" path at the approval layer too.

### Checkpoints
- Shadow commits: throwaway `GIT_INDEX_FILE` → `git add -A` → `write-tree` → `commit-tree` → `update-ref refs/sanad/checkpoints/<conversationId>`. Never touches HEAD/branches/user index/worktree. Pre-turn + post-turn snapshots (skip when clean vs previous). SHAs in `turns.json` + journaled.
- Diff: `git diff <pre> <post|worktree>` (name-status + patches, 200 KB truncation, SHAs only from our own index). Revert: refuse while any turn runs (409), safety-checkpoint first, temp-index `read-tree` + `checkout-index -f` + delete-absent, under the per-workspace lock. **Human-only UI actions — the agent gets no checkpoint/revert tool.** Blueprint tx system untouched (a coder revert that touches applied `.sanad` files trips its drift-refusal as designed).

### Platform guards (must-fix bundle)
- **IdleStopper probes**: `add_probe()` in [idle.py](terminal-server/src/sanad_terminal/idle.py); runner registries register `holds_machine()` = running turn ∨ non-empty queue ∨ pending request younger than 900s ∨ post-turn grace. Fixes the architect's latent idle-kill bug too.
- **Turn budgets**: panel turns get `CODER_MAX_TURN_SECONDS` (default 3600) + `CODER_MAX_STEPS_PER_TURN` (default 200, vs raw 1000) — journaled failure on breach. Quota stays mint/renew-enforced; budget bounds the runaway window.
- **Token lifecycle**: redeem once at runner start (architect model); idle runners with token age >23h are dropped by a sweeper; mid-turn 24h cliff → fail → respawn on next message (existing pattern).
- **Write lease**: per-workspace mutex over mutating tool execution — one panel conversation's turn holds it; others' turns queue at the lease, surfaced in the journal ("waiting for conversation X"). PTY agents are human-driven and outside the lease (pre-existing behavior, unchanged); the session lock already prevents panel+TUI collision on the *same* conversation.
- **Trust hardening (precedes Shell grant)**: `blueprint-trust.json` becomes root/agentd-owned; trust-record writes move behind an agentd-authenticated endpoint. Pulls forward part of the recorded control-plane-held-trust path.

### Frontend (sanad-web)
- **Placement**: agent conversations = main-area tabs alongside terminals (≤3 mounted-but-hidden like `MAX_TERMINALS`; badges: running pulse / needs-you dot); "+" popover lists all conversations (status chips) via `GET /api/coder/conversations`. ContextDock gains an **Agents** section; a **Checkpoints** section when a coder tab is active. GraphPanel/ArchitectPanel untouched.
- **Transcript v2** (`lib/coder/transcript.ts`, replaces — not extends — the lossy architect model): journal-driven (renders what the server says; local sends reconciled by `sendId`), blocks = text/think/steer/tool/plan/approval/question/subagent/notice; `ToolCallView` keeps args, streamed output, result, exit code, display blocks, duration, linked approval. Pure `applyItem` reducer, keyed by `tool_call_id`/`request_id`, heavily unit-tested (pattern: `tests/unit/architect-transcript.test.ts`).
- **Persistence split**: transcript rebuilt from journal on mount (no sessionStorage anchor); `uiState.coder` holds only view state (tabs, activeConv, drafts, lastReadSeq) — optional field, no schema version bump.
- **Tool cards**: registry-driven (`app/terminal/coder/cards/`), replacing the 6-entry `toolLabel` map: ShellCard (command + live output + exit chip), FileEditCard (shared `DiffView` extracted from `PlanPreview.tsx:117`), Grep/Glob collapsed results, TodoCard (+ pinned strip), SubagentCard (nested transcript, depth 1), Task/Web cards, GenericToolCard fallback. Streaming-safe (partial-args tolerant, result-optional).
- **Approval/plan/question UX**: inline cards (no modals). ApprovalCard: Allow / Always-allow-`<pattern>` (editable suggested pattern) / Deny / Deny-with-feedback; keyboard 1-4. PlanCard: `ExitPlanMode` approval merged with `PlanDisplay` markdown — Approve & build (post-plan mode select) / Refine / Keep planning. QuestionCard mirrors `QuestionItem` (multi-select, Other free-text). Pending requests replay correctly from journal after reload; expired → non-blocking "Expired" state. Mode switcher = segmented control in composer footer (Plan · Default · Accept edits).
- **Steer/queue**: composer never disabled — Steer-now (wire `steer`) vs Queue (server-side per-conversation queue in the runner; drains on turn end; editable/removable via `QueueStrip`, interaction design lifted from ArchitectPanel's queued bubbles). Client outbox dies.
- **Resilience** (`lib/coder/useConversation.ts`): unbounded re-attach (expo backoff 1→30s, visibility-gated) replacing the 6-min ceiling; 90s stall watchdog + Stop button; `StepRetry` rendered honestly; machine-restart → "interrupted" banner + Resend affordance; `coderEpoch` bump on workspace reset.
- **Checkpoints UI**: per-turn "N files changed +a −d · Review · Revert" footers; inline per-file diffs; revert confirm lists affected files and warns about later turns; dock timeline mirrors History's visual grammar.
- **Background tasks**: pinned strip above composer; per-task live output (offset polling) + kill; subagent/background approvals surface in the main flow with source chips.

### API surface (condensed)
agentd `routes_coder.py` prefix `/internal/coder` (Bearer AGENTD_TOKEN + `workspace_root`, ownership derived from bearer only — `turnId`/`conversationId` are lookup keys, never authorization inputs):
`GET /conversations` · `POST /conversations {ticket, mode?}` · `POST /conversations/{id}/open {ticket, takeover?}` · `POST .../send {input, sendId, queue?}` (NDJSON) · `GET .../turn` · `GET .../follow?turnId&from_seq` (NDJSON, works for dead turns) · `POST .../respond {requestId, kind, response?|answers?, feedback?, remember?}` · `POST .../steer` · `POST .../cancel` · `POST .../mode` · `GET .../background?from_seq` · `GET .../tasks` (+ `/tasks/{id}/output?from`, `/tasks/{id}/stop`) · `POST .../replay` · `GET .../diff?turnId&path?` · `POST .../revert {turnId, to}` · `POST .../stop` · `DELETE .../queue/{sendId}`.
sanad-web: thin `app/api/coder/**` proxies mirroring `app/api/architect/*` (`workspaceFetch`, ticket mint reuse, NDJSON passthrough).

### kimi_cli fork surface (kept minimal, all in `sanad/` where possible)
1. `tools/shell/approval_pattern.py` + action-string change (~80 lines + tests)
2. Wire `set_permission_mode` + protocol bump 1.11 (~120 lines)
3. `sanad/session_lock.py` lease + two call-site hooks (~250 lines)
4. `.sanad/**` write carve-out action in file tools' approval path
Nothing else: mode defaults ride on pre-seeded `state.json`; question/plan capability is handshake-only; background-task store gating already passes for wire sessions; steer/cancel/replay/subagent events all exist.

## Phases (each independently shippable)

| # | Scope | Hard edges |
|---|---|---|
| **P0 — Guards + runner base** | `WireRunner` extraction (architect byte-compatible); `CoderRunner` smoke (default agent, mode server-forced to most-restrictive: every shell AND write gated — the toolset exists from first spawn, only the approval posture varies by phase); IdleStopper probes; turn budgets; flags: agentd `CODER_ENABLED`, web `SANAD_CODER_PANEL_EMAILS` (separate from terminal allowlist, fails closed) | Idle fix precedes any long turn |
| **P1 — Approvals bridge + panel spine** | Request bridge + hardened `/respond`; routes open/send/follow/turn/respond/cancel/stop; web proxies; `lib/ndjson.ts` + `lib/coder/*`; single-conversation CoderPanel: streaming transcript, GenericToolCard, ApprovalCard; wire-protocol golden tests (incl. negative cases) | — |
| **P2 — Trust hardening + permission modes unlocked** | Root-owned trust store behind agentd; `.sanad` carve-out; lift the P0 all-gated force → modes default/accept-edits/plan + `set_permission_mode` + per-pattern shell; mode switcher UI; Shell/FileEdit/Search/Todo cards + DiffView extraction; resource ulimits (nproc/fsize) on agent uid | Trust hardening precedes lifting the all-gated force |
| **P3 — Durable journal + resilience** | `agentd/coder/` journal, lazy load, retention, replay; unbounded re-attach; restart-recovery UX; 23h token sweeper | Precedes multi-conversation |
| **P4 — Plan mode + steer + queue** | PlanCard approve/refine; QuestionCard; server-side queue + steer + QueueStrip | — |
| **P5 — Checkpoints** | GitRepo shadow-ref plumbing; pre/post-turn snapshots; diff/revert endpoints (human-only); per-turn footers + dock timeline | — |
| **P6 — One brain + multi-conversation** | `session_lock.py` lease + steal; takeover endpoints; `find_resumable_session` filter; conversation listing; agent tabs + switcher + dock Agents section; write-lease across conversations | Needs P3 |
| **P7 — Subagents + background tasks + hardening** | Background lane + tasks endpoints/UI; SubagentCard; transcript windowing caps; telemetry (force-stop/repeat rates, approval rates, per-turn cost, trust-store mtime canary); kimi-k3 eval harness gate before any non-allowlisted exposure | — |

Backend ≈ 7 engineer-weeks; frontend similar, parallelizable from P1.

## Verification

- **Unit**: `applyItem` reducer replay fixtures (out-of-order, dupes, subagent nesting, pending-request replay); approval-pattern normalizer table tests; permission-mode matrix (mode × tool kind → gated/auto, `approve_for_session` never crosses the `.sanad` carve-out).
- **Wire golden tests** (extend `_fake_architect_wire.py` + `tests_e2e/test_wire_approvals_tools.py`): approval round-trip byte contract; mismatched/stale `request_id` → 410; forged/absent bearer → 401.
- **Crash-recovery**: kill runner and task mid-turn → journal survives, follow replays, turn marked interrupted; IdleStopper does NOT fire during an in-flight zero-browser turn (regression for the fix).
- **Checkpoint integration**: real git workspace — user branches/index/log untouched by snapshots; revert restores + is itself revertible; trust store NOT rolled back by revert (documented).
- **E2E smoke** against a real workspace container: "agent writes a file, runs it, iterates on failure" with every side-effect surfacing an approval frame in `default` mode; egress attempt requires visible approval.
- **Manual**: two-view handoff (panel↔TUI takeover both directions); reload with pending approval; multi-conversation write-lease queueing.

## Non-goals (v1)
No panel yolo. No concurrent writers (single write-lease; worktrees = v2). No agent-driven checkpoint/revert. No user-scoped blueprint library (follow-up). No multi-replica story (single sanad-web replica assumptions stand). No reliance on toolset as the trust boundary — governance is now runtime-gated; the spec says so explicitly. Trust store's full control-plane-held fix remains a recorded follow-up; v1 ships the root-owned compensating control.

## Key risks (accepted/mitigated)
- kimi-k3 tool-calling reliability under long loops — mitigated by step budgets, force-stop telemetry, P7 eval gate before wider exposure.
- 512 CPU/2048 MB per task — write-lease + runner caps (3 live/2 busy) + one-dev-server guidance; revisit task sizing if dogfood shows pressure.
- EFS journal latency — batched appends, fsync at turn end only.
- Session-token-in-env exposure is pre-existing and accepted at dogfood; narrower panel-scoped token recorded as follow-up.

## Critical files
Backend: `terminal-server/src/sanad_terminal/{architect_runner.py → wire_runner.py + coder_runner.py, routes_coder.py (new), idle.py, git_ops.py, blueprint_trust.py, workspace.py}`; CLI: `src/kimi_cli/{wire/server.py, wire/jsonrpc.py, soul/approval.py, tools/shell/, sanad/session_lock.py (new)}`.
Frontend: `control-plane/artifacts/sanad-web/{lib/coder/* (new), lib/ndjson.ts (extracted), app/terminal/coder/* (new), app/terminal/{SessionWorkspace.tsx, tabs.tsx, dock/ContextDock.tsx}, app/api/coder/** (new), lib/sessions/state.ts, app/terminal/graph/PlanPreview.tsx (DiffView extraction)}`.
