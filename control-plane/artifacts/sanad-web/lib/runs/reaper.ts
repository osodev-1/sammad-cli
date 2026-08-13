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
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agents, deployments, runs, workspaceMachines } from "../db/schema";

export const DEFAULT_STALE_MS = 300_000;

export async function sweepLostRuns(staleAfterMs: number): Promise<number> {
  const cutoffMs = Date.now() - staleAfterMs;

  const runningRows = await db
    .select({ id: runs.id, deploymentId: runs.deploymentId, startedAt: runs.startedAt })
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

  const staleIds: string[] = [];
  for (const row of runningRows) {
    const dep = byDeploymentId.get(row.deploymentId);
    const lastSeenAt = dep ? lastSeenByKey.get(`${dep.workspaceId}:${dep.env}`) : undefined;
    // Stale (or no machine row at all — the `!lastSeenAt` branch covers both
    // "no matching workspaceMachines row" and "row exists but lastSeenAt is
    // still null", e.g. a machine that never finished provisioning).
    const machineStale = !lastSeenAt || lastSeenAt.getTime() < cutoffMs;
    // Belt-and-suspenders against a machine-staleness false positive (e.g.
    // lastSeenAt not yet refreshed on a machine that just picked up this
    // run): a run that only just started can never be reaped, regardless of
    // what the machine row says. A null startedAt (shouldn't happen for a
    // "running" row — markRunRunning always sets it) is treated the same
    // way: never reap on unproven age.
    const startedStale = row.startedAt !== null && row.startedAt.getTime() < cutoffMs;
    const isLost = machineStale && startedStale;
    if (isLost) staleIds.push(row.id);
  }
  if (staleIds.length === 0) return 0;

  // The runningRows snapshot above can go stale before this UPDATE runs — a
  // run in the candidate set may have genuinely completed via POST
  // .../runs/{id}/complete in the interim. Re-checking status = "running"
  // in the WHERE (same guard completeRun uses) makes this a no-op for any
  // row that already left "running", instead of clobbering its real
  // status/output/tokens/cost with "lost". One batched statement rather
  // than a per-row loop, and RETURNING reports exactly which rows this
  // UPDATE actually flipped — the count is `returned.length`, not
  // `staleIds.length`, so a caller never learns "reaped N" for a run that
  // this call didn't actually touch.
  const returned = await db
    .update(runs)
    .set({ status: "lost", errorCode: "machine_lost", finishedAt: new Date() })
    .where(and(inArray(runs.id, staleIds), eq(runs.status, "running")))
    .returning({ id: runs.id });

  return returned.length;
}
