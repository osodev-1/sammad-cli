import { createHash } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agents, agentVersions, deployments, users, workspaces } from "../db/schema";

export class OwnerRequiredError extends Error {
  readonly code = "owner_required";
  constructor() {
    super("agent has no active owner");
  }
}

/**
 * Thrown when a deployment's versionId doesn't belong to the agent it's
 * being deployed to. Maps to 404, not 403 — same information-hiding rule as
 * a cross-org agent name: a caller holding some other agent's version id
 * must not learn anything about whether that id exists at all.
 */
export class VersionMismatchError extends Error {
  readonly code = "version_not_found";
  constructor() {
    super("version does not belong to this agent");
  }
}

/** sha256 of the bundle's file map, independent of key insertion order. */
export function bundleContentHash(files: Record<string, string>): string {
  const canonical = JSON.stringify(files, Object.keys(files).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Get-or-create a workspace by (orgId, name). Select-then-insert: sanad-web
 * runs a single replica, so there is no concurrent-create race to close —
 * same documented assumption as ensureInFlight in lib/compute/sessions.ts:286-291.
 * There is no DB-level unique constraint on (org_id, name) to fall back on.
 */
export async function ensureWorkspace(
  orgId: string,
  name: string
): Promise<{ id: string }> {
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.orgId, orgId), eq(workspaces.name, name)))
    .limit(1);
  if (existing[0]) return { id: existing[0].id };

  const id = `ws_${crypto.randomUUID()}`;
  await db.insert(workspaces).values({ id, orgId, name });
  return { id };
}

/**
 * Create an agent, or return the existing one by (workspace, name).
 *
 * Ownership is stable on upsert: re-pushing an existing agent name never
 * changes who owns it — that transfer is explicitly out of P0 scope, so
 * there is no "claim ownership" side effect here. `ownerUserId` only takes
 * effect when the agent doesn't exist yet ("owner = caller" applies to
 * creation, not to every push). The existing-row path only refreshes
 * `description`, and only when the caller supplied one. Per-workspace name
 * uniqueness is enforced with the same select-then-insert assumption as
 * ensureWorkspace above.
 */
export async function upsertAgent(p: {
  orgId: string;
  workspaceName: string;
  name: string;
  ownerUserId: string;
  description?: string;
}): Promise<{ id: string }> {
  const workspace = await ensureWorkspace(p.orgId, p.workspaceName);

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspace.id), eq(agents.name, p.name)))
    .limit(1);

  if (existing[0]) {
    if (p.description !== undefined) {
      await db
        .update(agents)
        .set({ description: p.description })
        .where(eq(agents.id, existing[0].id));
    }
    return { id: existing[0].id };
  }

  const id = `ag_${crypto.randomUUID()}`;
  await db.insert(agents).values({
    id,
    workspaceId: workspace.id,
    name: p.name,
    ownerUserId: p.ownerUserId,
    description: p.description ?? null,
  });
  return { id };
}

export async function createVersion(p: {
  agentId: string;
  files: Record<string, string>;
  createdBy: string;
}): Promise<{ id: string; contentHash: string }> {
  const contentHash = bundleContentHash(p.files);
  const id = `av_${crypto.randomUUID()}`;
  await db.insert(agentVersions).values({
    id,
    agentId: p.agentId,
    contentHash,
    bundle: { files: p.files },
    createdBy: p.createdBy,
  });
  return { id, contentHash };
}

export async function createDeployment(p: {
  agentId: string;
  versionId: string;
  env: "dev" | "prod";
}): Promise<{ id: string }> {
  const rows = await db.select().from(agents).where(eq(agents.id, p.agentId)).limit(1);
  const agent = rows[0];
  if (!agent) throw new Error("agent not found");
  if (agent.status === "orphaned") throw new OwnerRequiredError();

  // The versionId is client-supplied — without this check a caller holding
  // any agent-version id could splice another agent's bundle into this
  // agent's deployment history.
  const versionRows = await db
    .select({ id: agentVersions.id, agentId: agentVersions.agentId })
    .from(agentVersions)
    .where(eq(agentVersions.id, p.versionId))
    .limit(1);
  const version = versionRows[0];
  if (!version || version.agentId !== p.agentId) {
    throw new VersionMismatchError();
  }

  // At most one non-superseded deployment may exist per (agentId, env): retire
  // whatever was active/paused before wiring in the new one. A blind
  // conditional update is race-free enough here — single-replica control
  // plane, same documented assumption as ensureInFlight in
  // lib/compute/sessions.ts:286-291.
  await db
    .update(deployments)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(deployments.agentId, p.agentId),
        eq(deployments.env, p.env),
        inArray(deployments.status, ["active", "paused"])
      )
    );

  const id = `dp_${crypto.randomUUID()}`;
  await db.insert(deployments).values({
    id,
    agentId: p.agentId,
    agentVersionId: p.versionId,
    env: p.env,
    status: "active",
  });
  return { id };
}

/**
 * Pause/resume the live deployment for an agent+env. Returns whether a
 * target row existed — callers must not report success on a no-op update.
 *
 * drizzle's update() result shape for row-matched-count is driver-dependent
 * (and awkward to assert on through the mocked db in tests), so this uses an
 * explicit select-then-update instead of trusting an update result's row
 * count. Same single-replica assumption as ensureInFlight in
 * lib/compute/sessions.ts:286-291 — the window between the select and the
 * update is not a concern here.
 */
export async function setDeploymentStatus(
  agentId: string,
  env: string,
  status: "active" | "paused"
): Promise<boolean> {
  // Never resurrect a superseded row via pause/resume — only touch whatever
  // is currently the live (active or paused) deployment for this env.
  const rows = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.agentId, agentId),
        eq(deployments.env, env),
        inArray(deployments.status, ["active", "paused"])
      )
    )
    .limit(1);
  const target = rows[0];
  if (!target) return false;

  await db
    .update(deployments)
    .set({ status, updatedAt: new Date() })
    .where(eq(deployments.id, target.id));
  return true;
}

/** Resolve an agent by name, scoped to the org — never crosses org boundaries. */
export async function getAgentByName(orgId: string, name: string) {
  const rows = await db
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      status: agents.status,
      description: agents.description,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .where(and(eq(workspaces.orgId, orgId), eq(agents.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The live deployment for an agent+env, or null. Filters to status "active"
 * only — createDeployment guarantees at most one such row per (agentId, env)
 * exists at a time, so the createdAt ordering here is a defensive tiebreak,
 * not the primary selection mechanism.
 */
export async function getActiveDeployment(agentId: string, env: string) {
  const rows = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.agentId, agentId),
        eq(deployments.env, env),
        eq(deployments.status, "active")
      )
    )
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The live (non-superseded) deployment for an agent+env — active OR paused.
 * Unlike getActiveDeployment (status:"active" only, by design — see its
 * docstring), the invoke route needs to tell "never deployed" (404
 * not_deployed) apart from "deployed but paused" (409 paused), which
 * requires seeing the paused row too. Same supersede invariant as
 * setDeploymentStatus's lookup: at most one active/paused row per
 * (agentId, env).
 */
export async function getLiveDeployment(agentId: string, env: string) {
  const rows = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.agentId, agentId),
        eq(deployments.env, env),
        inArray(deployments.status, ["active", "paused"])
      )
    )
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The bundle (file map) for a specific agent version, by id. */
export async function getVersionBundle(
  versionId: string
): Promise<{ files: Record<string, string> } | null> {
  const rows = await db
    .select({ bundle: agentVersions.bundle })
    .from(agentVersions)
    .where(eq(agentVersions.id, versionId))
    .limit(1);
  const row = rows[0];
  return (row?.bundle as { files: Record<string, string> } | undefined) ?? null;
}

/** Fetch a workspace row by id — used to read keepWarm before waking its machine. */
export async function getWorkspaceById(id: string) {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch an agent row by id. Unlike getAgentByName, not org-scoped — used by
 * the run-completion route's machine-auth path, which resolves
 * run.deploymentId -> deployment.agentId -> agent.workspaceId to recompute
 * the expected agentd token; the caller there is a machine bearer token,
 * not a session, so there is no orgId to scope by yet.
 */
export async function getAgentById(id: string) {
  const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Fetch a deployment row by id — same machine-auth path as getAgentById above. */
export async function getDeploymentById(id: string) {
  const rows = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return rows[0] ?? null;
}

/** List every agent in the org, across all its workspaces. */
export async function listAgentsForOrg(orgId: string) {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      workspaceId: agents.workspaceId,
      workspaceName: workspaces.name,
      ownerUserId: agents.ownerUserId,
      status: agents.status,
      description: agents.description,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .where(eq(workspaces.orgId, orgId));
}

/**
 * Org-scoped agent list with the owner's email — the agents dashboard page
 * (Task 14) shows a human-readable owner, unlike /api/v1/agents's JSON
 * response (listAgentsForOrg), whose callers already hold ownerUserId and
 * can resolve it themselves. Joins users the same way getSessionMembership
 * and the team page do.
 */
export async function listAgentsForOrgWithOwnerEmail(orgId: string) {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      workspaceId: agents.workspaceId,
      workspaceName: workspaces.name,
      ownerUserId: agents.ownerUserId,
      ownerEmail: users.email,
      status: agents.status,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(eq(workspaces.orgId, orgId))
    .orderBy(desc(agents.createdAt));
}

/**
 * Single-agent detail (the agent page, Task 14): the same org-scoped lookup
 * as getAgentByName, plus the owner's email in the same query rather than a
 * second round trip keyed on ownerUserId.
 */
export async function getAgentDetailByName(orgId: string, name: string) {
  const rows = await db
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      ownerEmail: users.email,
      status: agents.status,
      description: agents.description,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(and(eq(workspaces.orgId, orgId), eq(agents.name, name)))
    .limit(1);
  return rows[0] ?? null;
}
