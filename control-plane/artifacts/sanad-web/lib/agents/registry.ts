import { createHash } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { agents, agentVersions, deployments, workspaces } from "../db/schema";

export class OwnerRequiredError extends Error {
  readonly code = "owner_required";
  constructor() {
    super("agent has no active owner");
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
 * Create an agent, or re-claim an existing one by (workspace, name).
 *
 * P0 has no separate "claim ownership" endpoint, so pushing to an existing
 * agent name transfers ownership to the caller and un-orphans it (mirrors a
 * `git push`-style deploy CLI: whoever pushes last owns it). Per-workspace
 * name uniqueness is enforced here with the same select-then-insert
 * assumption as ensureWorkspace above.
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
    await db
      .update(agents)
      .set({
        ownerUserId: p.ownerUserId,
        status: "active",
        ...(p.description !== undefined ? { description: p.description } : {}),
      })
      .where(eq(agents.id, existing[0].id));
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

  const id = `dp_${crypto.randomUUID()}`;
  await db.insert(deployments).values({
    id,
    agentId: p.agentId,
    agentVersionId: p.versionId,
    env: p.env,
  });
  return { id };
}

export async function setDeploymentStatus(
  agentId: string,
  env: string,
  status: "active" | "paused"
): Promise<void> {
  await db
    .update(deployments)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(deployments.agentId, agentId), eq(deployments.env, env)));
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

/** Most recently created active deployment for an agent+env, or null. */
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
