/**
 * Workspace machines: the Fargate task backing a (workspace, env) pair that
 * runs deployed agents (PRD worker runtime). Same wake state machine as
 * lib/compute/sessions.ts's per-user-session machines — an EFS access point,
 * a task started on demand and self-stopped when idle — keyed per
 * (workspaceId, env) instead of per (userId, sessionId).
 *
 * The AWS-touching steps (ensureAccessPoint, registerTaskDefinition,
 * runWorkspaceTask, waitForRunning, waitForAgentd) are the exact functions
 * the session path uses — the first three are already exported from ./aws;
 * waitForRunning/waitForAgentd were private to sessions.ts and are now
 * exported from there for this reuse.
 */
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { workspaceMachines } from "../db/schema";
import {
  awsComputeConfig,
  ensureAccessPoint,
  registerTaskDefinition,
  runWorkspaceTask,
  stopTask,
  type AwsComputeConfig,
} from "./aws";
import { computeBaseUrl, waitForAgentd, waitForRunning } from "./sessions";
import { deriveMachineToken } from "./tokens";

export type MachineRow = typeof workspaceMachines.$inferSelect;

export interface MachineTarget {
  machineId: string;
  hash12: string;
  baseUrl: string;
  agentdToken: string;
  coldStart: boolean;
}

/**
 * Router-namespace hash for a workspace machine. The "wm:" prefix keeps
 * worker hashes from ever colliding with user-session hashes (sessionHash
 * has no such prefix) in the shared hash12 routing space.
 */
export function machineHash(workspaceId: string, env: string): string {
  return createHash("sha256")
    .update(`wm:${workspaceId}:${env}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Base container env for a workspace machine. Deliberately NOT reused from
 * sessions.ts's agentBaseEnv: that helper is shaped for the interactive CLI
 * workspace (WORKSPACE_MODE: "task", SANAD_WORKSPACE_USER) and isn't a fit
 * for a non-interactive worker machine identified by (workspaceId, env).
 * Not part of the Task 4 interface contract — the worker container's actual
 * expected env var names should be confirmed against the runtime that reads
 * them (flagged in the task report as a divergence).
 */
function machineBaseEnv(
  config: AwsComputeConfig,
  workspaceId: string,
  env: string,
): Record<string, string> {
  return {
    WORKSPACE_MODE: "worker",
    SANAD_WORKSPACE_ID: workspaceId,
    SANAD_WORKSPACE_ENV: env,
    CONTROL_PLANE_URL: config.controlPlaneUrl,
    SANAD_API_BASE_URL: config.controlPlaneUrl,
    TERMINAL_ALLOWED_ORIGINS: config.allowedOrigins,
  };
}

/**
 * Warm-attach reachability check, budgeted short (5s) unlike the cold path's
 * full waitForAgentd wait (60s): races the same exported waitForAgentd
 * against a timeout rather than duplicating its fetch/poll logic. If the
 * timeout wins, the losing waitForAgentd call is abandoned (not cancelled)
 * and its eventual rejection is swallowed here — a bounded, harmless number
 * of background polls, never surfaced.
 */
function warmProbe(baseUrl: string, budgetMs = 5_000): Promise<boolean> {
  return Promise.race([
    waitForAgentd(baseUrl).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), budgetMs)),
  ]);
}

async function getMachineRow(hash12: string): Promise<MachineRow | null> {
  const [row] = await db
    .select()
    .from(workspaceMachines)
    .where(eq(workspaceMachines.hash12, hash12))
    .limit(1);
  return row ?? null;
}

/*
 * Concurrent wakes for one (workspace, env) — e.g. two invoke calls landing
 * at once — must produce ONE machine, not a RunTask stampede. Mirrors
 * sessions.ts's in-process dedupe map; sound for the same reason (sanad-web
 * runs a single replica).
 */
const ensureInFlight = new Map<string, Promise<MachineTarget>>();

export function ensureWorkspaceMachine(
  workspaceId: string,
  env: string,
  opts: { keepWarm: boolean },
): Promise<MachineTarget> {
  const key = `${workspaceId}:${env}`;
  const existing = ensureInFlight.get(key);
  if (existing) return existing;
  const run = ensureInner(workspaceId, env, opts).finally(() => {
    ensureInFlight.delete(key);
  });
  ensureInFlight.set(key, run);
  return run;
}

async function ensureInner(
  workspaceId: string,
  env: string,
  opts: { keepWarm: boolean },
): Promise<MachineTarget> {
  const config = awsComputeConfig();
  const hash12 = machineHash(workspaceId, env);
  const baseUrl = computeBaseUrl(hash12);

  // Idempotent — returns the existing access point for this hash12 path.
  const accessPointId = await ensureAccessPoint(config, hash12);

  let row = await getMachineRow(hash12);
  if (!row) {
    const id = `wm_${crypto.randomUUID()}`;
    const [inserted] = await db
      .insert(workspaceMachines)
      .values({
        id,
        workspaceId,
        env,
        hash12,
        efsAccessPointId: accessPointId,
        imageRef: config.workspaceImage,
        state: "provisioning",
        keepWarm: opts.keepWarm,
      })
      .returning();
    row = inserted;
  }

  // A recorded task may still be running (warm attach) …
  if (row.taskArn && row.taskIp && row.runNonce) {
    const warm = await warmProbe(baseUrl);
    if (warm) {
      const stale = row.imageRef !== config.workspaceImage;
      if (!stale) {
        if (row.keepWarm !== opts.keepWarm) {
          await db
            .update(workspaceMachines)
            .set({ keepWarm: opts.keepWarm, updatedAt: new Date() })
            .where(eq(workspaceMachines.id, row.id));
        }
        return {
          machineId: row.id,
          hash12: row.hash12,
          baseUrl,
          agentdToken: deriveMachineToken(workspaceId, row.runNonce),
          coldStart: false,
        };
      }
      console.log(
        `machine ${row.id} is warm on a stale image — recycling`,
      );
    }
    // Unreachable, or warm-but-stale: replace it.
    await stopTask(config, row.taskArn).catch(() => {});
  }

  // … otherwise (never ran / self-stopped / died / just recycled): fresh
  // run, fresh nonce.
  const runNonce = crypto.randomUUID();
  const agentdToken = deriveMachineToken(workspaceId, runNonce);
  const taskDefArn = await registerTaskDefinition(
    config,
    hash12,
    accessPointId,
    machineBaseEnv(config, workspaceId, env),
  );
  const taskArn = await runWorkspaceTask(config, taskDefArn, {
    AGENTD_TOKEN: agentdToken,
    MACHINE_NONCE: runNonce,
    WORKER_ENABLED: "1",
    KEEP_WARM: opts.keepWarm ? "1" : "0",
  });

  try {
    const privateIp = await waitForRunning(config, taskArn);
    // Publish the route BEFORE health-polling: the poll goes through the router.
    await db
      .update(workspaceMachines)
      .set({
        taskArn,
        taskIp: privateIp,
        runNonce,
        imageRef: config.workspaceImage,
        state: "ready",
        keepWarm: opts.keepWarm,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workspaceMachines.id, row.id));
    await waitForAgentd(baseUrl);
  } catch (e) {
    await db
      .update(workspaceMachines)
      .set({ state: "error", updatedAt: new Date() })
      .where(eq(workspaceMachines.id, row.id));
    throw e;
  }

  return {
    machineId: row.id,
    hash12,
    baseUrl,
    agentdToken,
    coldStart: true,
  };
}

/** Router route lookup: hash12 → task IP, for workspace machines. */
export async function machineIpByHash(hash12: string): Promise<string | null> {
  const [row] = await db
    .select({ taskIp: workspaceMachines.taskIp })
    .from(workspaceMachines)
    .where(eq(workspaceMachines.hash12, hash12))
    .limit(1);
  return row?.taskIp ?? null;
}
