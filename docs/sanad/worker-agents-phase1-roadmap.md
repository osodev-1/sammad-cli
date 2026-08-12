# Sammad Worker Agents — Phase 1 Execution Roadmap

| | |
|---|---|
| **Status** | Draft v0.1 — pairs with [worker-agents-prd.md](./worker-agents-prd.md) §12 Phase 1 |
| **Date** | August 13, 2026 |
| **Owner** | osodev-1 / Sammad |

## 1. Purpose & exit criterion

This roadmap maps the PRD's Phase 1 (MVP) scope onto an ordered sequence of spec-sized epics anchored in existing code. It settles sequencing only; requirements live in the PRD, and design decisions live in each epic's spec.

**Exit criterion:** 5 design partners each running ≥ 3 production agents through eval gates for 30 days. Back-computed: milestone M3 (first agent promoted through a gate) must land ≥ 30 days + onboarding buffer before quarter end.

## 2. Ground rules

- **Spec-first.** Each epic gets `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` + a 1:1 plan in `docs/superpowers/plans/`; implementation phases ship on `<slug>-p<n>` branches, PR to `main`.
- **The CLI is the spine.** Every capability lands as a `sammad` verb first; Studio consumes the same APIs the CLI does (DX-4 local↔cloud parity is a ground rule, not a feature).
- **Walking skeleton before pillar depth.** Epic 2 p0 is the thin end-to-end slice (manifest → deploy → invoke → trace → pause); every later epic deepens a pillar the slice already touches. No pillar is built to completion in isolation.
- **Open infrastructure choices resolve in specs, never here** (§8).
- Commits: `sanad: <lowercase description>`.

## 3. Epic sequence

| # | Epic / slug | One-line scope | PRD IDs | Depends on |
|---|---|---|---|---|
| 1 | `manifest-v1` | WorkerAgent manifest schema, loader, validation; local `sammad init/dev/test` loop | Manifest v1; DX-1 (partial), DX-4 seed | — |
| 2 | `worker-runtime` | Deploy a manifest version to an env; sync invoke; run records + traces; pause/resume; async/schedules/A2A as later phases | RT-1..5, 13, 14; KM-2; OB-1 (minimal); DX-1 | 1 |
| 3 | `mcp-fabric` | Central MCP gateway for all tool traffic; connectors; BYO MCP; credential vault; tool permissioning; agents-as-MCP | MF-1..6; RT-14 (vault side) | 1, 2p0 |
| 4 | `governance-core` | Policy engine, autonomy A0–A3 × sensitivity, HITL inbox, immutable audit, kill switch, SSO + roles, attribution, org catalog | GV-1..5, 10, 11; ID-1; RG-1; OB-1 (full) | 2p0; 3 for enforcement |
| 5 | `eval-gates` | Eval runner, promotion gates, regression on change, dev→staging→prod, quality dashboard, GH Actions template | GV-6, 7; RT-9; DX-1 (promote), DX-2 | 1; 2p0 to finish |
| 6 | `agent-studio` | Studio surfaces on the existing sanad web workspace: gallery, builder, code mode, test console with live trace, simulation, versioning, publish | ST-1..7, 9, 10; RG-5 | 1; 2p0 (console); 5 (eval UI) |
| 7 | `agent-copilot` | Describe-to-draft, chat edits as manifest diffs, eval generation, propose-only guardrails | CP-1..3, 5 | 1, 5, 6 |
| — | (inside 2/8) | Agent-to-agent invocation via MCP | RT-8 | 3 (MF-5) + 4 (both agents' policies) |

## 4. The spine

Critical path (serialized) — nothing works end-to-end without these four, in this order:

```
manifest-v1 ──► worker-runtime p0 ──► mcp-fabric p0 ──► governance-core enforcement
     │                 │
     └── unblocks ─────┴──► eval-gates · agent-studio (early) · connector build-out   (parallel tracks)
```

Each spine milestone re-runs the same demo one layer deeper: *deploy this manifest, invoke it, watch the trace, approve the sensitive tool call, see the audit row.*

| Milestone | Meaning | Epics |
|---|---|---|
| **M0** | Local loop: a manifest runs through `sammad init/dev/test` on a laptop | E1 |
| **M1** | Thin slice live in dev: deploy → sync invoke → trace → pause. **The schedule guard rail** | E2p0 |
| **M2** | Governed tools: all tool traffic through the gateway; sensitive calls pause for approval; audit rows land | E3 + E4 core |
| **M3** | First agent promoted to prod **through an eval gate**. Design-partner onboarding starts here, not at quarter end | E5 |
| **M4** | Studio + Copilot: Maya path (template → connected → tested) < 30 min without YAML | E6, E7 |

## 5. Epics

### 5.1 `manifest-v1`

*Why first: it is the contract every other epic consumes; freezing it unblocks all parallel tracks.*

- **Evolves:** `src/kimi_cli/agentspec.py` (`extend` inheritance, tools-by-import-path, `subagents`), specimens in `src/kimi_cli/agents/{default,architect,okabe}/`, validation/CLI pattern from `packages/sanad-blueprint` + the blueprint CLI ("filesystem is canonical; index is a derived projection" — same philosophy for manifests).
- **Adds over agent-spec v1:** identity, model config (gateway aliases), tools as MCP connection refs, knowledge, triggers, policy, eval-gate stanzas — with a documented agent-spec → manifest migration path.
- **Boundary:** policy/eval/trigger stanzas parse and validate but are **not enforced** here; local run goes through `KimiSoul` (`src/kimi_cli/soul/kimisoul.py`, `soul/toolset.py`) with unchanged behavior.
- **Acceptance:** `sammad init` scaffolds manifest + eval-suite stub; `sammad dev` runs it locally; `sammad test` validates schema and runs the suite stub with CI exit codes.

### 5.2 `worker-runtime`

*Why second: the walking skeleton — converts the interactive session soul into a deployable, invocable worker.*

- **Evolves:** `terminal-server/` (the precedent for hosting the CLI soul server-side: per-user volumes, ticket redemption, Railway deploy), `control-plane/` (Clerk auth + opaque runtime-token minting with quota enforcement → agent/env registry + invoke tokens; RT-13/14 extend the existing mint path), `src/kimi_cli/wire/` (trace source), `src/kimi_cli/sanad/` (governed env, gateway wiring), `src/kimi_cli/acp/` (headless-serving prior art).
- **Phases:** p0 = deploy → registered version → sync REST invoke → Wire trace persisted → `sammad runs/logs/pause/resume`. p1+ = async jobs, schedules. A2A phase gated on MF-5/MF-6.
- **Boundary:** governance hooks are stubs (policy stanza parsed, runs auditable, pause works); hardening lands in E4. KM-2 task memory hardened for the serverless context here.
- **Acceptance:** `sammad deploy --env dev` then a `curl` sync invoke returns declared outputs; `sammad runs`/`logs` show the trace; `sammad pause` halts at the next tool boundary.

### 5.3 `mcp-fabric`

*Why third: governance is only real with a single choke point for tool traffic; connectors are also the design partners' first ask.*

- **Evolves:** `src/kimi_cli/soul/toolset.py` (today tools load in-process and MCP servers are dialed directly via fastmcp — the fabric inverts this to gateway mediation), `src/kimi_cli/mcp_oauth.py` + the `mcp add/list/remove/auth` command group (→ `sammad connect`, promoted to org level), `src/kimi_cli/acp/` (agents-as-servers precedent).
- **Vault (RT-14 server side):** credentials resolved gateway-side, never in the worker env — the same rule as the existing LLM gateway ("clients never hold provider keys").
- **Parity rule:** local `sammad dev` speaks to the same fabric (or a loopback fabric) so tool policy behaves identically — a named spec decision.
- **Acceptance:** the M1 invoke re-run with every tool call transiting the gateway; deny-by-default allow-lists; `sammad connect add` registers an org connector; a deployed agent is callable as an MCP server.

### 5.4 `governance-core`

*Why fourth: hardens the seams epics 2–3 deliberately left as stubs, at the choke point epic 3 created.*

- **Evolves:** `src/kimi_cli/approval_runtime/` (session-scoped `ApprovalRuntime` with wire projection → client of a durable cloud HITL inbox), `src/kimi_cli/wire/root_hub.py` (event projection), control-plane Clerk (SSO + roles, GV-11), run records from E2 (immutable audit GV-4, attribution ID-1, kill switch GV-5 as control-plane state the runtime honors). RG-1 org catalog is the control-plane data model here; its Studio UX ships in E6.
- **Acceptance:** a high-sensitivity tool call from an A2 agent pauses into the HITL inbox and resumes on approval; every action lands as an append-only audit row with {agent, version, run id, principal}; fleet kill switch takes effect ≤ 60 s.

### 5.5 `eval-gates`

*Why fifth and parallel-capable: needs only the manifest eval stanza plus something to run against; blocks the exit criterion, so it cannot be last.*

- **Evolves:** `tests_ai/` + `tests_e2e/` harness patterns (eval runner), E2 run records (regression baselines), control-plane promotion state machine (RT-9: dev→staging→prod with gate results attached).
- **Acceptance:** `sammad promote --to prod` refuses until the suite passes its threshold; any change to instructions/model/tools/policy re-runs the suite and diffs scores; the GitHub Actions template runs `sammad test` on PR and deploys on merge.

### 5.6 `agent-studio`

*Why sixth: a UI over APIs epics 1–5 create; starting earlier means building against unfrozen contracts. **Not greenfield** — builds on the shipped Blueprint Studio and the coder panel Wire transcript ([coder-panel spec](../superpowers/specs/2026-08-12-coder-agent-panel-design.md)).*

- **Evolves:** the sanad web workspace (`control-plane/` artifacts + `terminal-server/`); test console live trace = the coder panel's Wire-event transcript pointed at a worker run; simulation = fabric mock-tool mode; versioning/publish (ST-10, RG-5) = control-plane registry UX.
- **Early start:** template gallery + code mode (editing manifests against the E1 validator) can begin as soon as the schema freezes — see §6.
- **Acceptance:** the Maya path — template → connect → test in console with live trace — in < 30 minutes, no YAML seen.

### 5.7 `agent-copilot`

*Why last: generative UX over every prior contract (manifest diffs need the schema; propose-only needs Studio review surfaces; eval generation needs the eval engine).*

- **Evolves:** the Architect pattern (`src/kimi_cli/sanad/architect_tools.py` — the existing read-only, propose-only drafter is the CP-5 guardrail precedent), `src/kimi_cli/subagents/` (`LaborMarket`, `SubagentStore`), `src/kimi_cli/agents/architect/`.
- **Acceptance:** describing a job yields a draft manifest + starter eval suite as a reviewable diff; the Copilot cannot attach connections, grant credentials, raise autonomy, or deploy; its suggestions are audited.

## 6. Parallelization map

| Track | Unblocked by | Contents |
|---|---|---|
| **Spine** | — | E1 → E2p0 → E3p0 → E4 (serialized) |
| **Evals** | E1 (manifest freeze) | E5 runner against local `sammad test`; finishes after E2p0 |
| **Studio early** | E1 | E6 gallery + code mode against the validator; console waits for E2p0 |
| **Connectors** | E3 gateway contract | The ≥ 10 first-party connectors — embarrassingly parallel |

## 7. Risk register & spec authoring order

| Rank | Epic | Why the spec must come early |
|---|---|---|
| 1 | `worker-runtime` | Largest unknown: serverless substrate open; interactive PTY-hosted session soul → headless, cold-startable, multi-tenant worker is the quarter's architectural bet; the DX-4 parity contract is set here and hard to retrofit |
| 2 | `mcp-fabric` | Inverts in-process/direct-dial tool loading into gateway mediation — hot path of every tool call (latency, streaming, auth); security-critical (vault, redaction); its contract shapes E4 enforcement and the connector track |
| 3 | `manifest-v1` | Low technical risk, maximum contract risk — schema mistakes tax every epic; carries the agent-spec compat obligation |

`governance-core` is deliberately not in the top tier: `ApprovalRuntime` + Wire projection already prove the HITL mechanics; its risk collapses once the fabric fixes the enforcement point.

**Spec authoring order:** `worker-runtime` and `mcp-fabric` specs drafted alongside `manifest-v1` (which builds first regardless); then `eval-gates`, `governance-core`, `agent-studio`, `agent-copilot`.

## 8. Open decisions reserved for specs

| Decision | Owning spec |
|---|---|
| Serverless substrate, cold-start/session model, headless-worker shape | `worker-runtime` |
| Trace store + retention | `worker-runtime` |
| Vault backend | `mcp-fabric` |
| Local-parity fabric mode (shared gateway vs loopback) | `mcp-fabric` |
| Policy language / engine | `governance-core` |
| Eval runner + scoring (assertions, rubrics, LLM-judge) | `eval-gates` |
| Catalog/registry data model | `governance-core` (model) + `agent-studio` (UX) |

## 9. PRD coverage matrix (Phase 1 scope, §12)

| PRD IDs | Epic | Phase |
|---|---|---|
| Manifest v1; DX-1 (init/dev/test), DX-4 | E1 `manifest-v1` | p0 |
| RT-1..3, 13, 14 (runtime side); OB-1 (minimal); KM-2; DX-1 (deploy/logs/runs/pause/resume) | E2 `worker-runtime` | p0 |
| RT-4, 5 | E2 `worker-runtime` | p1+ |
| MF-1..6; RT-14 (vault side) | E3 `mcp-fabric` | p0–p1 |
| RT-8 | E2/E3 joint | after MF-5/6 + E4 |
| GV-1..5, 10, 11; ID-1; RG-1; OB-1 (full) | E4 `governance-core` | p0–p1 |
| GV-6, 7; RT-9; DX-1 (promote), DX-2 | E5 `eval-gates` | p0 |
| ST-1..7, 9, 10; RG-5 | E6 `agent-studio` | p0–p1 |
| CP-1..3, 5 | E7 `agent-copilot` | p0 |

## 10. Out of scope for Phase 1

Per the PRD's phase boundaries: RT-6/7 (events, chat surfaces), RT-10..12, RT-15/16, all process intelligence (PM-1..7), KM-1/3/4/5, GV-8/9/12/13, RG-2/3/4/6/7, ID-2/3, OB-2..5, OR-1..3, MF-7..9, ST-8/11..14, CP-4, DX-3 full SDK parity (Python SDK beyond the stub tracks P0–P1 as the runtime API stabilizes), TS SDK, Arabic/RTL.
