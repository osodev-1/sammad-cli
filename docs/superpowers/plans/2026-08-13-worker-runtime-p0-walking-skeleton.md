# Worker Runtime P0 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a worker-agent bundle to a workspace machine and invoke it synchronously as an ephemeral, budgeted, traced run — `sanad deploy` → `POST /invoke` → NDJSON stream → run row + S3 trace — with `sanad dev` running the identical assembly locally.

**Architecture:** Control plane (sanad-web) gains agent/deployment/run tables, invoke tokens, and an invoke route that wakes the workspace machine and proxies its NDJSON; the machine (terminal-server) gains a worker mode whose `RunRunner` (a `WireRunner` sibling) spawns one wire subprocess per run with per-run dirs; the CLI gains a `kimi_cli/worker/` assembly module (interface sidecar → derived agent spec + injected `ReturnOutput` tool) used by both `sanad dev` and the cloud runner.

**Tech Stack:** Python 3.12+/FastAPI/httpx/pydantic (terminal-server), Python/typer (CLI), Next.js 15/Drizzle/Neon/Vitest (sanad-web). Spec: [2026-08-13-worker-runtime-design.md](../specs/2026-08-13-worker-runtime-design.md)

## Global Constraints

- **Commits are Omar-only** — repo convention `sanad: <lowercase description>`. NEVER add `Co-Authored-By`, `Generated with`, or any Claude/AI attribution to any commit. Never `git add -A` — stage listed files explicitly.
- **Branch:** implementation lands on `worker-runtime-p0` cut from `main`. (This plan + its spec live on `worker-agents-prd`.)
- **Fail-closed:** worker mode ships default-off — `WORKER_ENABLED` unset ⇒ every `/internal/worker/*` route 404s `{"error":{"code":"worker_disabled",...}}` (mirror of `CODER_ENABLED`).
- **Python:** run everything via `uv run` from `/Users/omar/Development/sammad-cli`; ruff line length 100; `pytest.ini` sets `asyncio_mode = auto` (bare `async def test_*` works).
- **sanad-web:** run tests via `pnpm -C control-plane/artifacts/sanad-web test` (vitest); after any `lib/db/schema.ts` change run `pnpm -C control-plane/artifacts/sanad-web db:generate` and commit the emitted `drizzle/` migration with the schema.
- **Per-run env is built from scratch** (`build_child_env` pattern) — never copy `os.environ` into a child.
- **IDs:** run ids are `r_<12 hex>` (server-minted only, mirror of `c_<12 hex>` conversation ids). Content hashes are sha256 hex.
- **New env vars introduced by this plan:** `WORKER_ENABLED`, `WORKER_MAX_TURN_SECONDS` (default 900), `WORKER_MAX_STEPS_PER_TURN` (default 100), `WORKER_MAX_TOKENS_PER_RUN` (default 2000000), `KEEP_WARM`, `SANAD_RUNS_BUCKET`, `CRON_SECRET`, `KIMI_WORKER_INTERFACE_FILE`, `KIMI_WORKER_OUTPUT_FILE`.

---

## File structure

```
control-plane/artifacts/sanad-web/
  lib/db/schema.ts                     # + workspaces, agents, agentVersions, deployments, runs, invokeTokens
  lib/tokens/invoke.ts                 # NEW — itok_ mint/verify (clone of runtime.ts pattern)
  lib/agents/registry.ts              # NEW — agent/version/deployment CRUD + owner rules
  lib/compute/machines.ts             # NEW — ensureWorkspaceMachine (generalizes sessions.ts)
  lib/runs/store.ts                   # NEW — run insert/complete/list + cost rollup
  lib/runs/reaper.ts                  # NEW — sweepLostRuns
  lib/models/catalog.ts               # + MODEL_PRICING
  app/api/v1/agents/route.ts          # NEW — upsert/list agents
  app/api/v1/agents/[name]/versions/route.ts      # NEW
  app/api/v1/agents/[name]/deployments/route.ts   # NEW (+ pause/resume subroutes)
  app/api/v1/agents/[name]/invoke/route.ts        # NEW — the sync invoke proxy
  app/api/v1/agents/[name]/tokens/route.ts        # NEW — itok mint
  app/api/v1/runs/route.ts            # NEW — list
  app/api/v1/runs/[id]/route.ts       # NEW — get
  app/api/v1/runs/[id]/trace/route.ts # NEW — presigned GET redirect
  app/api/v1/runs/[id]/complete/route.ts          # NEW — machine-token ingest
  app/api/internal/cron/reap-runs/route.ts        # NEW — CRON_SECRET-gated
  app/api/v1/agents/[name]/openapi.json/route.ts  # NEW — typed invoke schema (RT-3)
  lib/agents/openapi.ts                # NEW — buildAgentOpenApi
  app/(dashboard)/agents/…             # NEW — minimal list + agent pages
src/kimi_cli/
  worker/__init__.py                  # NEW — public surface: WorkerSpec, assemble_run, RunAssembly
  worker/sidecar.py                   # NEW — worker.yaml schema + loader
  worker/assembly.py                  # NEW — derived agent spec + input prompt rendering
  worker/return_output.py            # NEW — the ReturnOutput tool
  soul/toolset.py                     # + KimiToolset.request_stop_turn()
  cli/worker.py                       # NEW — dev/deploy/runs/logs/pause/resume commands
  cli/_lazy_group.py                  # + "agent" lazy group entry
  sanad/client.py                     # + deploy/runs/trace/pause/resume methods
terminal-server/src/sanad_terminal/
  settings.py                         # + worker_* fields, keep_warm
  run_runner.py                       # NEW — RunRunner + registry
  routes_worker.py                    # NEW — /internal/worker/*
  control_plane.py                    # + report_run_completion
  app.py                              # + router include, WorkerDisabled handler, keep_warm probe
tests: terminal-server/tests/test_run_runner.py, test_routes_worker.py,
       tests/worker/test_sidecar.py, test_assembly.py, test_return_output.py,
       tests_e2e/test_worker_dev.py, test_worker_parity.py,
       sanad-web tests/unit/{invoke-tokens,agent-registry,run-cost,run-reaper}.test.ts
```

Dependency additions: sanad-web `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (presigned PUT/GET — workers upload traces with httpx, no boto3 anywhere).

---

### Task 1: Control-plane schema — workspaces, agents, versions, deployments, runs, invoke tokens

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/db/schema.ts` (append after `workspaceSessions`, ~line 197)
- Create: `control-plane/artifacts/sanad-web/drizzle/` migration via `db:generate`
- Test: `control-plane/artifacts/sanad-web/tests/unit/worker-schema.test.ts`

**Interfaces:**
- Produces: exported Drizzle tables `workspaces, agents, agentVersions, deployments, runs, invokeTokens` with the exact columns below. Every later sanad-web task imports these from `@/lib/db/schema`.

- [ ] **Step 1: Write the failing test** (imports + shape assertions keep the columns honest)

```ts
// tests/unit/worker-schema.test.ts
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  workspaces, agents, agentVersions, deployments, runs, invokeTokens,
} from "@/lib/db/schema";

describe("worker runtime schema", () => {
  it("agents require an owner and a workspace", () => {
    const cols = getTableColumns(agents);
    expect(cols.ownerUserId.notNull).toBe(true);
    expect(cols.workspaceId.notNull).toBe(true);
  });
  it("runs carry attribution and idempotency", () => {
    const cols = getTableColumns(runs);
    for (const k of ["deploymentId", "agentVersionId", "status", "triggerPrincipal"])
      expect(cols[k].notNull, k).toBe(true);
    expect(cols.idempotencyKey.notNull).toBe(false);
  });
  it("invoke tokens are scoped to agent+env", () => {
    const cols = getTableColumns(invokeTokens);
    expect(cols.agentId.notNull).toBe(true);
    expect(cols.env.notNull).toBe(true);
    expect(cols.tokenHash.isUnique).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/worker-schema.test.ts`
Expected: FAIL — `workspaces` has no export.

- [ ] **Step 3: Append the tables to `lib/db/schema.ts`** (style matches `cliSessions`/`workspaceSessions`: `text()` PKs, inline `.unique()`, soft strings where attribution must survive deletes)

```ts
// -- worker runtime (P0) ------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(), // ws_<uuid>
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  keepWarm: boolean("keep_warm").default(false).notNull(),
  budgetUsdMonth: integer("budget_usd_month"), // null = uncapped in P0
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // ag_<uuid>
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(), // unique per workspace, enforced in registry.ts
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  status: text("status").default("active").notNull(), // "active" | "orphaned"
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agentVersions = pgTable("agent_versions", {
  id: text("id").primaryKey(), // av_<uuid>
  agentId: text("agent_id").notNull().references(() => agents.id),
  contentHash: text("content_hash").notNull(), // sha256 of canonical bundle JSON
  bundle: jsonb("bundle").notNull(), // { files: { "agent.yaml": "...", "worker.yaml": "...", ... } }
  createdBy: text("created_by").notNull(), // soft user id
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const deployments = pgTable("deployments", {
  id: text("id").primaryKey(), // dp_<uuid>
  agentId: text("agent_id").notNull().references(() => agents.id),
  agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
  env: text("env").notNull(), // "dev" | "prod"
  status: text("status").default("active").notNull(), // "active" | "paused"
  maxTurnSeconds: integer("max_turn_seconds").default(900).notNull(),
  maxStepsPerTurn: integer("max_steps_per_turn").default(100).notNull(),
  maxTokensPerRun: integer("max_tokens_per_run").default(2000000).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(), // r_<12 hex> — also the kimi session id on the machine
  deploymentId: text("deployment_id").notNull().references(() => deployments.id),
  agentVersionId: text("agent_version_id").notNull(),
  status: text("status").default("queued").notNull(),
  // "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost"
  errorCode: text("error_code"), // e.g. "no_output" | "turn_budget_exceeded"
  triggerPrincipal: text("trigger_principal").notNull(), // "itok:<tokenId>" | "user:<id>"
  idempotencyKey: text("idempotency_key"),
  output: jsonb("output"), // the ReturnOutput document (or {"text": ...})
  tokensIn: integer("tokens_in").default(0).notNull(),
  tokensOut: integer("tokens_out").default(0).notNull(),
  costUsdMicros: integer("cost_usd_micros").default(0).notNull(),
  modelAlias: text("model_alias"),
  traceUploaded: boolean("trace_uploaded").default(false).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const invokeTokens = pgTable("invoke_tokens", {
  id: text("id").primaryKey(), // tokenId — a UUID
  tokenHash: text("token_hash").notNull().unique(),
  familyId: text("family_id").notNull(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  env: text("env").notNull(),
  orgId: text("org_id").notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Also add a unique idempotency index — drizzle inline style used elsewhere is `.unique()`, but this one is composite, so append at the bottom of the file:

```ts
import { uniqueIndex } from "drizzle-orm/pg-core"; // add to the existing pg-core import

export const runsIdempotency = uniqueIndex("runs_deployment_idem_uq").on(
  runs.deploymentId,
  runs.idempotencyKey
);
```

*(drizzle-kit emits it as `CREATE UNIQUE INDEX ... WHERE idempotency_key IS NOT NULL` is NOT automatic — Postgres unique indexes treat NULLs as distinct, which is exactly the behavior we want: null keys never collide.)*

- [ ] **Step 4: Generate the migration and run the test**

Run: `pnpm -C control-plane/artifacts/sanad-web db:generate && pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/worker-schema.test.ts`
Expected: a new file under `drizzle/`; test PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/artifacts/sanad-web/lib/db/schema.ts control-plane/artifacts/sanad-web/drizzle control-plane/artifacts/sanad-web/tests/unit/worker-schema.test.ts
git commit -m "sanad: worker runtime schema — workspaces, agents, versions, deployments, runs, invoke tokens"
```

---

### Task 2: Invoke tokens — `lib/tokens/invoke.ts`

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/tokens/invoke.ts`
- Test: `control-plane/artifacts/sanad-web/tests/unit/invoke-tokens.test.ts`

**Interfaces:**
- Consumes: `invokeTokens, agents` (Task 1); `newToken/hashToken` from `@/lib/auth/tokens`; `requireEntitled` from `@/lib/auth/entitlement`; `assertWithinQuota` from `@/lib/billing/quota`.
- Produces:
  - `mintInvoke(session: {userId: string; orgId: string}, agentId: string, env: "dev" | "prod"): Promise<{token: string; tokenId: string; expiresAt: Date}>` — token prefix `itok`, TTL 90 days (`INVOKE_TTL_MS = 90 * 24 * 3600 * 1000`), entitlement + quota checked at mint.
  - `verifyInvokeBearer(request: Request): Promise<InvokeTokenInfo | null>` where `InvokeTokenInfo = {tokenId: string; agentId: string; env: string; orgId: string}` — null on missing/revoked/expired; touches nothing.
  - `revokeInvokeFamily(familyId: string): Promise<void>`

- [ ] **Step 1: Write the failing test** — mirror the `vi.mock("@/lib/db", ...)` style of `tests/unit/logout-runtime-cascade.test.ts:1-27`:

```ts
// tests/unit/invoke-tokens.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: any[] = [];
const selectResult: { rows: any[] } = { rows: [] };
vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(async (v: any) => { inserted.push(v); }) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => selectResult.rows) })) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })),
  },
}));
vi.mock("@/lib/auth/entitlement", () => ({ requireEntitled: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/billing/quota", () => ({ assertWithinQuota: vi.fn(async () => {}) }));

import { mintInvoke, verifyInvokeBearer } from "@/lib/tokens/invoke";
import { hashToken } from "@/lib/auth/tokens";

beforeEach(() => { inserted.length = 0; selectResult.rows = []; });

describe("invoke tokens", () => {
  it("mints an itok_ token hashed at rest, scoped to agent+env", async () => {
    const out = await mintInvoke({ userId: "u1", orgId: "o1" }, "ag_1", "prod");
    expect(out.token.startsWith("itok_")).toBe(true);
    expect(inserted[0].tokenHash).toBe(hashToken(out.token));
    expect(inserted[0].agentId).toBe("ag_1");
    expect(inserted[0].env).toBe("prod");
  });
  it("verify returns null without a bearer", async () => {
    const req = new Request("https://x.test/", { headers: {} });
    expect(await verifyInvokeBearer(req)).toBeNull();
  });
  it("verify resolves a live token row", async () => {
    selectResult.rows = [{
      id: "tid", agentId: "ag_1", env: "prod", orgId: "o1",
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
    }];
    const req = new Request("https://x.test/", { headers: { authorization: "Bearer itok_abc" } });
    expect(await verifyInvokeBearer(req)).toEqual({
      tokenId: "tid", agentId: "ag_1", env: "prod", orgId: "o1",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/invoke-tokens.test.ts`
Expected: FAIL — cannot resolve `@/lib/tokens/invoke`.

- [ ] **Step 3: Implement `lib/tokens/invoke.ts`** (clone `lib/tokens/runtime.ts` shape — same imports, same guard order):

```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { invokeTokens } from "../db/schema";
import { newToken, hashToken } from "../auth/tokens";
import { requireEntitled } from "../auth/entitlement";
import { assertWithinQuota } from "../billing/quota";
import { EntitlementError } from "./runtime";

const INVOKE_TTL_MS = 90 * 24 * 3600 * 1000;

export interface InvokeTokenInfo {
  tokenId: string;
  agentId: string;
  env: string;
  orgId: string;
}

export async function mintInvoke(
  session: { userId: string; orgId: string },
  agentId: string,
  env: "dev" | "prod"
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  const ent = await requireEntitled(session.orgId, session.userId);
  if (!ent.ok) throw new EntitlementError(ent.reason);
  await assertWithinQuota(session.orgId);

  const token = newToken("itok");
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVOKE_TTL_MS);
  await db.insert(invokeTokens).values({
    id: tokenId,
    tokenHash: hashToken(token),
    familyId: newToken("ifam"),
    agentId,
    env,
    orgId: session.orgId,
    createdBy: session.userId,
    expiresAt,
  });
  return { token, tokenId, expiresAt };
}

export async function verifyInvokeBearer(request: Request): Promise<InvokeTokenInfo | null> {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer (itok_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const rows = await db
    .select()
    .from(invokeTokens)
    .where(
      and(
        eq(invokeTokens.tokenHash, hashToken(m[1])),
        isNull(invokeTokens.revokedAt),
        gt(invokeTokens.expiresAt, new Date())
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { tokenId: row.id, agentId: row.agentId, env: row.env, orgId: row.orgId };
}

export async function revokeInvokeFamily(familyId: string): Promise<void> {
  await db
    .update(invokeTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(invokeTokens.familyId, familyId), isNull(invokeTokens.revokedAt)));
}
```

*(If `EntitlementError` is not exported from `lib/tokens/runtime.ts`, export it there — it already exists at its top.)*

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/invoke-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add control-plane/artifacts/sanad-web/lib/tokens/invoke.ts control-plane/artifacts/sanad-web/tests/unit/invoke-tokens.test.ts
git commit -m "sanad: invoke tokens — itok mint/verify scoped to agent+env, quota at mint"
```

---

### Task 3: Agent registry — CRUD, owner rules, bundle versions

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/agents/registry.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/agents/route.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/versions/route.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/deployments/route.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/tokens/route.ts`
- Test: `control-plane/artifacts/sanad-web/tests/unit/agent-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 tables; `verifyBearer` from `@/lib/auth/session` (CLI session auth); `ok/err` from `@/lib/http/envelope`; `mintInvoke` (Task 2).
- Produces (registry.ts, all workspace-scoped by the caller's org):
  - `ensureWorkspace(orgId: string, name: string): Promise<{id: string}>` — get-or-create by `(orgId, name)`; default workspace name is `"default"`.
  - `upsertAgent(p: {orgId: string; workspaceName: string; name: string; ownerUserId: string; description?: string}): Promise<{id: string}>`
  - `createVersion(p: {agentId: string; files: Record<string, string>; createdBy: string}): Promise<{id: string; contentHash: string}>` — `contentHash = sha256(JSON.stringify(files, Object.keys(files).sort()))`.
  - `createDeployment(p: {agentId: string; versionId: string; env: "dev" | "prod"}): Promise<{id: string}>` — **throws `OwnerRequiredError` if the agent's status is `"orphaned"`** (message `agent has no active owner`).
  - `setDeploymentStatus(agentId: string, env: string, status: "active" | "paused"): Promise<void>`
  - `getAgentByName(orgId: string, name: string)`, `getActiveDeployment(agentId: string, env: string)` — row lookups used by Task 5.
  - `class OwnerRequiredError extends Error { code = "owner_required" }`
- Route contract (all authed with `verifyBearer`, envelope `ok/err`):
  - `POST /api/v1/agents` body `{name, workspace?, description?}` → owner = caller; `GET` → list org agents.
  - `POST /api/v1/agents/{name}/versions` body `{files}` → `{versionId, contentHash}`.
  - `POST /api/v1/agents/{name}/deployments` body `{versionId, env}` → `{deploymentId}`; `409 owner_required` when orphaned; `PATCH` body `{env, status}` for pause/resume.
  - `POST /api/v1/agents/{name}/tokens` body `{env}` → `{token, tokenId, expiresAt}` (the only time the itok plaintext is shown).

- [ ] **Step 1: Write the failing test** for the pure rules (hash determinism + orphan gate), mocking `@/lib/db` as in Task 2:

```ts
// tests/unit/agent-registry.test.ts
import { describe, it, expect, vi } from "vitest";

const state: { agentRow: any } = { agentRow: { id: "ag_1", status: "active" } };
vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(async () => {}), onConflictDoNothing: vi.fn() })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [state.agentRow]) })) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })),
  },
}));

import { bundleContentHash, createDeployment, OwnerRequiredError } from "@/lib/agents/registry";

describe("agent registry", () => {
  it("bundle hash is key-order independent", () => {
    expect(bundleContentHash({ b: "2", a: "1" })).toBe(bundleContentHash({ a: "1", b: "2" }));
  });
  it("deploying an orphaned agent throws owner_required", async () => {
    state.agentRow = { id: "ag_1", status: "orphaned" };
    await expect(
      createDeployment({ agentId: "ag_1", versionId: "av_1", env: "dev" })
    ).rejects.toBeInstanceOf(OwnerRequiredError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/agent-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/agents/registry.ts`.** Key excerpts (the CRUD around them is conventional Drizzle in the same style as Task 2):

```ts
import { createHash } from "crypto";

export class OwnerRequiredError extends Error {
  readonly code = "owner_required";
  constructor() { super("agent has no active owner"); }
}

export function bundleContentHash(files: Record<string, string>): string {
  const canonical = JSON.stringify(files, Object.keys(files).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export async function createDeployment(p: {
  agentId: string; versionId: string; env: "dev" | "prod";
}): Promise<{ id: string }> {
  const rows = await db.select().from(agents).where(eq(agents.id, p.agentId)).limit(1);
  const agent = rows[0];
  if (!agent) throw new Error("agent not found");
  if (agent.status === "orphaned") throw new OwnerRequiredError();
  const id = `dp_${crypto.randomUUID()}`;
  await db.insert(deployments).values({
    id, agentId: p.agentId, agentVersionId: p.versionId, env: p.env,
  });
  return { id };
}
```

Ids: `ws_`/`ag_`/`av_`/`dp_` + `crypto.randomUUID()`. `upsertAgent` enforces per-workspace name uniqueness with a select-then-insert (single-replica control plane — same documented assumption as `ensureInFlight` in `lib/compute/sessions.ts:286-291`).

- [ ] **Step 4: Implement the four route files.** Follow `app/api/v1/runtime-tokens/route.ts:1-36` verbatim as the template: `verifyBearer` → 401 envelope; try/catch mapping `OwnerRequiredError` → `err(409, "owner_required", e.message)`; `EntitlementError`/`QuotaExceededError` → the same 402/403 mapping that file uses.

- [ ] **Step 5: Run the tests, then typecheck**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/agent-registry.test.ts && pnpm -C control-plane/artifacts/sanad-web exec tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add control-plane/artifacts/sanad-web/lib/agents control-plane/artifacts/sanad-web/app/api/v1/agents control-plane/artifacts/sanad-web/tests/unit/agent-registry.test.ts
git commit -m "sanad: agent registry — upsert/versions/deployments with owner-required gate, itok route"
```

---

### Task 4: Workspace machines — `ensureWorkspaceMachine`

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/db/schema.ts` (append `workspaceMachines`)
- Create: `control-plane/artifacts/sanad-web/lib/compute/machines.ts`
- Test: `control-plane/artifacts/sanad-web/tests/unit/workspace-machines.test.ts`

**Interfaces:**
- Consumes: `awsComputeConfig()` from `@/lib/compute/aws`; `deriveMachineToken` from `@/lib/compute/tokens`; the private helpers of `lib/compute/sessions.ts` (`ensureAccessPoint`, `registerTaskDefinition`, `runWorkspaceTask`, `waitForRunning`, `waitForAgentd`) — **export them from sessions.ts** rather than duplicating.
- Produces:
  - `machineHash(workspaceId: string, env: string): string` — `sha256("wm:" + workspaceId + ":" + env).slice(0, 12)` (the `wm:` prefix keeps worker hashes from ever colliding with user-session hashes in the router namespace).
  - `ensureWorkspaceMachine(workspaceId: string, env: string, opts: {keepWarm: boolean}): Promise<MachineTarget>` where `MachineTarget = {machineId: string; hash12: string; baseUrl: string; agentdToken: string; coldStart: boolean}` — same wake state machine as `ensureSessionTask` (in-flight dedupe map, warm attach via `/healthz`, cold path task-run), with task env additionally carrying `WORKER_ENABLED=1` and `KEEP_WARM=1|0`.
  - `machineIpByHash(hash12: string): Promise<string | null>` — consumed by the existing `/api/v1/compute/route` handler (add the `workspaceMachines` lookup after `sessionIpByHash`, before the legacy fallback).

- [ ] **Step 1: Write the failing test** (pure parts only — hash shape/stability and namespace separation; AWS paths are integration-tested in staging):

```ts
// tests/unit/workspace-machines.test.ts
import { describe, it, expect } from "vitest";
import { machineHash } from "@/lib/compute/machines";
import { sessionHash } from "@/lib/compute/tokens";

describe("machineHash", () => {
  it("is 12 hex chars and stable", () => {
    const h = machineHash("ws_1", "prod");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(machineHash("ws_1", "prod")).toBe(h);
  });
  it("differs per env and never collides with user-session hashing", () => {
    expect(machineHash("ws_1", "dev")).not.toBe(machineHash("ws_1", "prod"));
    expect(machineHash("u1", "s1")).not.toBe(sessionHash("u1", "s1"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/workspace-machines.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the `workspaceMachines` table** to `schema.ts` (mirror `workspaceSessions:179-197` exactly, keyed differently):

```ts
export const workspaceMachines = pgTable("workspace_machines", {
  id: text("id").primaryKey(), // wm_<uuid>
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  env: text("env").notNull(),
  hash12: text("hash12").notNull().unique(),
  efsAccessPointId: text("efs_access_point_id").notNull(),
  taskArn: text("task_arn"),
  taskIp: text("task_ip"),
  runNonce: text("run_nonce"),
  imageRef: text("image_ref").notNull(),
  state: text("state").notNull(), // "provisioning" | "ready" | "error"
  keepWarm: boolean("keep_warm").default(false).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Run `pnpm -C control-plane/artifacts/sanad-web db:generate` and commit the migration with this task.

- [ ] **Step 4: Implement `lib/compute/machines.ts`.** Structure (the bodies of the wake steps are the exported sessions.ts helpers):

```ts
import { createHash } from "crypto";

export function machineHash(workspaceId: string, env: string): string {
  return createHash("sha256").update(`wm:${workspaceId}:${env}`).digest("hex").slice(0, 12);
}

const ensureInFlight = new Map<string, Promise<MachineTarget>>();

export function ensureWorkspaceMachine(
  workspaceId: string,
  env: string,
  opts: { keepWarm: boolean }
): Promise<MachineTarget> {
  const key = `${workspaceId}:${env}`;
  const existing = ensureInFlight.get(key);
  if (existing) return existing;
  const run = ensureInner(workspaceId, env, opts).finally(() => ensureInFlight.delete(key));
  ensureInFlight.set(key, run);
  return run;
}
```

`ensureInner`: select/insert the `workspaceMachines` row → `ensureAccessPoint(hash12)` → if `taskIp` set, warm-probe `waitForAgentd(baseUrl)` with a short 5s budget → recycle on stale `imageRef` → cold path `registerTaskDefinition` + `runWorkspaceTask` with env `{AGENTD_TOKEN, MACHINE_NONCE, WORKER_ENABLED: "1", KEEP_WARM: opts.keepWarm ? "1" : "0"}` → `waitForRunning` → publish `taskIp` → `waitForAgentd`. `agentdToken = deriveMachineToken(workspaceId, runNonce)` (workspaceId takes the userId slot in the HMAC — machines are workspace-identified).

- [ ] **Step 5: Wire `machineIpByHash` into `app/api/v1/compute/route/route.ts`** after the `sessionIpByHash` lookup (line ~34-43): try sessions, then machines, then legacy.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/workspace-machines.test.ts && pnpm -C control-plane/artifacts/sanad-web exec tsc --noEmit`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add control-plane/artifacts/sanad-web/lib/db/schema.ts control-plane/artifacts/sanad-web/drizzle control-plane/artifacts/sanad-web/lib/compute/machines.ts control-plane/artifacts/sanad-web/lib/compute/sessions.ts control-plane/artifacts/sanad-web/app/api/v1/compute/route/route.ts control-plane/artifacts/sanad-web/tests/unit/workspace-machines.test.ts
git commit -m "sanad: workspace machines — per-(workspace,env) fargate wake with worker mode + keep_warm"
```

---

### Task 5: Sync invoke route — the proxy

**Files:**
- Create: `control-plane/artifacts/sanad-web/lib/runs/store.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/invoke/route.ts`
- Test: `control-plane/artifacts/sanad-web/tests/unit/invoke-route.test.ts`

**Interfaces:**
- Consumes: `verifyInvokeBearer` (Task 2), `getAgentByName/getActiveDeployment` (Task 3), `ensureWorkspaceMachine` (Task 4), `mintSession` from `@/lib/auth/session` (same helper `terminal-tickets.ts:19-40` uses), S3 presigner (added here).
- Produces (lib/runs/store.ts):
  - `newRunId(): string` — `"r_" + randomBytes(6).toString("hex")` (12 hex).
  - `createRun(p: {deploymentId: string; agentVersionId: string; triggerPrincipal: string; idempotencyKey?: string}): Promise<{id: string; existing: boolean}>` — on unique-index conflict, return the existing run with `existing: true`.
  - `presignTracePut(runId: string): Promise<string>` / `presignTraceGet(runId: string): Promise<string>` — bucket `process.env.SANAD_RUNS_BUCKET`, key `runs/${runId}/wire.jsonl.gz`, expiry 3600s.
- Route behavior (`POST /api/v1/agents/{name}/invoke?env=` — but env comes from the token, the query is only validated against it):
  1. `verifyInvokeBearer` → 401. Token's `agentId` must match the path agent → 403 `token_scope`.
  2. `assertWithinQuota(info.orgId)` → 402 envelope on `QuotaExceededError`.
  3. `getActiveDeployment(agentId, env)` → 404 `not_deployed`; status `"paused"` → 409 `paused`.
  4. `createRun` with `triggerPrincipal = "itok:" + info.tokenId`, `idempotencyKey` from the `Idempotency-Key` header; if `existing`, replay: 200 with the stored run document (no new machine call).
  5. `ensureWorkspaceMachine(workspaceId, env, {keepWarm})` raced against a 120_000ms deadline → on timeout mark the run `failed`/`errorCode: "wake_timeout"` and return `err(503, "machine_waking", "workspace machine is starting — retry", true)` with header `Retry-After: 30`.
  6. Mint the run's CLI session: `mintSession(agent.ownerUserId, info.orgId, undefined, "worker-run", workspaceId)`.
  7. `fetch(baseUrl + "/internal/worker/runs", {method: "POST", headers: {authorization: "Bearer " + agentdToken}, body: JSON.stringify({runId, bundle, input, budgets, sessionToken, traceUploadUrl, sendId: runId}), duplex: "half"})` and pipe `res.body` straight through as the route's response (`application/x-ndjson`). Default: stream. With `?wait=1`: consume the stream server-side, then `ok({runId, status, output})` from the final journal `end` item.
  8. Mark the run `running` + `startedAt` when the machine responds 200.

- [ ] **Step 1: Write the failing test** for the pure decision core. Extract it as `export function invokeGate(...)` in `lib/runs/store.ts` so it is testable without Next:

```ts
// in lib/runs/store.ts
export type GateResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

export function invokeGate(p: {
  tokenAgentId: string;
  pathAgentId: string;
  deployment: { status: string } | null;
}): GateResult {
  if (p.tokenAgentId !== p.pathAgentId)
    return { ok: false, status: 403, code: "token_scope", message: "token is for another agent" };
  if (!p.deployment)
    return { ok: false, status: 404, code: "not_deployed", message: "no active deployment for env" };
  if (p.deployment.status === "paused")
    return { ok: false, status: 409, code: "paused", message: "deployment is paused" };
  return { ok: true };
}
```

```ts
// tests/unit/invoke-route.test.ts
import { describe, it, expect } from "vitest";
import { invokeGate, newRunId } from "@/lib/runs/store";

describe("invoke gate", () => {
  const base = { tokenAgentId: "ag_1", pathAgentId: "ag_1", deployment: { status: "active" } };
  it("passes an active deployment", () => expect(invokeGate(base).ok).toBe(true));
  it("403s a cross-agent token", () =>
    expect(invokeGate({ ...base, tokenAgentId: "ag_2" })).toMatchObject({ status: 403, code: "token_scope" }));
  it("404s when not deployed", () =>
    expect(invokeGate({ ...base, deployment: null })).toMatchObject({ status: 404, code: "not_deployed" }));
  it("409s a paused deployment", () =>
    expect(invokeGate({ ...base, deployment: { status: "paused" } })).toMatchObject({ status: 409, code: "paused" }));
});

describe("run ids", () => {
  it("are r_<12 hex>", () => expect(newRunId()).toMatch(/^r_[0-9a-f]{12}$/));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/invoke-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Install the S3 presigner deps**

Run: `pnpm -C control-plane/artifacts/sanad-web add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

- [ ] **Step 4: Implement `lib/runs/store.ts`** (gate + ids above, `createRun` with `.onConflictDoNothing()` + re-select for the idempotency replay, presigners):

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let s3: S3Client | null = null; // lazy, like lib/compute/aws.ts clients — railway mode never touches AWS
const bucket = () => {
  const b = process.env.SANAD_RUNS_BUCKET;
  if (!b) throw new Error("SANAD_RUNS_BUCKET is not configured");
  return b;
};
const client = () => (s3 ??= new S3Client({ region: process.env.AWS_REGION ?? "eu-central-1" }));

export const traceKey = (runId: string) => `runs/${runId}/wire.jsonl.gz`;

export function presignTracePut(runId: string): Promise<string> {
  return getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket(), Key: traceKey(runId) }),
    { expiresIn: 3600 });
}
export function presignTraceGet(runId: string): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: traceKey(runId) }),
    { expiresIn: 300 });
}
```

- [ ] **Step 5: Implement the route** per the behavior list in Interfaces. Template: `app/api/v1/runtime-tokens/route.ts` for envelope/auth shape; the streaming passthrough is `return new Response(machineRes.body, {status: 200, headers: {"content-type": "application/x-ndjson"}})`.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/invoke-route.test.ts && pnpm -C control-plane/artifacts/sanad-web exec tsc --noEmit`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add control-plane/artifacts/sanad-web/package.json control-plane/artifacts/sanad-web/pnpm-lock.yaml control-plane/artifacts/sanad-web/lib/runs/store.ts "control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/invoke" control-plane/artifacts/sanad-web/tests/unit/invoke-route.test.ts
git commit -m "sanad: sync invoke route — gate, idempotent run rows, machine wake + ndjson passthrough"
```

---

### Task 6: Completion ingest, pricing, read APIs, reaper

**Files:**
- Modify: `control-plane/artifacts/sanad-web/lib/models/catalog.ts`
- Modify: `control-plane/artifacts/sanad-web/lib/runs/store.ts`
- Create: `control-plane/artifacts/sanad-web/lib/runs/reaper.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/runs/route.ts`, `app/api/v1/runs/[id]/route.ts`, `app/api/v1/runs/[id]/trace/route.ts`, `app/api/v1/runs/[id]/complete/route.ts`, `app/api/internal/cron/reap-runs/route.ts`
- Test: `control-plane/artifacts/sanad-web/tests/unit/run-cost.test.ts`, `tests/unit/run-reaper.test.ts`

**Interfaces:**
- Consumes: Task 1 `runs` table; `deriveMachineToken` from `@/lib/compute/tokens`; `presignTraceGet` (Task 5); `verifyBearer` for the read APIs.
- Produces:
  - `catalog.ts`: `export const MODEL_PRICING: Record<string, {inUsdPerMTok: number; outUsdPerMTok: number}> = { "kimi-k3": { inUsdPerMTok: 0.6, outUsdPerMTok: 2.5 } };` *(placeholder numbers — flag to Omar before GA; unknown alias prices as 0 and sets `costUsdMicros = 0`, never throws).*
  - `store.ts`: `costUsdMicros(alias: string | null, tokensIn: number, tokensOut: number): number`; `completeRun(runId, p: {status: "succeeded" | "failed" | "cancelled"; errorCode?: string; output?: unknown; tokensIn: number; tokensOut: number; modelAlias?: string; traceUploaded: boolean}): Promise<void>` (sets `finishedAt`, computes cost).
  - `reaper.ts`: `sweepLostRuns(staleAfterMs: number): Promise<number>` — runs in `running` whose deployment's machine has `lastSeenAt` older than `staleAfterMs` (or no machine row) → `status: "lost"`; returns count.
- Route contract:
  - `POST /api/v1/runs/{id}/complete` — auth: `Authorization: Bearer <agentdToken>`; recompute `deriveMachineToken(workspaceId, runNonce)` for the run's machine and compare with `timingSafeEqual` (same pattern as `compute/route/route.ts:8-14`). Body = `completeRun` payload. Idempotent: completing a non-`running` run is a 200 no-op.
  - `GET /api/v1/runs?agent=&env=&status=&limit=` (session auth, org-scoped) → newest-first rows.
  - `GET /api/v1/runs/{id}` → row. `GET /api/v1/runs/{id}/trace` → 307 redirect to `presignTraceGet` when `traceUploaded`, else 404 `trace_unavailable`.
  - `POST /api/internal/cron/reap-runs` — header `x-cron-secret` vs `process.env.CRON_SECRET` (timing-safe), body `{staleAfterMs?}` default 300000 → `ok({reaped})`.

- [ ] **Step 1: Write the failing cost test**

```ts
// tests/unit/run-cost.test.ts
import { describe, it, expect } from "vitest";
import { costUsdMicros } from "@/lib/runs/store";

describe("costUsdMicros", () => {
  it("prices kimi-k3 tokens", () => {
    // 1M in @ $0.60 + 1M out @ $2.50 = $3.10 = 3_100_000 micros
    expect(costUsdMicros("kimi-k3", 1_000_000, 1_000_000)).toBe(3_100_000);
  });
  it("unknown alias costs zero, never throws", () => {
    expect(costUsdMicros("nope", 5_000, 5_000)).toBe(0);
    expect(costUsdMicros(null, 5_000, 5_000)).toBe(0);
  });
  it("rounds to integer micros", () => {
    expect(Number.isInteger(costUsdMicros("kimi-k3", 123, 457))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/run-cost.test.ts`
Expected: FAIL — `costUsdMicros` not exported.

- [ ] **Step 3: Implement pricing + completion + reaper**

```ts
// in lib/runs/store.ts
import { MODEL_PRICING } from "../models/catalog";

export function costUsdMicros(
  alias: string | null,
  tokensIn: number,
  tokensOut: number
): number {
  const p = alias ? MODEL_PRICING[alias] : undefined;
  if (!p) return 0;
  return Math.round(
    (tokensIn * p.inUsdPerMTok + tokensOut * p.outUsdPerMTok) // USD per M tokens
  ); // (tokens / 1e6) * usd * 1e6 micros — the 1e6s cancel
}
```

*(Note the cancellation: `tokens/1e6 * usdPerMTok * 1e6micros = tokens * usdPerMTok` — keep the comment in the code, it reads like a bug without it.)*

`sweepLostRuns` is one update-from-select; write it with an explicit five-minute-default constant `DEFAULT_STALE_MS = 300_000`.

- [ ] **Step 4: Write the failing reaper test, then implement the reaper and the five route files** per the contract above.

```ts
// tests/unit/run-reaper.test.ts
import { describe, it, expect, vi } from "vitest";

const updates: any[] = [];
const staleRows = [{ id: "r_aaaaaaaaaaaa" }, { id: "r_bbbbbbbbbbbb" }];
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({ where: vi.fn(async () => staleRows) })),
        where: vi.fn(async () => staleRows),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => { updates.push(v); return { where: vi.fn(async () => {}) }; }),
    })),
  },
}));

import { sweepLostRuns } from "@/lib/runs/reaper";

describe("sweepLostRuns", () => {
  it("marks stale running runs lost and returns the count", async () => {
    const n = await sweepLostRuns(300_000);
    expect(n).toBe(2);
    expect(updates[0]).toMatchObject({ status: "lost", errorCode: "machine_lost" });
  });
});
```

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/run-reaper.test.ts`
Expected: FAIL first (module missing), PASS after implementation. `sweepLostRuns` selects `running` runs joined through `deployments → agents → workspaces → workspaceMachines` where `lastSeenAt < now - staleAfterMs` (or no machine row), then updates each to `{status: "lost", errorCode: "machine_lost", finishedAt: new Date()}`.

- [ ] **Step 5: Full sanad-web test pass + typecheck**

Run: `pnpm -C control-plane/artifacts/sanad-web test && pnpm -C control-plane/artifacts/sanad-web exec tsc --noEmit`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add control-plane/artifacts/sanad-web/lib/models/catalog.ts control-plane/artifacts/sanad-web/lib/runs control-plane/artifacts/sanad-web/app/api/v1/runs control-plane/artifacts/sanad-web/app/api/internal/cron control-plane/artifacts/sanad-web/tests/unit/run-cost.test.ts control-plane/artifacts/sanad-web/tests/unit/run-reaper.test.ts
git commit -m "sanad: run completion + pricing + read apis + lost-run reaper"
```

---

### Task 7: CLI worker module — sidecar, assembly, ReturnOutput

**Files:**
- Create: `src/kimi_cli/worker/__init__.py`, `src/kimi_cli/worker/sidecar.py`, `src/kimi_cli/worker/assembly.py`, `src/kimi_cli/worker/return_output.py`
- Modify: `src/kimi_cli/soul/toolset.py` (add `request_stop_turn()`)
- Test: `tests/worker/test_sidecar.py`, `tests/worker/test_assembly.py`, `tests/worker/test_return_output.py`

**Interfaces:**
- Consumes: `load_agent_spec` semantics from `src/kimi_cli/agentspec.py` (the derived spec uses `extend:` + tools-by-import-path — no agentspec code changes needed); `CallableTool2[Params]`/`ToolReturnValue` from `kosong.tooling`; `KimiToolset` DI (`soul/agent.py:434` tool_deps dict already contains `KimiToolset`).
- Produces:
  - `sidecar.py`: `class WorkerSpec(BaseModel)` — `interface: InterfaceSpec` (`inputs: dict[str, str]`, `outputs: dict[str, str]` — P0 value types: `"string" | "number" | "boolean" | "file"` for inputs, `"string" | "number" | "boolean" | "enum[...]"` docs-level for outputs; stored as opaque strings, validated only for non-emptiness), `budgets: BudgetSpec` (`max_turn_seconds: int = 900`, `max_steps_per_turn: int = 100`, `max_tokens_per_run: int = 2_000_000`). `load_worker_spec(path: Path) -> WorkerSpec` raising `WorkerSpecError`.
  - `assembly.py`:
    - `render_input_prompt(spec: WorkerSpec, payload: dict[str, Any]) -> str` — rejects unknown/missing keys with `WorkerInputError`, renders the deterministic prompt block below.
    - `derive_agent_spec(agent_file: Path, out_dir: Path) -> Path` — writes `out_dir/worker-agent.yaml`: `{extend: <abs agent_file>, tools: ["kimi_cli.worker.return_output:ReturnOutput"]}` (extend keeps every base tool; the YAML `tools` list on an extending spec is additive per `agentspec.py` `Inherit` semantics — verify with the test in Step 4).
  - `return_output.py`: `class ReturnOutput(CallableTool2[Params])` — `Params.output: dict[str, Any]`; validates keys against `$KIMI_WORKER_INTERFACE_FILE`'s `outputs`, writes JSON to `$KIMI_WORKER_OUTPUT_FILE`, calls `toolset.request_stop_turn()`, returns a non-error `ToolReturnValue`.
  - `toolset.py`: `def request_stop_turn(self) -> None:` — sets `self._force_stop_turn = True` (read by the existing property at `toolset.py:339-341`; the soul loop already ends the turn on it, stop reason `"tool_call_repeat"` path at `kimisoul.py` step 2e.8).
  - Prompt block format (exact, consumed by parity tests):

```
Perform your task with these inputs:

<worker_inputs>
{"invoice_no": "INV-1", "amount": 120}
</worker_inputs>

When the task is complete you MUST call the ReturnOutput tool exactly once with the declared outputs: decision, summary.
```

- [ ] **Step 1: Write the failing sidecar + assembly tests**

```python
# tests/worker/test_sidecar.py
from pathlib import Path

import pytest

from kimi_cli.worker.sidecar import WorkerSpec, WorkerSpecError, load_worker_spec

VALID = """\
interface:
  inputs: {invoice_no: string, amount: number}
  outputs: {decision: "enum[approve, hold]", summary: string}
budgets:
  max_turn_seconds: 60
"""


def test_load_valid(tmp_path: Path) -> None:
    p = tmp_path / "worker.yaml"
    p.write_text(VALID)
    spec = load_worker_spec(p)
    assert spec.interface.inputs == {"invoice_no": "string", "amount": "number"}
    assert spec.budgets.max_turn_seconds == 60
    assert spec.budgets.max_steps_per_turn == 100  # default


def test_missing_file(tmp_path: Path) -> None:
    with pytest.raises(WorkerSpecError):
        load_worker_spec(tmp_path / "nope.yaml")


def test_empty_output_type_rejected(tmp_path: Path) -> None:
    p = tmp_path / "worker.yaml"
    p.write_text('interface:\n  inputs: {}\n  outputs: {decision: ""}\n')
    with pytest.raises(WorkerSpecError):
        load_worker_spec(p)
```

```python
# tests/worker/test_assembly.py
from pathlib import Path

import pytest

from kimi_cli.worker.assembly import WorkerInputError, derive_agent_spec, render_input_prompt
from kimi_cli.worker.sidecar import load_worker_spec


def _spec(tmp_path: Path):
    p = tmp_path / "worker.yaml"
    p.write_text(
        'interface:\n  inputs: {invoice_no: string}\n  outputs: {decision: string}\n'
    )
    return load_worker_spec(p)


def test_render_is_deterministic(tmp_path: Path) -> None:
    spec = _spec(tmp_path)
    out = render_input_prompt(spec, {"invoice_no": "INV-1"})
    assert "<worker_inputs>" in out
    assert '"invoice_no": "INV-1"' in out
    assert "ReturnOutput tool exactly once" in out
    assert out == render_input_prompt(spec, {"invoice_no": "INV-1"})


def test_unknown_input_rejected(tmp_path: Path) -> None:
    with pytest.raises(WorkerInputError):
        render_input_prompt(_spec(tmp_path), {"bogus": 1})


def test_missing_input_rejected(tmp_path: Path) -> None:
    with pytest.raises(WorkerInputError):
        render_input_prompt(_spec(tmp_path), {})


def test_derived_spec_extends_and_adds_tool(tmp_path: Path) -> None:
    agent = tmp_path / "agent.yaml"
    agent.write_text("version: '1'\nname: test\nsystem_prompt_path: prompt.md\n")
    (tmp_path / "prompt.md").write_text("hi")
    derived = derive_agent_spec(agent, tmp_path / "out")
    text = derived.read_text()
    assert str(agent) in text
    assert "kimi_cli.worker.return_output:ReturnOutput" in text
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/worker -vv`
Expected: FAIL — `kimi_cli.worker` does not exist.

- [ ] **Step 3: Implement `sidecar.py` and `assembly.py`**

```python
# src/kimi_cli/worker/sidecar.py
"""worker.yaml — the P0 interface/budget sidecar (replaced by manifest-v1's stanzas)."""

from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator


class WorkerSpecError(Exception):
    pass


class InterfaceSpec(BaseModel):
    inputs: dict[str, str] = Field(default_factory=dict)
    outputs: dict[str, str] = Field(default_factory=dict)

    @field_validator("inputs", "outputs")
    @classmethod
    def _no_empty_types(cls, v: dict[str, str]) -> dict[str, str]:
        for key, typ in v.items():
            if not key or not typ.strip():
                raise ValueError(f"empty type for {key!r}")
        return v


class BudgetSpec(BaseModel):
    max_turn_seconds: int = 900
    max_steps_per_turn: int = 100
    max_tokens_per_run: int = 2_000_000


class WorkerSpec(BaseModel):
    interface: InterfaceSpec = Field(default_factory=InterfaceSpec)
    budgets: BudgetSpec = Field(default_factory=BudgetSpec)


def load_worker_spec(path: Path) -> WorkerSpec:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise WorkerSpecError(f"worker spec not found: {path}") from e
    except yaml.YAMLError as e:
        raise WorkerSpecError(f"invalid YAML in {path}: {e}") from e
    try:
        return WorkerSpec.model_validate(raw or {})
    except ValueError as e:
        raise WorkerSpecError(str(e)) from e
```

```python
# src/kimi_cli/worker/assembly.py
"""Run assembly shared by `sanad dev` (local) and the cloud RunRunner — parity by construction."""

import json
from pathlib import Path
from typing import Any

import yaml

from kimi_cli.worker.sidecar import WorkerSpec

RETURN_OUTPUT_TOOL = "kimi_cli.worker.return_output:ReturnOutput"


class WorkerInputError(Exception):
    pass


def render_input_prompt(spec: WorkerSpec, payload: dict[str, Any]) -> str:
    declared = set(spec.interface.inputs)
    given = set(payload)
    if unknown := given - declared:
        raise WorkerInputError(f"unknown inputs: {sorted(unknown)}")
    if missing := declared - given:
        raise WorkerInputError(f"missing inputs: {sorted(missing)}")
    body = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    outputs = ", ".join(sorted(spec.interface.outputs)) or "output"
    return (
        "Perform your task with these inputs:\n\n"
        f"<worker_inputs>\n{body}\n</worker_inputs>\n\n"
        "When the task is complete you MUST call the ReturnOutput tool "
        f"exactly once with the declared outputs: {outputs}."
    )


def derive_agent_spec(agent_file: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    derived = out_dir / "worker-agent.yaml"
    derived.write_text(
        yaml.safe_dump(
            {"extend": str(agent_file.resolve()), "tools": [RETURN_OUTPUT_TOOL]},
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return derived
```

*(If the extend-with-additive-tools assumption fails the Step 4 test — i.e. `agentspec.py` treats a `tools` list on an extending spec as a replacement — change `derive_agent_spec` to resolve the base spec first via `load_agent_spec(agent_file)` and emit the full tool list `[*base.tools, RETURN_OUTPUT_TOOL]` with no `extend`. The test is the contract, not the mechanism.)*

- [ ] **Step 4: Run sidecar + assembly tests**

Run: `uv run pytest tests/worker/test_sidecar.py tests/worker/test_assembly.py -vv`
Expected: PASS. If `test_derived_spec_extends_and_adds_tool` fails on `extend` semantics, apply the fallback in the note above and re-run.

- [ ] **Step 5: Write the failing ReturnOutput test**

```python
# tests/worker/test_return_output.py
import json
from pathlib import Path

import pytest

from kimi_cli.worker.return_output import Params, ReturnOutput


class FakeToolset:
    def __init__(self) -> None:
        self.stopped = False

    def request_stop_turn(self) -> None:
        self.stopped = True


def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    iface = tmp_path / "worker.yaml"
    iface.write_text("interface:\n  inputs: {}\n  outputs: {decision: string}\n")
    out_file = tmp_path / "output.json"
    monkeypatch.setenv("KIMI_WORKER_INTERFACE_FILE", str(iface))
    monkeypatch.setenv("KIMI_WORKER_OUTPUT_FILE", str(out_file))
    return out_file


async def test_writes_output_and_stops(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    out_file = _env(monkeypatch, tmp_path)
    toolset = FakeToolset()
    tool = ReturnOutput(toolset)  # type: ignore[arg-type]
    result = await tool(Params(output={"decision": "approve"}))
    assert not result.is_error
    assert json.loads(out_file.read_text()) == {"decision": "approve"}
    assert toolset.stopped


async def test_undeclared_output_key_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    out_file = _env(monkeypatch, tmp_path)
    tool = ReturnOutput(FakeToolset())  # type: ignore[arg-type]
    result = await tool(Params(output={"bogus": 1}))
    assert result.is_error
    assert not out_file.exists()
```

- [ ] **Step 6: Implement `return_output.py` + the toolset method**

```python
# src/kimi_cli/worker/return_output.py
"""The worker interface contract: declared outputs come back through this tool."""

import json
import os
from pathlib import Path
from typing import Any

from kosong.tooling import CallableTool2, ToolReturnValue
from pydantic import BaseModel, Field
from typing_extensions import override

from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.worker.sidecar import load_worker_spec


class Params(BaseModel):
    output: dict[str, Any] = Field(description="The declared output document for this run.")


class ReturnOutput(CallableTool2[Params]):
    name: str = "ReturnOutput"
    description: str = (
        "Return the run's final output document. Call exactly once, with every declared "
        "output key, when the task is complete. This ends the run."
    )
    params: type[Params] = Params

    def __init__(self, toolset: KimiToolset) -> None:
        super().__init__()
        self._toolset = toolset

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        spec = load_worker_spec(Path(os.environ["KIMI_WORKER_INTERFACE_FILE"]))
        declared = set(spec.interface.outputs)
        given = set(params.output)
        if declared and (given != declared):
            return ToolReturnValue(
                is_error=True,
                output=(
                    f"Output keys {sorted(given)} do not match declared outputs "
                    f"{sorted(declared)}. Call ReturnOutput again with exactly the "
                    "declared keys."
                ),
            )
        out_file = Path(os.environ["KIMI_WORKER_OUTPUT_FILE"])
        out_file.write_text(json.dumps(params.output, ensure_ascii=False), encoding="utf-8")
        self._toolset.request_stop_turn()
        return ToolReturnValue(is_error=False, output="Output recorded. The run is complete.")
```

```python
# src/kimi_cli/soul/toolset.py — add next to the force_stop_turn property (~line 342)
    def request_stop_turn(self) -> None:
        """Ask the soul to end the turn after the current step (used by worker tools)."""
        self._force_stop_turn = True
```

Also create `src/kimi_cli/worker/__init__.py`:

```python
from kimi_cli.worker.assembly import (
    RETURN_OUTPUT_TOOL,
    WorkerInputError,
    derive_agent_spec,
    render_input_prompt,
)
from kimi_cli.worker.sidecar import WorkerSpec, WorkerSpecError, load_worker_spec

__all__ = [
    "RETURN_OUTPUT_TOOL",
    "WorkerInputError",
    "WorkerSpec",
    "WorkerSpecError",
    "derive_agent_spec",
    "load_worker_spec",
    "render_input_prompt",
]
```

- [ ] **Step 7: Run all worker tests + lint/type gates**

Run: `uv run pytest tests/worker -vv && make check`
Expected: PASS; ruff/pyright clean. (`make check` covers format+lint+types per root Makefile.)

- [ ] **Step 8: Commit**

```bash
git add src/kimi_cli/worker src/kimi_cli/soul/toolset.py tests/worker
git commit -m "sanad: worker assembly — sidecar spec, input rendering, ReturnOutput stop-turn tool"
```

---

### Task 8: `sanad dev` — the local run

**Files:**
- Create: `src/kimi_cli/cli/worker.py` (the `dev` command; Task 9 adds the rest)
- Modify: `src/kimi_cli/cli/_lazy_group.py:16-24` (one new lazy entry)
- Test: `tests_e2e/test_worker_dev.py`

**Interfaces:**
- Consumes: Task 7's `load_worker_spec/render_input_prompt/derive_agent_spec`; `Session.create` (`session.py:129`), `KimiCLI.create` (`app.py:122`), `KimiCLI.run` (`app.py:532`); scripted-echo config for tests (`tests_e2e/wire_helpers.py:84-128`).
- Produces:
  - Lazy entry: `"agent": ("kimi_cli.cli.worker", "cli", "Deploy and operate worker agents.")` — verbs are `sanad agent dev|deploy|runs|logs|pause|resume` (grouping under `agent` keeps the root namespace clean; the PRD's bare-verb surface arrives with the naming unification, Q3).
  - `sanad agent dev --input '{"k": "v"}' [--agent-file agent.yaml] [--worker-file worker.yaml] [--work-dir .]` → runs one ephemeral local run; prints the output document as JSON on stdout (only the JSON on success); exit codes: `0` success, `3` no_output, `4` bad input, `1` other failure.
  - Exit-code constants exported for tests: `EXIT_OK = 0, EXIT_FAILURE = 1, EXIT_NO_OUTPUT = 3, EXIT_BAD_INPUT = 4`.

- [ ] **Step 1: Write the failing e2e test** (scripted echo drives a real subprocess — pattern of `tests_e2e/test_wire_auth.py`, but through `sanad agent dev`):

```python
# tests_e2e/test_worker_dev.py
import json
import subprocess

from tests_e2e.wire_helpers import make_env, make_home_dir, make_work_dir, repo_root, write_scripted_config

AGENT_YAML = "version: '1'\nname: t\nsystem_prompt_path: prompt.md\n"
WORKER_YAML = "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n"


def _tool_call(payload: dict) -> str:
    call = {"id": "tc-1", "name": "ReturnOutput", "arguments": json.dumps(payload)}
    return f"tool_call: {json.dumps(call)}"


def _run_dev(tmp_path, scripts: list[str], input_json: str) -> subprocess.CompletedProcess:
    config_path = write_scripted_config(tmp_path, scripts)
    work_dir = make_work_dir(tmp_path)
    home_dir = make_home_dir(tmp_path)
    (work_dir / "agent.yaml").write_text(AGENT_YAML)
    (work_dir / "prompt.md").write_text("You are a test agent.")
    (work_dir / "worker.yaml").write_text(WORKER_YAML)
    return subprocess.run(
        ["uv", "run", "kimi", "agent", "dev", "--input", input_json,
         "--config-file", str(config_path), "--work-dir", str(work_dir)],
        cwd=repo_root(), env=make_env(home_dir), capture_output=True, text=True, timeout=120,
    )


def test_dev_returns_output(tmp_path) -> None:
    scripts = ["\n".join(["text: working", _tool_call({"output": {"answer": "42"}})])]
    proc = _run_dev(tmp_path, scripts, '{"q": "meaning"}')
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip()) == {"answer": "42"}


def test_dev_no_output_exit_code(tmp_path) -> None:
    # Model never calls ReturnOutput: one text turn, then the nudge turn also returns text.
    proc = _run_dev(tmp_path, ["text: done", "text: still no tool"], '{"q": "x"}')
    assert proc.returncode == 3, (proc.stdout, proc.stderr)


def test_dev_bad_input_exit_code(tmp_path) -> None:
    proc = _run_dev(tmp_path, ["text: unused"], '{"wrong_key": 1}')
    assert proc.returncode == 4
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests_e2e/test_worker_dev.py -vv`
Expected: FAIL — `No such command 'agent'`.

- [ ] **Step 3: Implement the command.** Core of `src/kimi_cli/cli/worker.py`:

```python
"""sanad agent — worker-agent verbs (dev now; deploy/runs/logs/pause/resume in Task 9)."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Annotated

import typer

cli = typer.Typer(help="Deploy and operate worker agents.")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_NO_OUTPUT = 3
EXIT_BAD_INPUT = 4

NUDGE = (
    "You have not called the ReturnOutput tool. Call it now with the declared outputs. "
    "This is your final step."
)


@cli.command()
def dev(
    input_json: Annotated[str, typer.Option("--input", help="Run input as JSON.")],
    agent_file: Annotated[Path, typer.Option("--agent-file")] = Path("agent.yaml"),
    worker_file: Annotated[Path, typer.Option("--worker-file")] = Path("worker.yaml"),
    work_dir: Annotated[Path, typer.Option("--work-dir")] = Path("."),
    config_file: Annotated[Path | None, typer.Option("--config-file")] = None,
) -> None:
    """Run the worker once locally with the same assembly the cloud runner uses."""
    raise typer.Exit(asyncio.run(_dev(input_json, agent_file, worker_file, work_dir, config_file)))


async def _dev(
    input_json: str, agent_file: Path, worker_file: Path, work_dir: Path,
    config_file: Path | None,
) -> int:
    from kimi_cli.worker import (
        WorkerInputError, WorkerSpecError, derive_agent_spec, load_worker_spec,
        render_input_prompt,
    )

    work_dir = work_dir.resolve()
    try:
        spec = load_worker_spec((work_dir / worker_file).resolve())
        prompt = render_input_prompt(spec, json.loads(input_json))
    except (WorkerInputError, WorkerSpecError, json.JSONDecodeError) as e:
        typer.echo(f"error: {e}", err=True)
        return EXIT_BAD_INPUT

    with tempfile.TemporaryDirectory(prefix="sanad-worker-") as tmp:
        out_file = Path(tmp) / "output.json"
        os.environ["KIMI_WORKER_INTERFACE_FILE"] = str((work_dir / worker_file).resolve())
        os.environ["KIMI_WORKER_OUTPUT_FILE"] = str(out_file)
        derived = derive_agent_spec((work_dir / agent_file).resolve(), Path(tmp))

        from kaos.path import KaosPath

        from kimi_cli.app import KimiCLI
        from kimi_cli.session import Session

        session = await Session.create(KaosPath(str(work_dir)))
        cli_app = await KimiCLI.create(
            session,
            config=config_file,
            runtime_afk=True,
            ui_mode="print",
            agent_file=derived,
            max_steps_per_turn=spec.budgets.max_steps_per_turn,
        )
        status = await _one_turn(cli_app, prompt, spec.budgets.max_turn_seconds)
        if status != 0:
            return status
        if not out_file.exists():
            # One nudge, then give up (spec: nudge-retry then fail no_output).
            status = await _one_turn(cli_app, NUDGE, spec.budgets.max_turn_seconds)
            if status != 0:
                return status
        if not out_file.exists():
            typer.echo("error: run finished without calling ReturnOutput", err=True)
            return EXIT_NO_OUTPUT
        typer.echo(out_file.read_text(encoding="utf-8"))
        return EXIT_OK


async def _one_turn(cli_app: "KimiCLI", prompt: str, max_seconds: int) -> int:
    cancel = asyncio.Event()
    try:
        async with asyncio.timeout(max_seconds):
            async for _msg in cli_app.run(prompt, cancel):
                pass
    except TimeoutError:
        typer.echo("error: turn budget exceeded", err=True)
        return EXIT_FAILURE
    except Exception as e:  # provider errors, RunCancelled, ...
        typer.echo(f"error: {e}", err=True)
        return EXIT_FAILURE
    return 0
```

And the lazy entry in `cli/_lazy_group.py` (append to `lazy_subcommands`):

```python
        "agent": ("kimi_cli.cli.worker", "cli", "Deploy and operate worker agents."),
```

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `uv run pytest tests_e2e/test_worker_dev.py -vv`
Expected: PASS (3 tests). Debug knob: `KIMI_TEST_TRACE=1`.

- [ ] **Step 5: Gates + commit**

Run: `make check`
Expected: clean.

```bash
git add src/kimi_cli/cli/worker.py src/kimi_cli/cli/_lazy_group.py tests_e2e/test_worker_dev.py
git commit -m "sanad: agent dev — local ephemeral worker run with nudge-then-no_output contract"
```

---

### Task 9: Client methods + `deploy/runs/logs/pause/resume` verbs

**Files:**
- Modify: `src/kimi_cli/sanad/client.py`, `src/kimi_cli/sanad/models.py`, `src/kimi_cli/cli/worker.py`
- Test: `tests/worker/test_client_worker.py`

**Interfaces:**
- Consumes: route contracts from Tasks 3, 5, 6 (exact paths + envelopes); `SanadClient._request` (`client.py:58-76`); `SanadSettings.load()`; session token from `KeychainStore.get()` / `SANAD_SESSION_TOKEN` (existing resolution used by `sanad/session.py`).
- Produces (client methods — all take `session_token: str` first, like `usage()`):
  - `deploy_agent(session_token, *, name: str, files: dict[str, str], env: str, workspace: str = "default") -> DeployResult` — POSTs `/api/v1/agents` (upsert), then `/versions`, then `/deployments`; `DeployResult(BaseModel)`: `agent_id: str`, `version_id: str`, `deployment_id: str`, `content_hash: str`.
  - `list_runs(session_token, *, agent: str | None, env: str | None, limit: int = 20) -> list[RunRow]` — `RunRow`: `id, status, error_code: str | None, created_at: str, cost_usd_micros: int, tokens_in: int, tokens_out: int`.
  - `get_run(session_token, run_id: str) -> RunRow`; `get_run_trace_url(session_token, run_id: str) -> str` (follows the 307 by reading `location` with `follow_redirects=False`).
  - `set_deployment_status(session_token, *, agent: str, env: str, status: str) -> None` (PATCH `/deployments`).
- CLI verbs in `cli/worker.py`: `deploy [--env dev] [--workspace default]` (bundle = `agent.yaml` + `worker.yaml` + every file referenced by `system_prompt_path`, read relative to `--work-dir`); `runs [--agent NAME]` (table: id, status, cost, age); `logs RUN_ID` (prints trace URL; `--follow` reserved, P0 prints finished-run URL only); `pause NAME [--env]` / `resume NAME [--env]`.

- [ ] **Step 1: Write the failing client test** with `httpx.MockTransport` (same technique as terminal-server's `_control_plane` fake at `terminal-server/tests/test_routes_coder.py:26-33`):

```python
# tests/worker/test_client_worker.py
import json

import httpx

from kimi_cli.sanad.client import SanadClient
from kimi_cli.sanad.settings import SanadSettings


def _client(handler) -> SanadClient:
    settings = SanadSettings(api_base_url="https://cp.test")
    return SanadClient(settings, transport=httpx.MockTransport(handler))


def test_deploy_agent_three_calls_in_order() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/api/v1/agents":
            return httpx.Response(200, json={"data": {"id": "ag_1"}})
        if request.url.path == "/api/v1/agents/t/versions":
            return httpx.Response(200, json={"data": {"versionId": "av_1", "contentHash": "aa" * 32}})
        return httpx.Response(200, json={"data": {"deploymentId": "dp_1"}})

    out = _client(handler).deploy_agent(
        "sess", name="t", files={"agent.yaml": "x"}, env="dev"
    )
    assert calls == [
        "POST /api/v1/agents",
        "POST /api/v1/agents/t/versions",
        "POST /api/v1/agents/t/deployments",
    ]
    assert out.deployment_id == "dp_1"


def test_list_runs_unwraps_envelope() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["agent"] == "t"
        return httpx.Response(200, json={"data": [{
            "id": "r_abcabcabcabc", "status": "succeeded", "errorCode": None,
            "createdAt": "2026-08-13T00:00:00Z", "costUsdMicros": 12, "tokensIn": 5, "tokensOut": 7,
        }]})

    rows = _client(handler).list_runs("sess", agent="t", env=None)
    assert rows[0].id == "r_abcabcabcabc"
    assert rows[0].cost_usd_micros == 12
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/worker/test_client_worker.py -vv`
Expected: FAIL — `deploy_agent` not defined.

- [ ] **Step 3: Implement models + client methods.** `RunRow`/`DeployResult` are pydantic models in `sanad/models.py` with `alias`es for the camelCase envelope fields (`populate_by_name=True`, e.g. `error_code: str | None = Field(None, alias="errorCode")`). Client methods follow the `mint_runtime_token` pattern (`client.py:101-104`) exactly — `self._request("POST", path, json=..., session_token=...)` then `Model.model_validate(...)`.

- [ ] **Step 4: Add the typer verbs** to `cli/worker.py`. Each resolves the session token the way the rest of the CLI does (env `SANAD_SESSION_TOKEN` fallback keychain — import the existing helper from `kimi_cli/sanad/settings.py`/`auth` rather than reimplementing; if the helper is private, promote it to `sanad/session_token.py::resolve_session_token() -> str | None` and use it from both call sites). `deploy` reads the bundle files, errors politely when `worker.yaml` is absent (`exit 4`).

- [ ] **Step 5: Run tests + gates, commit**

Run: `uv run pytest tests/worker -vv && make check`
Expected: PASS, clean.

```bash
git add src/kimi_cli/sanad/client.py src/kimi_cli/sanad/models.py src/kimi_cli/cli/worker.py tests/worker/test_client_worker.py
git commit -m "sanad: agent verbs — deploy bundle flow, runs/logs/pause/resume clients"
```

---

### Task 10: terminal-server — settings + `RunRunner`

**Files:**
- Modify: `terminal-server/src/sanad_terminal/settings.py`
- Create: `terminal-server/src/sanad_terminal/run_runner.py`
- Test: `terminal-server/tests/test_run_runner.py`
- Create: `terminal-server/tests/_fake_worker_wire.py` (copy `tests/_fake_coder_wire.py` and add: on `prompt`, emit one `event` then read `$KIMI_WORKER_OUTPUT_FILE`'s dir env and write `{"answer": "fake"}` to it before responding `finished` — so runner tests exercise the output path without a real model)

**Interfaces:**
- Consumes: `WireRunner` (`wire_runner.py:75-117` — `argv/cwd/env/uid/gid/client_name/capabilities/max_turn_seconds/max_steps_per_turn`), `register_registry` (`wire_runner.py:520`), `build_child_env` (`workspace.py:87`), `TerminalSettings.load` env pattern (`settings.py:51-65`).
- Produces:
  - Settings fields (frozen dataclass, defaults): `worker_enabled: bool = False` (`WORKER_ENABLED == "1"`), `worker_max_turn_seconds: float = 900.0`, `worker_max_steps_per_turn: int = 100`, `worker_max_tokens_per_run: int = 2_000_000`, `keep_warm: bool = False` (`KEEP_WARM == "1"`).
  - `run_runner.py`:
    - `RUN_ID_RE = re.compile(r"^r_[a-f0-9]{12}$")`
    - `class RunRunner(WireRunner)` — ctor `(*, run_id: str, argv, cwd: Path, env: dict[str, str], uid, gid, max_turn_seconds: float, max_steps_per_turn: int, max_tokens_per_run: int, on_finished: Callable[[RunRunner], Awaitable[None]] | None = None)`; `client_name="sanad-worker"`, `capabilities={"supports_question": False, "supports_plan_mode": False}`. Exactly-one-turn: a second `start_turn` raises `WireRunnerError("run_consumed", ...)`.
    - Token budget: RunRunner overrides `_dispatch`'s event hook — concretely, override `async def on_event(self, params: dict) -> None` if the base class exposes one; **it does not**, so add the seam in `wire_runner.py`: inside `_consume`, after journaling an event item, call `self.observe_event(envelope)` where the base implementation is a no-op `def observe_event(self, envelope: dict[str, Any]) -> None: pass`. RunRunner's override sums `StatusUpdate.token_usage` fields (`input_other + input_cache_read + input_cache_creation` → `tokens_in`, `output` → `tokens_out`) and captures `model_alias` if present; when `tokens_in + tokens_out > max_tokens_per_run` it schedules `_trip_budget(state, "token budget exceeded")` (idempotent, same as the wall-clock path).
    - `usage_totals() -> dict` → `{"tokensIn": int, "tokensOut": int, "modelAlias": str | None}`.
    - On terminal turn status (`finished|failed|cancelled` — observed where `_dispatch` records the `end`/`error` item): fire `on_finished(self)` exactly once (guard flag), then the registry drops it (Task 12 uses the callback for upload+report).
    - Registry: `_runs: dict[str, RunRunner]` keyed by run id, `register_registry(_runs)`, `get_run/put_run/drop_run/live_run_count()`.
  - Per-run dirs helper: `prepare_run_dirs(deployment_root: Path, run_id: str) -> RunDirs` — `RunDirs` dataclass `{root, workspace, home, share, bundle, output_file, interface_file}` rooted at `deployment_root / "runs" / run_id`, each of `workspace/home/kimi-share/bundle` created 0o700.

- [ ] **Step 1: Write the failing tests**

```python
# terminal-server/tests/test_run_runner.py
import sys
from pathlib import Path

import pytest

from sanad_terminal.run_runner import (
    RUN_ID_RE, RunRunner, get_run, prepare_run_dirs, put_run,
)
from sanad_terminal.wire_runner import WireRunnerError

FAKE_WIRE = Path(__file__).parent / "_fake_worker_wire.py"


def _runner(tmp_path: Path, run_id: str = "r_aaaaaaaaaaaa") -> RunRunner:
    dirs = prepare_run_dirs(tmp_path, run_id)
    return RunRunner(
        run_id=run_id,
        argv=(sys.executable, str(FAKE_WIRE)),
        cwd=dirs.workspace,
        env={"KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file)},
        uid=None, gid=None,
        max_turn_seconds=30.0, max_steps_per_turn=50, max_tokens_per_run=1000,
    )


def test_run_id_re() -> None:
    assert RUN_ID_RE.match("r_0123456789ab")
    assert not RUN_ID_RE.match("c_0123456789ab")
    assert not RUN_ID_RE.match("r_0123456789ABCD")


def test_prepare_run_dirs_layout(tmp_path: Path) -> None:
    dirs = prepare_run_dirs(tmp_path, "r_aaaaaaaaaaaa")
    assert dirs.root == tmp_path / "runs" / "r_aaaaaaaaaaaa"
    for d in (dirs.workspace, dirs.home, dirs.share, dirs.bundle):
        assert d.is_dir()
        assert (d.stat().st_mode & 0o777) == 0o700


async def test_exactly_one_turn(tmp_path: Path) -> None:
    runner = _runner(tmp_path)
    await runner.start()
    state = await runner.start_turn("go", send_id="s1")
    async for item in runner.follow(state.turn_id, 0):
        if item["kind"] in ("end", "error"):
            break
    with pytest.raises(WireRunnerError) as exc:
        await runner.start_turn("again", send_id="s2")
    assert exc.value.code == "run_consumed"
    await runner.stop()


async def test_same_send_id_replays(tmp_path: Path) -> None:
    runner = _runner(tmp_path)
    await runner.start()
    state = await runner.start_turn("go", send_id="s1")
    assert (await runner.start_turn("go", send_id="s1")).turn_id == state.turn_id
    await runner.stop()


async def test_on_finished_fires_once(tmp_path: Path) -> None:
    fired: list[str] = []

    async def on_finished(r: RunRunner) -> None:
        fired.append(r.run_id)

    dirs = prepare_run_dirs(tmp_path, "r_bbbbbbbbbbbb")
    runner = RunRunner(
        run_id="r_bbbbbbbbbbbb", argv=(sys.executable, str(FAKE_WIRE)),
        cwd=dirs.workspace, env={"KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file)},
        uid=None, gid=None, max_turn_seconds=30.0, max_steps_per_turn=50,
        max_tokens_per_run=1000, on_finished=on_finished,
    )
    await runner.start()
    state = await runner.start_turn("go")
    async for item in runner.follow(state.turn_id, 0):
        if item["kind"] in ("end", "error"):
            break
    await runner.wait_finished_hooks()  # helper that awaits the callback task
    assert fired == ["r_bbbbbbbbbbbb"]
    await runner.stop()
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest terminal-server/tests/test_run_runner.py -vv`
Expected: FAIL — `sanad_terminal.run_runner` missing.

- [ ] **Step 3: Implement.** Settings fields per Interfaces (extend `TerminalSettings.load` exactly like the `coder_*` block at `settings.py:119-121`). Add the `observe_event` no-op seam to `WireRunner._consume` (one line + one method). `RunRunner` core:

```python
# terminal-server/src/sanad_terminal/run_runner.py
"""One ephemeral worker run = one wire subprocess. Sibling of CoderRunner."""

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sanad_terminal.wire_runner import WireRunner, WireRunnerError, register_registry

RUN_ID_RE = re.compile(r"^r_[a-f0-9]{12}$")


@dataclass(frozen=True, slots=True)
class RunDirs:
    root: Path
    workspace: Path
    home: Path
    share: Path
    bundle: Path
    output_file: Path
    interface_file: Path


def prepare_run_dirs(deployment_root: Path, run_id: str) -> RunDirs:
    root = deployment_root / "runs" / run_id
    sub = {name: root / name for name in ("workspace", "home", "kimi-share", "bundle")}
    for d in sub.values():
        d.mkdir(parents=True, exist_ok=True)
        d.chmod(0o700)
    return RunDirs(
        root=root, workspace=sub["workspace"], home=sub["home"], share=sub["kimi-share"],
        bundle=sub["bundle"], output_file=root / "output.json",
        interface_file=sub["bundle"] / "worker.yaml",
    )


class RunRunner(WireRunner):
    def __init__(
        self,
        *,
        run_id: str,
        argv: Sequence[str],
        cwd: Path,
        env: dict[str, str],
        uid: int | None,
        gid: int | None,
        max_turn_seconds: float,
        max_steps_per_turn: int,
        max_tokens_per_run: int,
        on_finished: Callable[["RunRunner"], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__(
            argv=argv, cwd=cwd, env=env, uid=uid, gid=gid,
            client_name="sanad-worker",
            capabilities={"supports_question": False, "supports_plan_mode": False},
            max_turn_seconds=max_turn_seconds,
            max_steps_per_turn=max_steps_per_turn,
        )
        self.run_id = run_id
        self._max_tokens = max_tokens_per_run
        self._tokens_in = 0
        self._tokens_out = 0
        self._model_alias: str | None = None
        self._consumed = False
        self._on_finished = on_finished
        self._finished_fired = False
        self._finish_task: asyncio.Task[None] | None = None

    async def start_turn(self, user_input: str, send_id: str | None = None):
        if self._consumed:
            cur = self._current
            if send_id and cur is not None and cur.send_id == send_id:
                return cur
            raise WireRunnerError("run_consumed", "this run already executed its turn")
        state = await super().start_turn(user_input, send_id)
        self._consumed = True
        return state

    def observe_event(self, envelope: dict[str, Any]) -> None:
        if envelope.get("type") != "StatusUpdate":
            return
        usage = (envelope.get("payload") or {}).get("token_usage") or {}
        self._tokens_in += (
            int(usage.get("input_other", 0))
            + int(usage.get("input_cache_read", 0))
            + int(usage.get("input_cache_creation", 0))
        )
        self._tokens_out += int(usage.get("output", 0))
        if self._tokens_in + self._tokens_out > self._max_tokens and self._current:
            self._schedule_trip(self._current, "token budget exceeded")

    def usage_totals(self) -> dict[str, Any]:
        return {
            "tokensIn": self._tokens_in,
            "tokensOut": self._tokens_out,
            "modelAlias": self._model_alias,
        }
```

Terminal-status hook: in the base `_dispatch`, the `end`/`error` append is the single choke point — after it, if the runner has an `_on_finished` and not `_finished_fired`, set the flag and `self._finish_task = asyncio.create_task(self._on_finished(self))`. Add `async def wait_finished_hooks(self)` awaiting `_finish_task`. `_schedule_trip` is a small wrapper creating a task for `_trip_budget` (matching how the wall-clock watcher trips it).

Registry block mirrors `coder_runner.py:186-214` keyed by bare run id (runs are machine-global, not root-scoped — the machine is single-workspace by construction):

```python
_runs: dict[str, RunRunner] = {}
register_registry(_runs)


def get_run(run_id: str) -> RunRunner | None:
    return _runs.get(run_id)


def put_run(runner: RunRunner) -> None:
    _runs[runner.run_id] = runner


async def drop_run(run_id: str) -> None:
    runner = _runs.pop(run_id, None)
    if runner is not None:
        await runner.stop()
```

- [ ] **Step 4: Run to verify green**

Run: `uv run pytest terminal-server/tests/test_run_runner.py -vv`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add terminal-server/src/sanad_terminal/settings.py terminal-server/src/sanad_terminal/run_runner.py terminal-server/src/sanad_terminal/wire_runner.py terminal-server/tests/test_run_runner.py terminal-server/tests/_fake_worker_wire.py
git commit -m "sanad: RunRunner — one-turn wire runner with token budget and finished hook"
```

---

### Task 11: terminal-server — `/internal/worker/*` routes + keep-warm probe

**Files:**
- Create: `terminal-server/src/sanad_terminal/routes_worker.py`
- Modify: `terminal-server/src/sanad_terminal/app.py` (router include + `WorkerDisabled` handler + keep-warm probe + lifespan shutdown of `_runs`)
- Test: `terminal-server/tests/test_routes_worker.py`

**Interfaces:**
- Consumes: Tasks 7's env contract (`KIMI_WORKER_INTERFACE_FILE/OUTPUT_FILE`), Task 10's `RunRunner/prepare_run_dirs/registry`, `build_child_env` (`workspace.py:87` — extend its return in-place with the two worker keys), auth via the **existing task-mode REST guard** (same dependency `routes_workspace.py` uses: bearer `AGENTD_TOKEN`), `_settings(request)` pattern (`routes_coder.py:34-52`).
- Produces (all under `APIRouter(prefix="/internal/worker")`, gated fail-closed like coder):
  - `POST /runs` body `RunStartBody`: `{runId, sendId, input: dict, bundle: {files: dict[str, str]}, budgets: {maxTurnSeconds, maxStepsPerTurn, maxTokensPerRun}, sessionToken, traceUploadUrl}` → 400 `bad_run_id` unless `RUN_ID_RE`; 409 `busy_run` if the id exists and differs by sendId; writes bundle files under `dirs.bundle` (reject path traversal: every relative path must resolve inside `bundle/`), loads `worker.yaml` from the bundle via `load_worker_spec` (imported from `kimi_cli.worker.sidecar` — the CLI is co-installed per `terminal-server/pyproject.toml` comment, and this import is the one sanctioned exception to "sanad_terminal never imports kimi_cli"; update that comment), renders the prompt with `render_input_prompt`, derives the spec with `derive_agent_spec(bundle_agent_yaml, dirs.bundle)`, spawns `RunRunner` with `argv = [*settings.spawn_argv, "--wire", "--session", runId, "--agent-file", str(derived), "--work-dir", str(dirs.workspace)]` and `env = build_child_env(user_dir=dirs.root, session_token=body.sessionToken, api_base_url=settings.child_api_base_url, cols=80, rows=24) | {"KIMI_WORKER_INTERFACE_FILE": str(dirs.interface_file), "KIMI_WORKER_OUTPUT_FILE": str(dirs.output_file), "KIMI_SHARE_DIR": str(dirs.share)}`, `on_finished` = Task 12's reporter; `start()` + `start_turn(prompt, sendId)`; returns `StreamingResponse(runner.follow(state.turn_id, 0) → ndjson)`.
  - `GET /runs/{rid}/follow?from_seq=` → NDJSON re-tail; `POST /runs/{rid}/cancel` → `runner.cancel()`; both 404 `unknown_run` when absent.
  - app.py: `WorkerDisabled` → 404 `worker_disabled`; keep-warm probe `idle_stopper.add_probe(lambda: resolved.keep_warm)`; lifespan shutdown drains `_runs` via `drop_run`.

- [ ] **Step 1: Write the failing route tests** (fixture style = `test_routes_coder.py:17-59`: `TestClient`, fake wire via `spawn_argv`, `WORKER` settings on):

```python
# terminal-server/tests/test_routes_worker.py
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sanad_terminal.app import create_app
from sanad_terminal.settings import TerminalSettings

FAKE_WIRE = Path(__file__).parent / "_fake_worker_wire.py"

BUNDLE = {
    "agent.yaml": "version: '1'\nname: t\nsystem_prompt_path: prompt.md\n",
    "prompt.md": "You are a worker.",
    "worker.yaml": "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n",
}


def _body(run_id: str = "r_aaaaaaaaaaaa") -> dict:
    return {
        "runId": run_id, "sendId": run_id, "input": {"q": "hi"},
        "bundle": {"files": BUNDLE},
        "budgets": {"maxTurnSeconds": 30, "maxStepsPerTurn": 50, "maxTokensPerRun": 100000},
        "sessionToken": "sess_x", "traceUploadUrl": "https://s3.test/put",
    }


def _make_client(tmp_path: Path, *, enabled: bool) -> TestClient:
    settings = TerminalSettings(
        mode="task",
        workspace_user="user_1",
        agentd_token="tok",
        data_dir=tmp_path,
        spawn_argv=(sys.executable, str(FAKE_WIRE)),
        worker_enabled=enabled,
    )
    return TestClient(create_app(settings, control_plane=None))


AUTH = {"authorization": "Bearer tok"}


def test_disabled_is_404(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=False) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "worker_disabled"


def test_bad_run_id_rejected(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body("nope"), headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_run_id"


def test_bundle_traversal_rejected(tmp_path: Path) -> None:
    body = _body()
    body["bundle"]["files"] = {"../evil.yaml": "x", **BUNDLE}
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=body, headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_bundle_path"


def test_run_streams_ndjson_and_replays_by_send_id(tmp_path: Path) -> None:
    with _make_client(tmp_path, enabled=True) as c:
        r = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r.status_code == 200
        items = [json.loads(line) for line in r.text.strip().splitlines()]
        assert items[0]["kind"] == "turn"
        assert items[-1]["kind"] in ("end", "error")
        # replay: same runId+sendId re-follows instead of 409
        r2 = c.post("/internal/worker/runs", json=_body(), headers=AUTH)
        assert r2.status_code == 200
```

*(TerminalSettings field names for task mode — `workspace_user`, `agentd_token`, `data_dir` — must match `settings.py`; check the dataclass before writing the fixture and adjust the kwargs, not the test's intent.)*

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest terminal-server/tests/test_routes_worker.py -vv`
Expected: FAIL — no `/internal/worker` routes (404s with the wrong body / import error).

- [ ] **Step 3: Implement `routes_worker.py` + app wiring** per the Interfaces contract. Route skeleton mirrors `routes_coder.py` exactly: module-level `router`, `WorkerDisabled` exception + `Gated` dependency, `_err(status, code, message)` JSON helper, bundle write with `resolved = (bundle_dir / rel).resolve(); if not resolved.is_relative_to(bundle_dir): return _err(400, "bad_bundle_path", rel)`.

- [ ] **Step 4: Run to verify green, then the whole terminal-server suite**

Run: `uv run pytest terminal-server/tests -vv`
Expected: new tests PASS; no regressions in coder/architect/workspace tests.

- [ ] **Step 5: Commit**

```bash
git add terminal-server/src/sanad_terminal/routes_worker.py terminal-server/src/sanad_terminal/app.py terminal-server/tests/test_routes_worker.py terminal-server/pyproject.toml
git commit -m "sanad: worker routes — gated run start/follow/cancel with bundle containment + keep-warm probe"
```

---

### Task 12: terminal-server — trace upload + completion report

**Files:**
- Modify: `terminal-server/src/sanad_terminal/control_plane.py`, `terminal-server/src/sanad_terminal/routes_worker.py`, `terminal-server/src/sanad_terminal/run_runner.py`
- Test: `terminal-server/tests/test_run_completion.py`

**Interfaces:**
- Consumes: Task 10's `on_finished` hook + `usage_totals()`; Task 6's `POST /api/v1/runs/{id}/complete` contract; `httpx` (already a dep).
- Produces:
  - `control_plane.py`: `async def report_run_completion(self, run_id: str, agentd_token: str, payload: dict[str, Any]) -> None` — POST `{control_plane_url}/api/v1/runs/{run_id}/complete` with `Authorization: Bearer {agentd_token}`; swallow-and-log on failure (fire-and-forget semantics; the reaper is the backstop).
  - `run_runner.py`: `async def collect_trace(self) -> bytes | None` — locate `share/sessions/*/<run_id>/wire.jsonl` under the run's share dir, gzip-compress; None when missing.
  - `routes_worker.py`: `_make_on_finished(dirs, body, settings, control_plane)` closure — reads `dirs.output_file` (sets `status="succeeded"` + output, or `status="failed", errorCode="no_output"` when the turn finished without it — **the cloud nudge is P1; cloud runs fail fast on no_output in P0, only `sanad dev` nudges**), maps journal terminal item (`error` → `failed` + its `code`; cancelled → `cancelled`), PUTs the gzip to `body.traceUploadUrl` via `httpx.AsyncClient` (`content-encoding: gzip` not set — the object IS gzip, key ends `.gz`), then `report_run_completion` with `{status, errorCode, output, **runner.usage_totals(), traceUploaded}`; finally removes `dirs.root` on `succeeded` (keep on failure for debugging).
- Failure-mode contract (worker side): upload fails → `traceUploaded: false`, still report completion; report fails → log only (run becomes `lost` via reaper if the machine dies before a retry — acceptable P0).

- [ ] **Step 1: Write the failing test** — drive `_make_on_finished` directly with a fake runner + `httpx.MockTransport`:

```python
# terminal-server/tests/test_run_completion.py
import gzip
import json
from pathlib import Path
from typing import Any

import httpx

from sanad_terminal.control_plane import ControlPlaneClient
from sanad_terminal.routes_worker import _make_on_finished
from sanad_terminal.run_runner import prepare_run_dirs


class FakeRunner:
    run_id = "r_cccccccccccc"

    def __init__(self, terminal_item: dict[str, Any]) -> None:
        self._terminal = terminal_item

    def terminal_item(self) -> dict[str, Any]:
        return self._terminal

    def usage_totals(self) -> dict[str, Any]:
        return {"tokensIn": 10, "tokensOut": 5, "modelAlias": "kimi-k3"}

    async def collect_trace(self) -> bytes | None:
        return gzip.compress(b'{"type":"metadata"}\n')


def _harness(tmp_path: Path, terminal_item: dict[str, Any], output: dict | None):
    calls: list[tuple[str, str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        calls.append((request.method, str(request.url), body))
        return httpx.Response(200, json={"data": {}})

    transport = httpx.MockTransport(handler)
    cp = ControlPlaneClient("https://cp.test", "secret", transport=transport)
    dirs = prepare_run_dirs(tmp_path, FakeRunner.run_id)
    if output is not None:
        dirs.output_file.write_text(json.dumps(output))
    body = type("B", (), {"traceUploadUrl": "https://s3.test/put", "runId": FakeRunner.run_id})()
    on_finished = _make_on_finished(
        dirs, body, agentd_token="tok", control_plane=cp, upload_transport=transport
    )
    return on_finished, calls, dirs


async def test_success_reports_output_and_uploads(tmp_path: Path) -> None:
    on_finished, calls, dirs = _harness(
        tmp_path, {"kind": "end", "status": "finished"}, {"answer": "42"}
    )
    await on_finished(FakeRunner({"kind": "end", "status": "finished"}))
    puts = [c for c in calls if c[0] == "PUT"]
    posts = [c for c in calls if c[0] == "POST" and "/runs/" in c[1]]
    assert len(puts) == 1
    assert posts[0][2]["status"] == "succeeded"
    assert posts[0][2]["output"] == {"answer": "42"}
    assert posts[0][2]["traceUploaded"] is True
    assert posts[0][2]["tokensIn"] == 10
    assert not dirs.root.exists()  # cleaned on success


async def test_no_output_fails_fast(tmp_path: Path) -> None:
    on_finished, calls, dirs = _harness(tmp_path, {"kind": "end", "status": "finished"}, None)
    await on_finished(FakeRunner({"kind": "end", "status": "finished"}))
    post = next(c for c in calls if c[0] == "POST" and "/runs/" in c[1])
    assert post[2]["status"] == "failed"
    assert post[2]["errorCode"] == "no_output"
    assert dirs.root.exists()  # kept for debugging


async def test_budget_error_maps_through(tmp_path: Path) -> None:
    item = {"kind": "error", "code": "turn_budget_exceeded", "message": "m"}
    on_finished, calls, _dirs = _harness(tmp_path, item, None)
    await on_finished(FakeRunner(item))
    post = next(c for c in calls if c[0] == "POST" and "/runs/" in c[1])
    assert post[2] == {**post[2], "status": "failed", "errorCode": "turn_budget_exceeded"}
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest terminal-server/tests/test_run_completion.py -vv`
Expected: FAIL — `_make_on_finished` missing.

- [ ] **Step 3: Implement.** `_make_on_finished(dirs, body, *, agentd_token, control_plane, upload_transport=None)` returns the async closure; `terminal_item()` on RunRunner returns the last `end|error` journal item of the consumed turn (add it in run_runner.py — read from `self._turns` via `self._turn_order[-1]`). Upload client: `httpx.AsyncClient(transport=upload_transport)` so tests inject the mock; production passes None.

- [ ] **Step 4: Run to verify green + full suite**

Run: `uv run pytest terminal-server/tests -vv`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add terminal-server/src/sanad_terminal/control_plane.py terminal-server/src/sanad_terminal/routes_worker.py terminal-server/src/sanad_terminal/run_runner.py terminal-server/tests/test_run_completion.py
git commit -m "sanad: run completion — trace gzip upload, usage report, no_output fail-fast"
```

---

### Task 13: Parity e2e — dev and cloud runner produce the same run

**Files:**
- Test: `tests_e2e/test_worker_parity.py`

**Interfaces:**
- Consumes: everything — Task 8's `sanad agent dev`, Tasks 10-11's `RunRunner` route with `spawn_argv` pointed at the real CLI, `write_scripted_config` (`wire_helpers.py:84-128`).
- Produces: the DX-4 evidence — the same bundle + input + scripted model yields the same output document and the same wire event-type sequence in both paths.

- [ ] **Step 1: Write the test**

```python
# tests_e2e/test_worker_parity.py
import json
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from tests_e2e.wire_helpers import make_env, make_home_dir, make_work_dir, repo_root, write_scripted_config

BUNDLE = {
    "agent.yaml": "version: '1'\nname: t\nsystem_prompt_path: prompt.md\n",
    "prompt.md": "You are a worker.",
    "worker.yaml": "interface:\n  inputs: {q: string}\n  outputs: {answer: string}\n",
}
SCRIPTS = ['\n'.join([
    "text: thinking",
    'tool_call: ' + json.dumps({
        "id": "tc-1", "name": "ReturnOutput",
        "arguments": json.dumps({"output": {"answer": "42"}}),
    }),
])]


def _dev_output(tmp_path: Path) -> dict:
    config_path = write_scripted_config(tmp_path / "dev", SCRIPTS)
    work_dir = make_work_dir(tmp_path / "dev")
    home_dir = make_home_dir(tmp_path / "dev")
    for name, text in BUNDLE.items():
        (work_dir / name).write_text(text)
    proc = subprocess.run(
        ["uv", "run", "kimi", "agent", "dev", "--input", '{"q": "meaning"}',
         "--config-file", str(config_path), "--work-dir", str(work_dir)],
        cwd=repo_root(), env=make_env(home_dir), capture_output=True, text=True, timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip())


def _cloud_output(tmp_path: Path) -> tuple[dict, list[str]]:
    from sanad_terminal.app import create_app
    from sanad_terminal.settings import TerminalSettings

    cloud = tmp_path / "cloud"
    config_path = write_scripted_config(cloud, SCRIPTS)
    settings = TerminalSettings(
        mode="task", workspace_user="u1", agentd_token="tok", data_dir=cloud,
        spawn_argv=("uv", "run", "kimi", "run", "--config-file", str(config_path)),
        worker_enabled=True,
    )
    body = {
        "runId": "r_dddddddddddd", "sendId": "r_dddddddddddd", "input": {"q": "meaning"},
        "bundle": {"files": BUNDLE},
        "budgets": {"maxTurnSeconds": 120, "maxStepsPerTurn": 50, "maxTokensPerRun": 100000},
        "sessionToken": "sess_x", "traceUploadUrl": "https://invalid.test/put",
    }
    with TestClient(create_app(settings, control_plane=None)) as c:
        r = c.post("/internal/worker/runs", json=body, headers={"authorization": "Bearer tok"})
        assert r.status_code == 200, r.text
        items = [json.loads(line) for line in r.text.strip().splitlines()]
    events = [i["event"]["type"] for i in items if i["kind"] == "event"]
    out_file = cloud / "runs" / "r_dddddddddddd" / "output.json"
    return json.loads(out_file.read_text()), events


def test_dev_and_cloud_agree(tmp_path: Path) -> None:
    dev_out = _dev_output(tmp_path)
    cloud_out, cloud_events = _cloud_output(tmp_path)
    assert dev_out == cloud_out == {"answer": "42"}
    # The cloud journal saw a full turn: begin, the tool call, and an end.
    assert "TurnBegin" in cloud_events
    assert any(t in ("ToolCall", "ToolCallPart") for t in cloud_events)
```

*(Two adjustments are allowed if reality disagrees, both test-side: the spawn_argv shape for passing the scripted config through `sanad run --wire` (env `KIMI_SCRIPTED_ECHO_SCRIPTS` may need to ride `env` instead of a flag), and the exact event-envelope field names (`i["event"]["type"]` vs the `WireMessageEnvelope` key). The invariant that may NOT be weakened: same output document from both paths.)*

- [ ] **Step 2: Run it**

Run: `uv run pytest tests_e2e/test_worker_parity.py -vv`
Expected: PASS. This is the task — it's a test-only task; if it fails, the bug is in Tasks 7-12, fix there (each has its own suite to keep green).

- [ ] **Step 3: Full repo gates**

Run: `make check && uv run pytest tests tests_e2e terminal-server/tests -vv && pnpm -C control-plane/artifacts/sanad-web test`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add tests_e2e/test_worker_parity.py
git commit -m "sanad: worker parity e2e — dev and cloud runner agree on output and events"
```

---

### Task 14: Minimal pages + per-agent OpenAPI

**Files:**
- Create: `control-plane/artifacts/sanad-web/app/(dashboard)/agents/page.tsx`, `app/(dashboard)/agents/[name]/page.tsx` *(adjust the route-group segment to whatever the existing dashboard layout uses — find the segment that hosts the current workspace/terminal pages and put these beside them)*
- Create: `control-plane/artifacts/sanad-web/lib/agents/openapi.ts`
- Create: `control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/openapi.json/route.ts`
- Test: `control-plane/artifacts/sanad-web/tests/unit/agent-openapi.test.ts`

**Interfaces:**
- Consumes: Task 1 tables (server-component queries via `db`), Task 6 read APIs' query logic (reuse the store functions, not the HTTP routes), the `worker.yaml` interface stanza from the deployed version's bundle.
- Produces:
  - `buildAgentOpenApi(p: {agentName: string; interfaceSpec: {inputs: Record<string, string>; outputs: Record<string, string>}}): object` — an OpenAPI 3.1 document with one path `/api/v1/agents/{name}/invoke`, request properties from `inputs` (P0 type map: `number → {type: "number"}`, `boolean → {type: "boolean"}`, everything else `{type: "string"}`), response properties from `outputs`, `securitySchemes: {invokeToken: {type: "http", scheme: "bearer"}}`.
  - Route: parses the active prod (fallback dev) deployment's bundled `worker.yaml` (`yaml` package — add `yaml` to deps if absent) → `buildAgentOpenApi` → raw `NextResponse.json` (no envelope — it's an OpenAPI document).
  - Agents page: server component, org-scoped list (name, owner email, status, env badges, last run status/age). Agent page: header (owner, status, deployments) + last-20 runs table (id, status, cost `$(micros/1e6).toFixed(4)`, tokens, age) reading via the store. No client interactivity in P0 — pause/resume stay CLI verbs.

- [ ] **Step 1: Write the failing OpenAPI test**

```ts
// tests/unit/agent-openapi.test.ts
import { describe, it, expect } from "vitest";
import { buildAgentOpenApi } from "@/lib/agents/openapi";

describe("buildAgentOpenApi", () => {
  const doc: any = buildAgentOpenApi({
    agentName: "invoice-triage",
    interfaceSpec: { inputs: { q: "string", n: "number" }, outputs: { answer: "string" } },
  });
  it("declares the invoke path with typed request properties", () => {
    const body = doc.paths["/api/v1/agents/invoice-triage/invoke"].post
      .requestBody.content["application/json"].schema;
    expect(body.properties.q).toEqual({ type: "string" });
    expect(body.properties.n).toEqual({ type: "number" });
    expect(body.required).toEqual(["n", "q"]);
  });
  it("declares bearer auth", () => {
    expect(doc.components.securitySchemes.invokeToken).toEqual({
      type: "http", scheme: "bearer",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/agent-openapi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/agents/openapi.ts` + the route + the two pages.** Pages follow whatever server-component + Tailwind conventions the neighboring dashboard pages use — read one sibling page first and match it; the deliverable is the two tables described in Interfaces, not a design system.

- [ ] **Step 4: Tests + typecheck**

Run: `pnpm -C control-plane/artifacts/sanad-web test -- tests/unit/agent-openapi.test.ts && pnpm -C control-plane/artifacts/sanad-web exec tsc --noEmit`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add "control-plane/artifacts/sanad-web/app/(dashboard)/agents" control-plane/artifacts/sanad-web/lib/agents/openapi.ts "control-plane/artifacts/sanad-web/app/api/v1/agents/[name]/openapi.json" control-plane/artifacts/sanad-web/tests/unit/agent-openapi.test.ts
git commit -m "sanad: agent pages + per-agent openapi — org list, run history, typed invoke schema"
```

---

## P0 exit criteria (spec traceability)

| Spec P0 item | Task(s) |
|---|---|
| Schema: workspaces/agents/versions/deployments/runs | 1 |
| `itok` mint + verify, quota at mint | 2 |
| Owner-enforced deploy, orphaned block | 3 |
| Machine per (workspace, env), keep_warm flag | 4, 11 |
| Sync invoke, NDJSON stream, idempotency, 120s wake bound | 5 |
| Run rows, cost rollup, `lost` reaper, read APIs | 6 |
| Run assembly shared module + `ReturnOutput` contract | 7 |
| `sanad agent dev` (local parity, nudge-then-`no_output`) | 8 |
| `sanad agent deploy/runs/logs/pause/resume` | 9 |
| `RunRunner` one-turn subprocess, token budget | 10 |
| Worker mode fail-closed, bundle containment, keep-warm probe | 11 |
| S3 trace upload + completion report | 12 |
| DX-4 parity evidence | 13 |
| Minimal agent + workspace pages | 14 |
| Per-agent OpenAPI (RT-3) | 14 |

**Not in P0 (per spec, do not add):** async jobs, schedules, threads, `placement: dedicated`, HITL pauses, canary, model routing, A2A, cloud-side no_output nudge, staging env, retries/DLQ.

**Deferred to deploy-time (not in this plan):** `SANAD_RUNS_BUCKET` S3 bucket creation + `sanad-workspace-task` role PUT policy; `CRON_SECRET` + scheduler for `/api/internal/cron/reap-runs`; router allowance for `wm:` hashes is automatic (same `/compute/route` endpoint).
