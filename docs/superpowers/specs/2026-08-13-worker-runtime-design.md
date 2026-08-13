# Worker Runtime — deploy a manifest, invoke it as a governed run

## Context

Epic 2 of the [Phase 1 roadmap](../../sanad/worker-agents-phase1-roadmap.md): the walking skeleton that turns the interactive CLI soul into a deployable, invocable worker. Everything downstream (fabric, governance, evals, studio) deepens the path this epic creates: manifest → deploy → invoke → trace → pause.

The estate already contains most of the hard parts. One soul per process is the proven safe unit — the core has process-wide state (cwd `chdir` in `KimiCLI._env`, global config writes, telemetry globals), and the web UI already runs souls as wire-driven subprocesses (`web/runner/process.py` → `__web-worker`). terminal-server owns a production wire-subprocess runner with a server-authoritative NDJSON journal, reconnect-safe `follow`, mandatory budgets, and send-id idempotency (`wire_runner.py`, `coder_runner.py`), plus `IdleStopper` self-SIGTERM for scale-to-zero. The control plane owns machine provisioning (`lib/compute/sessions.ts` wake state machine, EFS access points, hash-routed ingress) and the opaque-token pattern with quota at mint/renew (`lib/tokens/runtime.ts`).

Rejected alternatives: **machine per agent** (fleet cost curve: 1,000 idle agents ≈ 1,000 warm tasks, or cold-start pain on the long tail); **Fargate task per run** (30–60s boot on every sync invoke); **shared cross-tenant host** (tenants sharing a kernel violates the isolation NFR); **LangGraph as execution engine** (the fork's core asset already is the runtime — loop, checkpoints/revert, compaction, approvals, subagents, wire trace; adopting LangGraph rewrites that onto foreign abstractions and collapses DX-4 local↔cloud parity; revisit narrowly at OR-2 in Phase 2 as a comparison, not a default).

## Decisions (settled with Omar)

| Decision | Choice |
|---|---|
| Run model | Ephemeral run-per-invoke: fresh soul, fresh session seeded only from the manifest; session dir is the trace. `thread_id` reserved in the API, unimplemented. |
| Placement | One machine per (workspace, env) — the workspace is the pool; every run is an isolated subprocess on its team's machine. `placement: dedicated` parses in the manifest but is rejected until its phase. |
| Readiness | "Waiting" is control-plane state (triggers, endpoints), not warm compute. Warm machine → ~1–2s to action for every agent in the pool; `keep_warm` is a workspace-level policy knob (admins own the spend). |
| Trace store | Run metadata rows in control-plane Postgres; full `wire.jsonl` + `context.jsonl` uploaded to S3 at run end; live runs stream via NDJSON `follow`. |
| Ownership | One accountable human owner per agent (deploy-blocked without one; `orphaned` state on owner departure blocks new deploys, keeps prod running). Workspace admins own the pool machine, budgets, keep-warm. |
| p0 autonomy | Runs execute afk-style (auto-approve); enforcement in p0 is the manifest tool allow-list at toolset load. Sensitivity/HITL pause is governance-core's epic. |
| Output contract | Declared `interface.outputs` enforced by an injected `return_output` tool ending the turn via `force_stop_turn`; one nudge retry if the model finishes without calling it, then the run fails `no_output`. No declared outputs → final message text is the output. |
| Invoke path | Sync invoke terminates at the control plane (token check, quota, wake) and proxies the stream to the machine. Cold workspace: request blocks through the wake up to 120s, then 503 + Retry-After. Revisit if platform overhead breaks the ≤500ms NFR. |
| LangGraph | No. Own the runtime. |

## Architecture

### Topology

- Deployed agent+env = `deployments` row bound to a **workspace machine**: Fargate task + EFS access point keyed by `(workspace_id, env)`, provisioned by generalizing `control-plane/artifacts/sanad-web/lib/compute/sessions.ts` (`ensureSessionTask` → `ensureWorkspaceMachine`; same `AGENTD_TOKEN` derivation, same router hash ingress).
- The machine runs the terminal-server image with a **worker mode**: `/internal/worker/*` routes beside the coder/architect routes in `terminal-server/src/sanad_terminal/`, gated by a `WORKER_ENABLED` setting exactly like `CODER_ENABLED` (default off, fail-closed 404).
- `IdleStopper` (idle.py) gains one probe: live runs hold the machine; `keep_warm` (pushed from the control plane) suppresses self-stop. Machines stopped when quiet — real scale-to-zero, $0 idle unless a team pays for warmth.
- Envs are physically separate machines, so env-scoped secrets/connections never share a filesystem (RT-14 seed).

### Run execution (worker side)

- `RunRunner(WireRunner)` in terminal-server, sibling of `CoderRunner`: one runner per run, argv `[sanad, --wire, --session, r_<hex>]`, env from `build_child_env` with **per-run** `KIMI_SHARE_DIR` and workdir materialized under the deployment's EFS dir. Exactly one `prompt` per runner; process reaped at turn end.
- Run assembly lives in a shared CLI module `src/kimi_cli/worker/` (new): render `interface.inputs` into the user prompt, inject `return_output` into the toolset, apply budgets. Both `sanad dev` (local, in-process) and `RunRunner` (cloud, subprocess) call this module — parity by construction, divergences are import errors not drift.
- Manifest consumption: depends on epic 1's loader (`agentspec.py` evolution). If sequencing overlaps, p0 develops against current `agent.yaml` + an interface/budget sidecar and swaps when manifest-v1 lands.
- Budgets mandatory per run (WireRunner machinery): `max_steps_per_turn`, wall-clock, and a token ceiling as the RT-13 spend proxy (true dollar caps once pricing lands, below). Trip → journaled `error`, cancel, run `failed`.

### Interface contract

- `POST /api/v1/agents/{agent}/invoke?env=` with JSON body per declared inputs; response streams NDJSON journal items (or `?wait=1` collapses to the final output document). `Idempotency-Key` honored via unique index on `(deployment_id, key)`.
- Per-agent OpenAPI served at `GET /api/v1/agents/{agent}/openapi.json`, generated from the manifest interface (RT-3).
- Auth: `itok_` invoke tokens — clone of `lib/tokens/runtime.ts` (opaque, sha256 row, sliding + absolute expiry, family revoke), scoped `(agent, env)`, minted/renewed behind `requireEntitled` + `assertWithinQuota`.

### Control plane

- New tables in `artifacts/sanad-web/lib/db/schema.ts`: `workspaces` (org, name, budget, keep_warm, admin memberships), `agents` (workspace, name, **owner_user_id NOT NULL**, status incl. `orphaned`), `agent_versions` (content-addressed manifest bundle), `deployments` (agent+env → machine binding, status active/paused), `runs` (status queued/running/succeeded/failed/lost/cancelled, timing, token totals, cost, error code, trigger principal, idempotency key), `invoke_tokens`.
- Run lifecycle: control plane inserts `queued` → worker journal streams → worker reports completion fire-and-forget with usage rollup (the gateway's `reportUsage` pattern, authenticated by the run's machine token). Reaper marks runs on dead machines `lost` — no run silently disappears (NFR).
- Cost: pricing table keyed by model alias beside `MODEL_CATALOG` (`lib/models/catalog.ts`); run-end rollup computes dollars from accumulated `StatusUpdate` token usage. Wire gains model-id in the rollup path (today it carries tokens only).

### Ownership & ops model

- Accountability chain: agent incident → owner; pool/budget incident → workspace admins; org kill-switch → org admins. Runs carry `{agent, version, run, triggering principal}` (ID-1); agents get service-principal rows now, directory registration later (ID-2).
- Monitoring aggregates from run rows — no new telemetry infra in p0: **agent page** (version, env status, success rate, p95, spend vs manifest budget, run list) and **workspace pool view** (machine state, live concurrency, per-agent machine share, spend vs cap) in sanad-web; **"my agents"** owner rollup. Quality dashboard (GV-10 needs evals), alerting (OB-2), fleet (RG-4) stack on these rows in their own epics.
- `pause` at agent scope (deployment stops accepting invokes, in-flight runs cancel at next tool boundary — existing cancel semantics) and workspace scope (all deployments + machine stop). This is the kill-switch seed (GV-5).

### CLI

- New verbs on the existing `sanad` binary (naming per PRD open question Q3): `deploy --env`, `runs`, `logs <run>` (live = NDJSON follow; finished = S3 fetch via control plane), `pause/resume`, `dev` (local single run through `kimi_cli/worker/`), extending `src/kimi_cli/cli/`.
- `sanad deploy` posts the manifest bundle → version + deployment rows; machine materializes the bundle on next wake (no machine restart needed for redeploy — bundle re-read per run).

## Phases (each independently shippable)

| # | Scope | Hard edges |
|---|---|---|
| P0 | Walking skeleton: schema + `workspaces/agents/versions/deployments/runs`, worker mode + `RunRunner`, sync invoke with NDJSON stream, `itok` mint, S3 trace upload, owner-enforced deploy, `sanad deploy/runs/logs/pause/resume/dev`, keep_warm flag, lost-run reaper | No async, no schedules, no threads, no dedicated placement; envs limited to `dev`/`prod`; minimal agent + workspace pages |
| P1 | Async jobs: `POST /jobs` → job id → poll + webhook on completion; queued-run dispatch when the pool is saturated | Same run machinery, new dispatch state only |
| P2 | Schedules: cron rows in control plane firing invokes (RT-5); per-deployment concurrency caps enforced at dispatch | Scheduler is control-plane-only; machine unaware |
| P3 | `placement: dedicated` (machine per agent+env via the same provisioning, keyed by agent) + keep-warm schedules (business-hours) | Manifest field flips from parse-reject to honored |
| P4 | Agent-to-agent invoke (RT-8) | Blocked on mcp-fabric MF-5/6; both agents' policies consulted |

## Verification

- **Unit**: run assembly (input rendering, `return_output` schema validation + nudge/fail path, budget config); token→cost rollup; idempotency index; reaper state machine.
- **E2E (scripted-echo)**: extend `tests_e2e/` wire harness — a scripted manifest run through `sanad dev` and through a local `RunRunner` must produce identical journals (the parity test, DX-4); budget trip; cancel mid-run; `no_output` failure.
- **Integration (staging)**: deploy → cold invoke (wake path, sub-120s) → warm invoke (≤2s to first journal item) → pause → 409 → resume; kill the machine mid-run → run marked `lost`; S3 trace fetch after machine stop.
- **Manual**: two agents in one workspace exercising the pool concurrently; workspace pause; orphaned-owner deploy block.

## Non-goals (v1)

Threads/cross-run memory; HITL approval pauses in-run (governance-core); canary/rollback (RT-11); model routing (RT-12); durable human-wait runs (RT-10); event/chat triggers (RT-6/7); transition hooks (RT-15); retries/DLQ (RT-16); connector vault (mcp-fabric); eval gates (eval-gates); cgroup-level pool fairness (budgets + concurrency caps only).

## Key risks (accepted/mitigated)

- **Cold workspace on sync invoke**: 30–60s machine boot breaks the interactive feel → block-through-wake up to 120s + keep_warm knob; honest docs; keep-warm schedules in P3. Accepted for p0.
- **Noisy neighbor in the pool**: per-run budgets + per-deployment concurrency caps only; a hostile-loop agent can still degrade siblings until cgroup fairness lands. Accepted (single-team blast radius).
- **`return_output` model compliance**: nudge-retry then fail; failure rate is measurable from run rows and becomes an eval concern later.
- **Spend proxy imprecision**: token ceilings until the pricing table ships in the same p0; both live in this epic so the gap is days, not phases.
- **Invoke proxy overhead**: control-plane hop adds latency; measured in staging against the ≤500ms NFR; escape hatch is a thin invoke gateway later without API change.

## Critical files

- Worker: `terminal-server/src/sanad_terminal/{wire_runner,coder_runner,idle,settings,workspace}.py` (extend), `run_runner.py`, `routes_worker.py` (new)
- CLI: `src/kimi_cli/worker/` (new), `src/kimi_cli/cli/__init__.py`, `src/kimi_cli/agentspec.py` (epic-1 seam), `src/kimi_cli/wire/types.py` (usage rollup)
- Control plane: `control-plane/artifacts/sanad-web/lib/db/schema.ts`, `lib/tokens/runtime.ts` (clone → `lib/tokens/invoke.ts`), `lib/compute/sessions.ts` (generalize), `lib/models/catalog.ts` (pricing), new `app/api/v1/agents/*` routes
- Tests: `tests_e2e/` wire harness + scripted-echo configs
