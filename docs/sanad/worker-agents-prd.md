# Sammad Worker Agents — Product Requirements Document

| | |
|---|---|
| **Product** | Sammad Worker Agents platform (Studio, Runtime, MCP Fabric, Governance) |
| **Status** | Draft v0.1 for review |
| **Date** | August 12, 2026 |
| **Owner** | osodev-1 / Sammad |
| **Related** | `sammad-cli` repo (fork of Kimi Code CLI, Apache-2.0), sanad control plane, LLM gateway |

---

## 1. Executive summary

Sammad is an AI ecosystem for business users. This PRD defines its flagship product: **Worker Agents** — governed AI agents that organizations embed directly into their operating model, the way they would onboard a contractor: with a job description, scoped access, a manager, and a performance review.

The platform consists of four pillars and the connective tissue between them:

1. **Agent Studio** — build, configure, and test worker agents: describe the job and the **Agent Copilot** drafts it — or work from templates → visual builder → code — with simulation and trace-level debugging.
2. **Serverless Runtime** — deploy agents as scale-to-zero serverless entities invoked by API, schedule, event, chat surface, or another agent.
3. **MCP Fabric** — a governed Model Context Protocol layer: agents consume enterprise tools through a central MCP gateway, and every deployed agent is itself exposed as an MCP server so it can be embedded anywhere.
4. **Governance & Oversight** — policy enforcement, autonomy levels, human-in-the-loop approvals, immutable audit, and an evaluation system that gates deployment and continuously scores production behavior.

Supporting these: an agent registry, first-class agent identity, observability, knowledge & retrieval (managed RAG or bring-your-own indexes such as Azure AI Search), memory, orchestration, and a developer surface (CLI/SDK/API) that keeps everything agent-as-code — plus **process intelligence**: mine the event logs of the systems where work already happens to discover the as-is process, score where agents belong, and wire them to specific steps and status transitions.

**North star:** a company can take a worker agent from idea to a governed, production deployment embedded in a real workflow **in under one day**, without standing up a platform team — and can prove to its risk function exactly what that agent did and how well it performed.

---

## 2. Problem statement

Organizations want agents in their workflows, but five failure modes keep pilots from reaching production:

1. **Fragmented tooling.** Building happens in one tool, testing in a notebook, deployment in bespoke infra, monitoring nowhere. Nothing shares a definition of what "the agent" is, so nothing is reproducible or auditable.
2. **The governance wall.** Security, risk, and compliance teams (rightly) block agents that have unbounded tool access, no audit trail, no spend controls, and no measurable quality bar. Most agent platforms bolt governance on after the fact; enterprises need it built in.
3. **Integration pain.** Every agent needs access to the systems where work actually happens — email, ERP, CRM, ticketing, files, databases. Point-to-point integrations don't scale and can't be centrally controlled.
4. **No definition of "good."** Without evaluation, organizations cannot answer "is this agent safe to promote?", "did last week's prompt change make it worse?", or "what is this worth?" — so trust never compounds and autonomy never expands.
5. **Placement by guesswork.** Even willing organizations don't know *where* agents belong. Without visibility into how their processes actually run — which steps carry the volume, the waiting, the rework — pilots aim at the wrong work and the ROI never shows up.

The result: high experimentation, low production adoption, and shadow AI where employees use ungoverned tools anyway.

---

## 3. Where we start: existing assets

This PRD builds on real code, not a blank page. The current repository already provides:

| Asset | What exists today | What it seeds |
|---|---|---|
| **CLI agent core** (fork of Kimi Code CLI) | Terminal agent with agent loop, context/compaction, session persistence, skills, subagents (`LaborMarket`, `SubagentStore`), ACP server mode | The agent execution engine and the headless runtime's core loop |
| **Agent specs** | YAML specs with `extend` inheritance, tool selection by import path, subagent registration, prompt templating | The Worker Agent manifest (v1 evolves this format) |
| **MCP support** (fastmcp) | `mcp add/list/remove/auth` command group, HTTP + stdio transports, OAuth, ad-hoc config files | Connection management UX; foundation for the MCP Fabric |
| **Approval runtime** | Session-level `ApprovalRuntime`, approvals projected onto the Wire event stream for shell/web UIs | Human-in-the-loop and autonomy-level enforcement |
| **Wire event stream + web UI** | Structured event stream between agent core and UIs | Studio's live trace view; observability event schema |
| **Control plane** (sanad-web: Next.js, Clerk, Neon Postgres, Stripe) | Device-flow sign-in, subscription gating, opaque runtime-token minting with quota enforcement at mint/renew | Tenant identity, entitlements, metering backbone |
| **LLM gateway** (Azure AI Foundry-backed) | All model calls routed through an internal gateway; clients never hold provider keys | Governed model access, model routing, per-tenant spend control |

> **Naming note:** the repo is `sammad-cli` while internal docs use `sanad`. This PRD uses **Sammad** for the platform; unifying the brand is tracked as an open question (§15).

---

## 4. Goals and non-goals

### Goals

- **G1 — Simple by default, flexible by design.** A business user ships a useful agent from a template without code; an engineer drops to a manifest, SDK, and CI/CD without leaving the platform.
- **G2 — Safe autonomy.** Every agent runs under explicit policy: scoped tools, autonomy level, spend caps, approval points, kill switch. Governance is a deployment prerequisite, not an afterthought.
- **G3 — Open integration, MCP-first.** Tools in and agents out both speak MCP. No proprietary connector lock-in; anything that speaks MCP plugs in, and Sammad agents plug into anything.
- **G4 — Measurable quality.** Evaluation is a first-class object: gates before deployment, continuous scoring in production, regression on every change.
- **G5 — Elastic economics.** Serverless, scale-to-zero execution; cost visible per run, per agent, per team.
- **G6 — Fits the org.** SSO/SCIM, RBAC, audit export, data residency options — deployable by IT, approvable by risk.

### Non-goals (v1)

- **NG1** — Not a general BPM/workflow engine. We integrate with existing orchestrators and iPaaS (triggers in, MCP out) rather than replacing them.
- **NG2** — Not a model training or fine-tuning platform. Model access is via the gateway; customization is via instructions, tools, knowledge, and evals.
- **NG3** — Not a consumer product. Sammad targets organizations; individual/consumer agents are out of scope.
- **NG4** — Not a per-connector custom integration business. The MCP standard plus a connector SDK is the scaling strategy; bespoke one-off connectors are not.
- **NG5** — No on-prem GPU serving in v1. VPC/bring-your-own-cloud is a Phase 3 consideration (§13).

---

## 5. Personas

| Persona | Role | What they need from Sammad |
|---|---|---|
| **Maya** — Process owner | Ops manager, Finance/HR/Support | Pick a template, connect her team's systems, set the rules, watch it work. Never sees YAML. |
| **Deven** — Citizen builder | Business analyst | Studio's guided builder plus the test console; light manifest edits; owns the eval suite for his agents. |
| **Priya** — Platform engineer | IT / platform team | CLI + SDK, agents-as-code in git, CI/CD promotion, MCP gateway administration, custom connectors. |
| **Omar** — Risk & compliance | Security / audit | Policy authoring, approval workflows, immutable audit export to SIEM, eval reports, one-click kill switch. |
| **Lena** — IT admin | Identity & spend | SSO/SCIM, RBAC, agent identities in the IdP, budgets and chargeback, tenant configuration. |

---

## 6. Product principles

1. **Agents are workforce members.** Every worker agent has a job description (instructions), scoped access (MCP connections + policy), a manager (owner + approvers), and performance reviews (evals). The whole product reinforces this mental model.
2. **Progressive disclosure.** Describe (Copilot) → template → guided builder → manifest/code. Nothing done in the UI is impossible in the CLI, and vice versa; the manifest is the single source of truth.
3. **Governance is load-bearing.** An agent cannot reach production without an owner, a policy, and a passing eval gate. Defaults are safe; friction is spent where risk lives (sensitive tools), not everywhere.
4. **One choke point for side effects.** Every tool call from every agent flows through the MCP gateway — one place for auth, logging, policy, redaction, and emergency stop.
5. **Everything versioned, everything observable.** Manifests, prompts, policies, and eval suites are versioned artifacts; every run produces a complete trace.
6. **Open by default.** MCP for tools and agent exposure; OpenTelemetry for traces; exportable manifests, logs, and eval data. Leaving Sammad should be possible — that's why enterprises can commit to it.
7. **AI builds, humans govern.** The platform uses AI to build itself: describing a job yields a draft agent; failing evals yield proposed fixes. But AI proposals travel the same review, policy, and eval gates as human work — acceleration never becomes circumvention.
8. **Meet the process where it runs.** Agents attach to the steps and status transitions of existing systems — discovered from real event logs, not org-chart theory — so adopting agents means wiring into the operating model, not migrating off it.

---

## 7. Core concepts

| Concept | Definition |
|---|---|
| **Worker Agent** | The unit of the platform. Defined by a versioned **manifest**: identity, instructions, model config, tools, knowledge, triggers, policy, and eval gate. (Evolves the existing YAML agent-spec format.) |
| **Tool** | A capability exposed over MCP (e.g., `erp.get_purchase_order`). Tools carry a sensitivity classification. |
| **Connection** | An authenticated binding between a workspace/agent and an MCP server, with scoped credentials from the vault. |
| **Knowledge source** | Anything an agent retrieves from: a Sammad-managed knowledge base (KM-1) or a bring-your-own index in an existing search service such as Azure AI Search (KM-4) — both behind one retrieval-tool contract, both routed through the gateway. |
| **Workspace** | A team-level container: agents, connections, knowledge bases, policies, members, budgets. |
| **Environment** | `dev` → `staging` → `prod` deployment targets with independent connections, secrets, and promotion gates. |
| **Run / Trace** | One invocation of a deployed agent and its complete, replayable record: every step, tool call, token, approval, and cost. |
| **Evaluation suite** | Versioned test cases + scoring (rubrics, assertions, LLM-judge) attached to an agent; used as promotion gates and for continuous production scoring. |
| **Policy** | Declarative rules (allowed tools, autonomy, spend, data handling, hours) attached at org, workspace, or agent scope; enforced at runtime by the gateway and runtime. |
| **Autonomy level** | A0 draft-only · A1 every action approved · A2 sensitive actions approved · A3 autonomous with monitoring. |
| **Process model** | The as-is process map discovered from an organization's event logs: variants, frequencies, durations, bottlenecks, rework (§9.11). |
| **Transition hook** | A trigger binding an agent to a status change of an entity in a connected system — before or after the change, in advisory or gating mode (RT-15). The primary way mined insertion points become live agents. |
| **Fleet** | All deployed agents in an org, managed and observed as a whole. |

---

## 8. System overview

```
            ┌───────────────────────  Governance plane  ───────────────────────┐
            │  Policy engine · Evals · Audit log · Approvals (HITL) · Budgets  │
            └───────┬───────────────────┬───────────────────────┬──────────────┘
                    │                   │                       │
  ┌─────────────┐   │   ┌───────────┐   │   ┌───────────────┐   │   ┌─────────────────────┐
  │ Agent Studio│──►│──►│  Registry │──►│──►│ Serverless    │◄──┼──►│ MCP Fabric (gateway) │◄──► Enterprise systems
  │ (web)       │   │   │ (catalog, │   │   │ Runtime       │   │   │ connectors · vault · │     (ERP, CRM, email,
  │ CLI / SDK   │   │   │ versions) │   │   │ (scale-to-0)  │   │   │ agents-as-MCP        │      ITSM, DBs, files)
  └─────────────┘       └───────────┘       └───────┬───────┘       └─────────────────────┘
                                                    │
                                          LLM Gateway (existing) ──► model providers
```

- **Build:** Studio or CLI produce a manifest, tested against mocked or dev connections, gated by evals.
- **Publish:** manifests land in the registry with version, owner, and docs.
- **Run:** the runtime executes manifests serverlessly; all model calls go through the existing LLM gateway; all tool calls go through the MCP gateway.
- **Embed:** every deployed agent exposes an MCP endpoint (and REST/webhook), so ERPs, chat platforms, other agents, or any MCP client can call it.
- **Place:** mine event logs from the org's operating systems to discover the as-is process and bind agents to its steps and status transitions (§9.11).
- **Govern:** the governance plane spans everything — nothing executes outside policy, and everything is audited and evaluated.

---

## 9. Functional requirements

Priorities: **P0** = MVP (Phase 1), **P1** = Phase 2, **P2** = Phase 3. IDs are stable for tracking.

### 9.0 Lifecycle coverage at a glance

A worker agent moves through seven stages, and every stage is owned by the platform — no gaps that force teams into side tooling. This table is the index; the rest of §9 is the detail.

| Stage | What the platform provides | Requirements |
|---|---|---|
| **1 · Develop** | Copilot draft, template, guided builder, or code; versioned manifests and prompts; collaboration and review | ST-1..5, 10–13; CP-1, 2, 5; DX-1, 4 |
| **2 · Test & evaluate** | Test console, simulation with mocks, batch runs, production-trace replay; eval suites as promotion gates | ST-6..9, 14; CP-3; GV-6, 7 |
| **3 · Deploy** | One-click/CLI deploy; environments with gated promotion; canary and instant rollback; per-env secrets; CI/CD | RT-1, 2, 9, 11, 13, 14; DX-2, 3 |
| **4 · Publish & embed** | Registry release with semver, release notes, and auto-generated consumer docs; every invocation surface (API, jobs, schedules, events, chat, transition hooks, agent-to-agent, MCP) | RG-1, 5, 6; RT-3..8, 15; MF-5 |
| **5 · Operate & monitor** | Full traces; ops metrics and alerting; online evals; quality and fleet dashboards; audit; incidents; retries and dead-letter queue; kill switch | OB-1, 2, 5; GV-4, 5, 8, 10; RG-4; RT-16 |
| **6 · Improve** | End-user feedback → review queues → new eval cases; Copilot diagnose-and-fix; replay-verified fixes; automatic regression; before/after process proof | GV-9, 13; CP-4; ST-14; GV-7; PM-5 |
| **7 · Retire** | Lifecycle states; usage-aware deprecation with consumer notice; credential revocation; run archival per retention | RG-2, 6; GV-12 |

### 9.1 Agent Studio

> *As Maya, I want to go from a template to a working, tested agent connected to my team's systems without writing code. As Priya, I want everything Maya clicked to exist as a manifest I can diff, review, and promote through CI.*

| ID | Requirement | Priority |
|---|---|---|
| ST-1 | **Template gallery**: curated worker-agent templates by function (AP invoice triage, support deflection, sales research, HR onboarding, report generation, inbox triage). Instantiating a template creates a full manifest + starter eval suite. | P0 |
| ST-2 | **Guided builder**: form-based creation — role & instructions, model, tools, triggers, policy — that reads/writes the manifest. | P0 |
| ST-3 | **Code mode**: raw manifest (YAML) editing with schema validation, autocomplete, and inline docs; two-way sync with the guided builder. | P0 |
| ST-4 | **Instruction editor**: versioned prompts with variables, org style guides, and prompt diffing between versions. | P0 |
| ST-5 | **Tool attachment**: browse the MCP catalog, attach servers/tools with per-tool allow-lists and sensitivity visibility; request-access flow when a connection needs admin approval. | P0 |
| ST-6 | **Test console**: interactive chat + task runner against the draft agent with a live **trace view** (reasoning steps, tool calls with inputs/outputs, tokens, latency, cost) built on the existing Wire stream. | P0 |
| ST-7 | **Simulation mode**: run against **mock tools** (recorded or synthetic responses) and scenario scripts so agents are testable before any real connection exists. | P0 |
| ST-8 | **Batch testing**: run the agent over a dataset of test cases; view pass/fail matrix and per-case traces. | P1 |
| ST-9 | **Eval authoring**: define test cases, assertions, and rubrics in-Studio; attach a suite as the agent's promotion gate (see GV-6). | P0 |
| ST-10 | **Versioning**: every save is an immutable version; visual diff of manifest/prompts; one-click rollback of drafts. | P0 |
| ST-11 | **Collaboration**: share drafts, comment threads, and a review-request flow (reviewer sign-off recorded). | P1 |
| ST-12 | **Knowledge attachment**: attach managed knowledge bases, document-cloud sources, or BYO retrieval indexes (e.g., Azure AI Search) to an agent, with retrieval and grounding settings (see KM-1, 4, 5). | P1 |
| ST-13 | **Import/export**: import an existing agent spec from the CLI format; export any agent as a standalone manifest bundle. | P1 |
| ST-14 | **Production replay**: import any production trace into the simulator and re-run it — with the recorded tool responses — against a modified draft, so a fix is verified on the exact failing case before redeploy (pairs with CP-4). | P1 |

#### AI-assisted building — the Agent Copilot

> *As Maya, I want to describe the job in plain language — or paste our SOP — and get a working draft agent, tests included. As Omar, I want AI to speed up building without ever bypassing review.*

| ID | Requirement | Priority |
|---|---|---|
| CP-1 | **Describe-to-draft**: from a natural-language job description, a pasted SOP/runbook document, or a mined process step (PM-3), generate a complete draft — instructions, suggested tools from the org's connector catalog, triggers, safe policy defaults, and a starter eval suite. Nothing is saved without builder review. | P0 |
| CP-2 | **Conversational editing**: refine any part of the agent by chat ("escalate anything over $10k to a human"); every change is proposed as a manifest diff the builder accepts or rejects. | P0 |
| CP-3 | **Eval generation**: produce test cases, edge cases, and rubrics from the instructions, sample data, and — when available — mined process variants (§9.11); the builder curates before the suite becomes a promotion gate. | P0 |
| CP-4 | **Diagnose & fix**: on failing evals or flagged production runs, analyze the traces, explain the likely cause, and propose prompt/manifest fixes as reviewable diffs; accepted fixes auto-trigger regression (GV-7). | P1 |
| CP-5 | **Copilot guardrails**: the Copilot proposes, never disposes. It cannot attach connections, grant credentials, raise autonomy, or deploy; its output passes the same review, policy, and eval gates as human work; and its suggestions are themselves audited. | P0 |

### 9.2 Serverless Runtime & Deployment

> *As Priya, I want `sammad deploy` (or one click) to produce a versioned, isolated, scale-to-zero agent endpoint with environments, promotion gates, and instant rollback — and I never want to think about servers.*

| ID | Requirement | Priority |
|---|---|---|
| RT-1 | **One-click / one-command deploy** from Studio or CLI. Deploying = publishing a manifest version to an environment. | P0 |
| RT-2 | **Serverless execution**: per-run isolation (sandboxed), scale-to-zero, autoscaling by demand. Target cold start ≤ 2s p95 for standard agents. | P0 |
| RT-3 | **Invocation — synchronous API**: REST endpoint per agent (request/response) with OpenAPI schema derived from the manifest's declared inputs/outputs. | P0 |
| RT-4 | **Invocation — async jobs**: submit → job id → webhook/poll for completion; for long tasks. | P0 |
| RT-5 | **Invocation — schedules**: cron-style triggers defined in the manifest. | P0 |
| RT-6 | **Invocation — events**: webhook subscriptions, email-in (per-agent address/mailbox binding), and queue integrations trigger runs with payload mapping. | P1 |
| RT-7 | **Invocation — chat surfaces**: Slack / Microsoft Teams apps and an embeddable web widget bound to a deployed agent. | P1 |
| RT-8 | **Invocation — agent-to-agent**: any deployed agent callable by another agent via MCP (see MF-5), subject to both agents' policies. | P0 |
| RT-9 | **Environments & promotion**: dev/staging/prod with independent connections & secrets; promotion requires the eval gate + (configurable) human approval. | P0 |
| RT-10 | **Durable long-running runs**: checkpointing, resume after interruption, and **human-wait states** (a run can pause for days awaiting an approval or reply without burning compute). | P1 |
| RT-11 | **Canary & rollback**: percentage-based canary of a new version with automatic rollback on eval/error thresholds; instant manual rollback always available. | P1 |
| RT-12 | **Model routing**: per-agent primary/fallback models via the existing LLM gateway; provider-agnostic manifests. | P1 |
| RT-13 | **Quotas & limits**: per-agent concurrency caps, rate limits, timeout, and max-spend-per-run enforced by the runtime. | P0 |
| RT-14 | **Secrets & connections per environment** resolved at runtime from the vault — never baked into manifests. | P0 |
| RT-15 | **Invocation — process transition hooks**: bind an agent to a status change of an entity in a connected system (e.g., ticket `open → in_progress`, invoice `pending_review → approved`), **before or after** the change. *Advisory* mode annotates/enriches; *gating* mode makes the transition wait for the agent's decision, with policy-set timeout and fallback (proceed, hold, or escalate). The landing zone for mined insertion points (§9.11). | P1 |
| RT-16 | **Run reliability**: configurable retry policies with backoff; idempotency keys on triggers so replayed events never create duplicate runs; a dead-letter queue for failed runs with inspect, fix, and replay. | P1 |

### 9.3 MCP Fabric (integration layer)

> *As Priya, I want one governed gateway between all agents and all systems. As Omar, I want to know that no agent can touch anything except through it. As any external system, I want to call a Sammad agent like any other MCP tool.*

| ID | Requirement | Priority |
|---|---|---|
| MF-1 | **MCP Gateway**: all agent tool traffic flows through a central gateway providing authn/z, per-tool policy enforcement, structured logging, rate limiting, and redaction. Direct agent→system calls are not possible by construction. | P0 |
| MF-2 | **Connector catalog**: first-party MCP servers for the top enterprise systems — email/calendar, Slack/Teams, CRM, ITSM, ERP/finance, **document clouds** (SharePoint/OneDrive, Google Drive, Box, Confluence), **AI search & retrieval services** (Azure AI Search first; Elasticsearch, Vertex AI Search, Bedrock Knowledge Bases, Glean follow — see KM-4), SQL databases, and generic HTTP/API. v1 ships ≥ 10; catalog metadata includes tool list, sensitivity defaults, and auth modes. | P0 |
| MF-3 | **Bring-your-own MCP server**: register any HTTP/stdio MCP server (the existing `mcp add`/OAuth flow, promoted to org level) with an admin security-review step before workspace availability. | P0 |
| MF-4 | **Credential vault**: OAuth flows, service accounts, and API keys stored centrally; per-agent, per-environment scoped tokens; rotation and revocation. | P0 |
| MF-5 | **Agents as MCP servers**: every deployed agent automatically exposes an MCP endpoint (its declared capabilities as tools), so Claude, IDEs, iPaaS, other vendors' agents, and other Sammad agents can invoke it. This is the primary "embed into your operating model" mechanism. | P0 |
| MF-6 | **Tool-level permissioning**: allow/deny lists per agent, read-only modes, argument constraints (e.g., `send_email` restricted to internal domains), and data-scope filters. | P0 |
| MF-7 | **Connector SDK**: scaffolding, test harness, and certification checklist for building custom MCP connectors; publishable to the org catalog. | P1 |
| MF-8 | **Gateway safety layer**: schema validation of tool I/O, output size limits, and prompt-injection defenses on tool results (content flagging, provenance tagging, configurable quarantine of untrusted content). | P1 |
| MF-9 | **Marketplace**: cross-org catalog of certified connectors and agent templates from partners. | P2 |

### 9.4 Governance, Evaluation & Oversight

> *As Omar, I want to write the rules once and know they're enforced everywhere; to see everything any agent ever did; to require a quality bar before anything ships; and to stop any agent in under a minute.*

| ID | Requirement | Priority |
|---|---|---|
| GV-1 | **Policy engine**: declarative policies attached at org / workspace / agent scope, evaluated at runtime and gateway. Rule surface: allowed tools & sensitivities, autonomy level, spend caps (per run/day/month), data handling (PII redaction, residency, egress destinations), operating hours, model allow-list. | P0 |
| GV-2 | **Autonomy levels** (A0–A3, §7) enforced against per-tool **sensitivity classifications** (e.g., `read` low, `write` medium, `external send / payment / delete` high). A2 agents run free on low-sensitivity tools and pause for approval on high. | P0 |
| GV-3 | **Human-in-the-loop inbox**: a unified queue of pending approvals, escalations, and agent→human handoffs with full run context; act from web, Slack/Teams, or email. Builds on the existing `ApprovalRuntime`. SLA timers and fallback behavior (queue, deny, or escalate) are policy-configurable. | P0 |
| GV-4 | **Immutable audit log**: every run, message, tool call (with redacted payload per policy), approval decision, policy change, and deployment recorded append-only; searchable in-product; streaming export to SIEM (Splunk/Sentinel) and object storage. | P0 |
| GV-5 | **Kill switch**: pause a single agent, a workspace, or the whole fleet in ≤ 60 seconds; in-flight runs checkpoint and halt at the next tool boundary. Auto-pause triggers on anomaly: error-rate spike, spend spike, repeated policy violations. | P0 |
| GV-6 | **Eval gates (pre-deployment)**: an agent version cannot be promoted to an environment unless its attached suite passes the configured threshold; results attach to the version and appear in the promotion approval. | P0 |
| GV-7 | **Regression on change**: any change to instructions, model, tools, or policy re-runs the suite automatically; diffs against the previous version's scores. | P0 |
| GV-8 | **Continuous (online) evaluation**: sample production runs and score them with rubrics/LLM-judge; trend quality, safety, and drift per agent version; alert on degradation. | P1 |
| GV-9 | **Human review queues**: route sampled or flagged runs to reviewers; their labels feed back into eval suites as new test cases. | P1 |
| GV-10 | **Quality dashboard**: per agent and per version — eval scores, success rate, override/edit rate, incident count, cost & latency; the agent's "performance review." | P0 |
| GV-11 | **Access control**: SSO (existing Clerk/OIDC) + SCIM; roles: Admin, Builder, Reviewer, Approver, Operator, Auditor (read-only everything). | P0 |
| GV-12 | **Compliance & data controls**: retention policies per data class, right-to-delete workflows, data-residency pinning, DLP hooks at the gateway; SOC 2 evidence collection. | P1–P2 |
| GV-13 | **End-user feedback**: the people an agent serves can rate and correct its outputs from any surface — chat, the HITL inbox, or a feedback endpoint on every run id. Feedback routes to review queues (GV-9) and converts to eval cases in one click, closing the loop from complaint to test. | P1 |

### 9.5 Agent Registry & Fleet Management *(extension)*

> *As Lena, I want one inventory of every agent we run — who owns it, what it can touch, what it costs, how it's doing.*

| ID | Requirement | Priority |
|---|---|---|
| RG-1 | **Org catalog** of all agents (and connections): name, owner, description, status, environments, versions, tool scopes, eval status. Nothing deploys without an owner. | P0 |
| RG-2 | **Lifecycle states**: draft → in-review → published → deprecated → retired, with policy on each transition. | P1 |
| RG-3 | **Discovery & reuse**: search/tags; "install" a published agent or template into another workspace with connections re-bound locally. | P1 |
| RG-4 | **Fleet dashboard**: live view of all deployed agents — health, volume, queue depth, spend, incidents — with bulk actions (pause, re-run evals, upgrade model). | P1 |
| RG-5 | **Publish flow**: promoting to production publishes a registry release — semantic version, generated release notes (the manifest diff, summarized), and auto-generated consumer docs: a REST reference derived from the manifest's declared interface plus the MCP tool descriptions it exposes (MF-5). An agent isn't "done" until a stranger can consume it from its registry page. | P0 |
| RG-6 | **Consumer management & deprecation**: the registry tracks which systems, workspaces, and agents consume each release; version and deprecation notices go to consumers; minimum deprecation windows are policy-set; retirement is blocked while active consumers remain (admin override, logged). On retirement: credentials revoked, endpoints tombstoned with a pointer to the successor, runs archived per retention policy. | P1 |
| RG-7 | **Dependency graph & impact analysis**: every agent's dependencies — connections, tools, models, knowledge bases, other agents — are tracked. When a connector schema changes or a model is deprecated at the gateway, affected agents are flagged and their regression suites queued automatically (GV-7). | P1 |

### 9.6 Agent Identity & Access *(extension)*

| ID | Requirement | Priority |
|---|---|---|
| ID-1 | **Full attribution**: every downstream action is traceable to {agent, manifest version, run id, triggering principal}. Attribution headers/metadata are injected by the gateway on every tool call. | P0 |
| ID-2 | **Non-human identity**: each agent is a first-class service identity (directory-registrable), with least-privilege credentials per connection — never shared human accounts. | P1 |
| ID-3 | **Acting modes**: *service mode* (agent acts as itself) vs *on-behalf-of mode* (agent acts with the invoking user's delegated, down-scoped permissions). Mode is declared in the manifest per connection. | P1 |

### 9.7 Observability & Analytics *(extension)*

| ID | Requirement | Priority |
|---|---|---|
| OB-1 | **Full traces** for every run — steps, tool I/O (policy-redacted), model calls, tokens, latency, cost — replayable in Studio; OpenTelemetry-compatible export. | P0 |
| OB-2 | **Operational metrics & alerting**: success/error rates, p50/p95 latency, queue depth, spend; thresholds and anomaly alerts to Slack/Teams/PagerDuty/email. | P1 |
| OB-3 | **Business analytics**: tasks completed, automation/deflection rate, human-touch rate, cost per completed task, estimated hours saved — per agent and rollups per workspace. | P1 |
| OB-4 | **Cost management**: budgets at org/workspace/agent scope, forecasting, chargeback/showback reports by team. | P1–P2 |
| OB-5 | **Incident management**: alerts and auto-pauses open incident records linked to the offending runs, agent version, and audit trail — with status workflow, ownership, and postmortem notes. Incident history appears on the agent's quality dashboard (GV-10), and the standard resolution path is trace → replay (ST-14) → fix (CP-4) → regression (GV-7) → redeploy. | P1 |

### 9.8 Knowledge, Retrieval & Memory *(extension)*

> *As Deven, I want my agent grounded in our documents wherever they already live — a Sammad knowledge base, SharePoint, or the Azure AI Search index our data team already built — with citations I can check. As Omar, I want retrieval to obey the same permissions and audit as everything else.*

Two retrieval paths, one contract: **managed RAG** for teams with documents but no search infrastructure, and **bring-your-own index** for organizations that already run enterprise search. Manifests, Studio, policy, and evals treat both identically, and every retrieval call transits the MCP gateway (MF-1) like any other tool call.

| ID | Requirement | Priority |
|---|---|---|
| KM-1 | **Managed knowledge bases (managed RAG)**: create KBs from uploads or **document-cloud sync connectors** — SharePoint/OneDrive, Google Drive, Confluence, Box, S3/Azure Blob, URLs. The platform handles parsing (Office/PDF, OCR for scans), chunking, embedding, hybrid vector + keyword search with reranking, incremental sync, and **source-ACL awareness**: query-time results are trimmed to what the requesting principal may see (pairs with ID-3 on-behalf-of mode). | P1 |
| KM-2 | **Task memory**: within-run and within-thread context handled automatically (exists today via context/compaction; hardened for the serverless runtime). | P0 |
| KM-3 | **Long-term agent memory**: opt-in persistent memory per agent with retention policy, PII controls, owner review/purge UI, and full audit of reads/writes. | P2 |
| KM-4 | **Bring-your-own retrieval (BYO index)**: attach existing enterprise search services as retrieval sources through MCP retrieval connectors — **Azure AI Search first** (the native fit alongside the Azure AI Foundry-backed gateway), then Elasticsearch/OpenSearch, Google Vertex AI Search, Amazon Bedrock Knowledge Bases, and Glean. A standard retrieval-tool contract (query → passages, metadata, scores) makes managed and BYO sources interchangeable in manifests, Studio, and evals — no re-ingestion of documents already indexed elsewhere. | P1 (Azure AI Search) · P2 (others) |
| KM-5 | **Grounding & citation controls**: retrieval-backed answers carry citations to source passages; per-agent grounding policy from *blended* to *strict* (cite-or-abstain: answer only from retrieved sources or escalate); retrieval steps appear in run traces (OB-1) with retrieved passages and scores; groundedness/faithfulness is a first-class eval metric in promotion gates and online scoring (GV-6, GV-8). | P1 |

### 9.9 Orchestration & Human Collaboration *(extension)*

| ID | Requirement | Priority |
|---|---|---|
| OR-1 | **Handoffs**: agent → human (with full context package into the HITL inbox or a ticket) and agent → agent (via MF-5 / RT-8). | P1 |
| OR-2 | **Composite agents**: supervisor/worker patterns and simple sequential/parallel step graphs defined in the manifest — evolving the existing subagent (`LaborMarket`) machinery into the deployed runtime. | P1 |
| OR-3 | **External orchestrators**: first-class recipes for calling Sammad agents from Temporal, Airflow, ServiceNow, Zapier/Make, and Power Automate (per NG1 we integrate, not replace). | P1 |

### 9.10 Developer Surface: CLI, SDK, API

> *The CLI is the power-user spine of the platform — everything the Studio does, scriptable. This extends `sammad-cli` from an interactive terminal agent into the platform client.*

| ID | Requirement | Priority |
|---|---|---|
| DX-1 | **CLI verbs**: `sammad init` (scaffold manifest + eval suite), `dev` (local run with hot reload against dev connections/mocks), `test` (run eval suites, CI-friendly exit codes), `deploy`, `promote`, `logs`, `runs`, `pause/resume`, `connect` (manage MCP connections — extends the existing `mcp` group). | P0 |
| DX-2 | **Agents-as-code**: manifests, prompts, policies, and eval suites live in git; a GitHub Actions template runs `sammad test` on PR and `sammad deploy` on merge. PR review *is* agent review. | P0 |
| DX-3 | **REST API + SDKs** (Python first — extending the existing `kimi-sdk` stub — then TypeScript) with full parity: manage agents, invoke runs, read traces, query evals. | P0–P1 |
| DX-4 | **Local ↔ cloud parity**: the same manifest runs in the local CLI loop and the serverless runtime; divergences are validation errors, not surprises. | P0 |

### 9.11 Process Intelligence: mining & agent placement *(extension)*

> *As Maya, I want to drop in the event logs from our operations system, see our process as it actually runs, then point at a step and say: "put an agent here, before the status changes." As Omar, I want the same logs to prove, later, that it worked.*

This is how Sammad answers "where do agents belong in *our* operating model?" with evidence instead of intuition — and how agents get wired **into** the process, at its steps and status transitions, rather than bolted on beside it.

| ID | Requirement | Priority |
|---|---|---|
| PM-1 | **Event log ingestion**: upload logs exported from operating systems (ITSM, ERP, CRM, BPM, ticketing) as CSV or XES (IEEE 1849). Minimum schema: case id · activity/status · timestamp; optional resource and attributes. Guided column mapping and data-quality checks. Continuous sync through MCP connectors follows. | P1 upload · P2 sync |
| PM-2 | **Process discovery**: reconstruct the as-is process from the logs — the map, variant frequencies, step durations and wait times, bottlenecks, rework loops, and conformance against an expected flow. | P1 |
| PM-3 | **Opportunity scoring**: rank steps and status transitions by agent potential — a function of volume, wait-before-transition, rework rate, and human-touch cost — and recommend for each a matching template or a Copilot draft (CP-1) seeded with that step's context. | P1 |
| PM-4 | **One-click insertion**: from any discovered step or transition, create the binding — a pre-scoped transition hook (RT-15) or event trigger (RT-6) against the connected source system for that entity and status pair, in advisory or gating mode — entering the normal review → eval-gate → deploy path. | P1 |
| PM-5 | **Before/after proof**: keep mining ongoing logs after placement; compare cycle time, wait time, touch rate, rework, and cost at instrumented transitions against the pre-agent baseline. Results feed the agent's quality dashboard (GV-10) and business analytics (OB-3). | P1 |
| PM-6 | **What-if simulation**: replay historical logs with a candidate agent virtually inserted at a step to estimate impact before anything is deployed. | P2 |
| PM-7 | **Log privacy**: policy-driven pseudonymization/redaction of actor identities and PII at ingestion; residency-pinned storage; role-limited access; and **no individual performance profiling by default** — mining targets the process, not the person. | P1 (ships with PM-1) |

---

## 10. Non-functional requirements

| Area | Requirement |
|---|---|
| **Security** | Tenant isolation at data and execution layers; sandboxed tool execution; encryption in transit and at rest; secrets only in the vault; no provider keys on clients (existing gateway model); regular pen testing. |
| **Reliability** | Control plane 99.9%; runtime invocation success 99.5% (excluding downstream/tool failures); async runs are durable — no run silently lost; graceful degradation when a connector is down (queue + notify). |
| **Performance** | Cold start ≤ 2s p95; sync invocation overhead (platform-added latency) ≤ 500ms p95; trace availability ≤ 5s after run completion. |
| **Scalability** | Design target: 1,000 agents and 10,000 concurrent runs per org without architectural change. |
| **Data** | Regional residency options (start: EU, US, GCC given current footprint); per-class retention; deletion SLAs; customer data never used for cross-tenant training. |
| **Compatibility** | MCP spec-current; OpenTelemetry traces; SAML/OIDC + SCIM; export of manifests, logs, evals in open formats. |
| **Usability** | Maya-path (Copilot draft or template → connected → tested) achievable in < 30 minutes; WCAG 2.1 AA for Studio; English first, RTL/Arabic localization P1 (relevant to the GCC market). |

---

## 11. Success metrics

| Category | Metric | Target (12 months post-GA) |
|---|---|---|
| Activation | Time from signup to first deployed agent | < 1 day median; < 30 min for template path |
| Adoption | Orgs with ≥ 3 agents in prod ≥ 30 days | 60% of active orgs |
| Quality | Versions promoted through eval gates (vs. overridden) | > 95% gated |
| Quality | Human override/edit rate on A2–A3 agents | Declining trend per agent cohort |
| Safety | Runs fully audited / attributable | 100% (hard invariant) |
| Safety | Mean time to pause an agent after anomaly | < 1 minute |
| Integration | Agents invoked via MCP by external systems | > 30% of prod agents embedded externally |
| Economics | Cost per completed task visible & trending down per agent | 100% coverage |
| Retention | Builder weekly retention (Studio or CLI) | > 40% |
| Building | New agents that start from a Copilot draft (CP-1) | > 50% |
| Placement | Production agents bound to steps/transitions found via process mining | > 25% |
| Impact | Median cycle-time reduction at agent-instrumented transitions (re-mined, PM-5) | ≥ 20% |
| Operations | Median time from incident opened to replay-verified fix live in production | < 1 business day |

---

## 12. Release plan

**Phase 1 — MVP (target: one quarter).** The full vertical slice, thin: manifest v1 + Studio (ST-1..7, 9, 10) + Agent Copilot (CP-1..3, 5) + serverless runtime with sync/async/schedule/agent-to-agent invocation (RT-1..5, 8, 9, 13, 14) + MCP gateway with 10 connectors, BYO servers, vault, and agents-as-MCP (MF-1..6) + governance core (GV-1..7, 10, 11; RG-1, 5; ID-1; OB-1) + CLI/CI parity (DX-1, 2, 4). **Exit:** 5 design partners each running ≥ 3 production agents through eval gates for 30 days.

**Phase 2 — Embed & trust (quarters 2–3).** Event/chat invocation (RT-6, 7), **process intelligence v1** — log upload, discovery, opportunity scoring, one-click insertion via transition hooks, and before/after measurement (PM-1..5, 7; RT-15) — durable runs & canary (RT-10, 11), online evals + review queues (GV-8, 9), Copilot diagnose-and-fix (CP-4), **lifecycle ops** — production replay, retries & dead-letter queue, incident management, end-user feedback, consumer & deprecation management, dependency impact analysis (ST-14; RT-16; OB-5; GV-13; RG-6, 7) — fleet dashboard (RG-2..4), knowledge & retrieval — managed KBs with document-cloud sync, Azure AI Search BYO, grounding controls (KM-1, 4, 5) — connector SDK (MF-7, 8), observability & alerting (OB-2, 3), agent identity modes (ID-2, 3), orchestrator recipes (OR-1..3), TS SDK, Arabic/RTL.

**Phase 3 — Scale & ecosystem.** Long-term memory (KM-3), what-if process simulation and continuous log sync (PM-6; PM-1 sync), remaining BYO retrieval connectors (KM-4: Elasticsearch, Vertex, Bedrock, Glean), cost chargeback (OB-4), compliance packs & residency expansion (GV-12), marketplace (MF-9), VPC/BYO-cloud deployment tier, advanced anomaly detection.

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Governance friction kills adoption (approvals everywhere → nobody ships) | Safe-but-fast defaults; autonomy levels concentrate friction on sensitive tools only; approval UX in Slack/Teams; SLA fallbacks. |
| Prompt injection / data exfiltration via tool results | Single gateway choke point (MF-1) + MF-8 defenses; egress destination policies; sensitivity-gated approvals for external sends; red-team eval suites shipped with templates. |
| Model quality variance breaks agents silently | Eval gates + regression on every change (GV-6, 7); online evals (GV-8); model routing with fallbacks (RT-12). |
| Connector sprawl becomes an unbounded cost center | MCP standard + BYO servers + connector SDK; first-party effort capped at the top-10 systems; partner/marketplace path. |
| Runaway spend | Scale-to-zero; caps at run/agent/workspace/org; quota already enforced at token mint in the control plane; auto-pause on spend anomaly. |
| Enterprise lock-in fear blocks procurement | Open manifest spec, MCP everywhere, OTel traces, full export (§6.6). |
| Upstream fork drift (Kimi CLI is winding down toward Kimi Code) | Documented rebase procedure exists; decide by end of Phase 1 whether to track upstream's successor or hard-fork the agent core (open question Q6). |
| Copilot-drafted agents ship subtle errors at scale | Copilot proposes diffs only and can never deploy (CP-5); eval gates remain mandatory (GV-6); generated eval suites are human-curated (CP-3); Copilot activity is itself audited. |
| Process mining exposes sensitive workforce data (PII, inferred individual performance) | Pseudonymization at ingestion and no individual profiling by default (PM-7); role-limited access; residency pinning; documented purpose limitation for DPO / works-council review. |
| Retrieval surfaces documents a requester shouldn't see (over-broad indexes, stale ACLs) | Source-ACL-aware sync and query-time permission trimming (KM-1, ID-3); every retrieval call transits the gateway, so scopes, redaction, and audit apply (MF-1); strict grounding with citations makes any leakage visible and reviewable (KM-5). |

---

## 14. Open questions

1. **Pricing** — platform fee + per-run metering, per-deployed-agent seats, or hybrid? (Stripe rails exist in the control plane.)
2. **BYO model keys** — allow tenants to attach their own provider/Foundry deployments through the gateway at launch, or gateway-only?
3. **Naming** — unify `sammad` vs `sanad` across repo, CLI binary, docs, and domain before public beta.
4. **Workflow depth** — how far does OR-2 go before violating NG1? Proposal: step graphs stay ≤ 10 nodes; beyond that, push to external orchestrators.
5. **Agent identity standard** — align ID-2 with SPIFFE/workload identity or directory-native service accounts first?
6. **Fork strategy** — track Kimi Code (upstream successor) or freeze and own the agent core?
7. **Compliance sequencing** — SOC 2 Type II timing vs. GCC-specific regimes (e.g., SDAIA/PDPL) given initial market.
8. **Mining build-vs-bridge** — build process discovery natively (PM-2), or first ship import bridges from established mining tools (Celonis, UiPath, SAP Signavio) and concentrate our build on insertion (PM-4) and measurement (PM-5)?
9. **Managed-RAG substrate** — build our own vector store for KM-1, or implement managed knowledge bases *on* Azure AI Search given the existing Foundry footprint (one substrate serving both the managed and BYO paths)?

---

## Appendix A — Example Worker Agent manifest (v1 draft)

```yaml
apiVersion: sammad/v1
kind: WorkerAgent
metadata:
  name: invoice-triage
  owner: finance-ops@acme.example
  description: Validates incoming invoices against POs; routes exceptions to AP.
  labels: [finance, back-office]
spec:
  model:
    primary: gateway/gpt-5.2
    fallback: gateway/claude-sonnet-4-6
  instructions: ./prompts/invoice-triage.md      # versioned with the manifest
  tools:
    - connection: erp
      allow: [get_purchase_order, get_vendor, create_ap_hold]
    - connection: email
      allow: [read_inbox, send_reply]
      constraints: { send_reply: { to_domain: [acme.example] } }
      sensitivity: high            # pauses for approval below autonomy A3
  knowledge:
    - source: kb://finance/ap-policy                    # managed KB (KM-1)
    - source: search://azure-ai-search/contracts-idx    # BYO index via MCP (KM-4)
      grounding: strict                                 # cite-or-abstain (KM-5)
  triggers:
    - type: email
      mailbox: ap-inbox@acme.example
    - type: schedule
      cron: "0 7 * * MON-FRI"
    - type: transition             # process hook (RT-15, §9.11)
      connection: erp
      entity: invoice
      before: { from: pending_review, to: approved }
      mode: gating                 # the status change waits for this agent's decision
  interface:                       # exposed via REST + MCP when deployed
    inputs:  { invoice_pdf: file, po_number: string? }
    outputs: { decision: enum[approve, hold, escalate], summary: string }
  policy:
    autonomy: A2
    budget: { usd_per_day: 25 }
    data: { pii: redact, residency: eu }
  evaluation:
    gate: suites/invoice-triage-core   # promote only if pass_rate >= 0.95
```

## Appendix B — Example policy

```yaml
apiVersion: sammad/v1
kind: Policy
metadata: { name: finance-baseline, scope: workspace/finance }
rules:
  - match: { tool.sensitivity: high }
    effect: require_approval          # routes to HITL inbox (GV-3)
  - match: { spend.usd_per_run: "> 2.00" }
    effect: deny
  - match: { data.egress.destination: { not_in: [erp, email] } }
    effect: deny
  - match: { time: { outside: business_hours("Asia/Riyadh") } }
    effect: queue_until_open
```

## Appendix C — Glossary

**MCP** — Model Context Protocol; the open standard for connecting AI systems to tools and data, used here both for agents consuming tools and for exposing agents. **HITL** — human-in-the-loop. **Manifest** — the versioned YAML definition of a worker agent. **Eval gate** — the evaluation-suite threshold an agent version must pass to be promoted. **Fabric/Gateway** — the governed MCP proxy all tool traffic traverses. **Fleet** — all deployed agents in an organization.
