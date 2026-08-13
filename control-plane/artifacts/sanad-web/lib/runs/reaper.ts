/**
 * Lost-run reaper: runs stuck in "running" whose backing workspace machine
 * has gone silent (or never registered a machine row for that
 * workspace+env at all) — almost always a Fargate task that died mid-turn
 * without ever calling POST .../runs/{id}/complete. Left alone, such a run
 * would sit in "running" forever, and Task 5's ?wait=1 poll
 * (pollRunSettled) would spin its full 10s budget on every retry with no
 * way to ever observe a terminal state. sweepLostRuns marks each one
 * `lost` (errorCode "machine_lost") so callers stop waiting.
 *
 * The ownership chain is runs -> deployments -> agents -> workspaceMachines
 * (four tables), resolved here as three narrow, independently-typed queries
 * joined in memory rather than one wide SQL join: (1) running runs, (2)
 * deployments+agents for those runs' deploymentIds (one leftJoin), (3)
 * workspaceMachines for the workspaceIds in play. Keeps every query small
 * and keeps the "no machine row at all" case (the other half of the
 * contract, beyond staleness) a plain absent-from-the-map lookup instead of
 * a NULL-across-an-outer-join special case.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agents, deployments, runs, workspaceMachines } from "../db/schema";

export const DEFAULT_STALE_MS = 300_000;

export async function sweepLostRuns(staleAfterMs: number): Promise<number> {
  const cutoffMs = Date.now() - staleAfterMs;

  const runningRows = await db
    .select({ id: runs.id, deploymentId: runs.deploymentId })
    .from(runs)
    .where(eq(runs.status, "running"));
  if (runningRows.length === 0) return 0;

  const deploymentIds = [...new Set(runningRows.map((r) => r.deploymentId))];
  const deploymentRows = await db
    .select({
      deploymentId: deployments.id,
      env: deployments.env,
      workspaceId: agents.workspaceId,
    })
    .from(deployments)
    .leftJoin(agents, eq(agents.id, deployments.agentId))
    .where(inArray(deployments.id, deploymentIds));
  const byDeploymentId = new Map(deploymentRows.map((d) => [d.deploymentId, d]));

  const workspaceIds = [
    ...new Set(
      deploymentRows
        .map((d) => d.workspaceId)
        .filter((id): id is string => !!id)
    ),
  ];
  const machineRows = workspaceIds.length
    ? await db
        .select({
          workspaceId: workspaceMachines.workspaceId,
          env: workspaceMachines.env,
          lastSeenAt: workspaceMachines.lastSeenAt,
        })
        .from(workspaceMachines)
        .where(inArray(workspaceMachines.workspaceId, workspaceIds))
    : [];
  const lastSeenByKey = new Map(
    machineRows.map((m) => [`${m.workspaceId}:${m.env}`, m.lastSeenAt])
  );

  let reaped = 0;
  for (const row of runningRows) {
    const dep = byDeploymentId.get(row.deploymentId);
    const lastSeenAt = dep ? lastSeenByKey.get(`${dep.workspaceId}:${dep.env}`) : undefined;
    // Stale (or no machine row at all — the `!lastSeenAt` branch covers both
    // "no matching workspaceMachines row" and "row exists but lastSeenAt is
    // still null", e.g. a machine that never finished provisioning).
    const isLost = !lastSeenAt || lastSeenAt.getTime() < cutoffMs;
    if (!isLost) continue;

    await db
      .update(runs)
      .set({ status: "lost", errorCode: "machine_lost", finishedAt: new Date() })
      .where(eq(runs.id, row.id));
    reaped++;
  }

  return reaped;
}
